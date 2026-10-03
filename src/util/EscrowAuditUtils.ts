///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { ObjectDecorators } from "@rapidrest/core";
import { RepoUtils } from "@rapidrest/service-core";
import { EscrowAuditAction, EscrowAuditHashAlgorithm, EscrowAuditHead, EscrowAuditLogEntry } from "../models/types.js";
import { asEntity } from "./EntityUtils.js";

const { Config, Logger } = ObjectDecorators;

/**
 * The config key holding the HMAC-SHA256 key new escrow audit entries (and the chain's head record) are keyed
 * with. MUST be identical on every replica sharing a datastore - a replica with a different (or missing) key
 * would write entries every other replica fails to verify. Rotating it invalidates verification of every
 * entry already written under the old key (there is no key-id/multi-key support), so treat it as long-lived.
 */
export const ESCROW_AUDIT_HMAC_KEY_CONFIG = "mail:escrow:audit_hmac_key";

/** The `chainId` of the single, global escrow audit chain's head record. */
export const ESCROW_AUDIT_HEAD_CHAIN_ID = "global";

/** How many times `EscrowAuditUtils.record()` retries a `sequence` collision before giving up - see its own
 * doc comment for why this is a retry loop rather than a transaction. */
const MAX_APPEND_ATTEMPTS = 5;

/** How many times `advanceHead()` retries an optimistic-lock conflict (or create race) on the head record. */
const MAX_HEAD_ATTEMPTS = 5;

/** How many entries `EscrowAuditUtils.verifyChain()` fetches per page - same pattern/size as
 * `MailboxQuotaRecalcJob.findAllPages()`. */
const VERIFY_PAGE_SIZE = 500;

export interface RecordEscrowAuditEntryParams {
    action: EscrowAuditAction;
    holderUserUid: string;
    matterId: string;
    mailboxUid: string;
    requestId: string;
    details?: Record<string, any>;
}

/** What `appendEntry()`/`verifyChain()` work with: the repositories (the head one only when head maintenance is on, and
 * fetched lazily - a failure building it is retried and logged by `advanceHead()`, never thrown from an append), how a
 * model row is instantiated, and the resolved key and logger. Built by `EscrowAuditUtils`. */
interface ChainContext {
    entryRepo: RepoUtils<EscrowAuditLogEntry>;
    getHeadRepo?: () => Promise<RepoUtils<EscrowAuditHead>>;
    makeEntry: (data: Record<string, any>) => any;
    makeHead: (data: Record<string, any>) => any;
    hmacKey: string;
    logger: any;
}

/** The warning logged when `mail:escrow:audit_hmac_key` is unset. */
function missingKeyMessage(): string {
    return (
        `EscrowAuditUtils: ${ESCROW_AUDIT_HMAC_KEY_CONFIG} is not set - escrow audit entries are hash-chained with ` +
        "unkeyed SHA-256, which anyone with database write access can rewrite undetectably. Set it (identically on " +
        "every replica) to enable HMAC-SHA256."
    );
}

/** Computes the digest covering one entry's own content plus the previous entry's hash - the link in the
 * chain. Every field is written into the object literal in this exact, fixed order every time (never derived
 * from `Object.keys()` on caller-supplied data), so `JSON.stringify` is deterministic here - the same
 * reasoning `util/KeyDiscoveryClient.ts`'s own hashing relies on for its z-base32 discovery hash. The payload
 * is identical for both schemes (so legacy entries still verify); only the digest differs. */
function computeEscrowAuditHash(
    input: { sequence: number; previousHash?: string | null; occurredAt: Date } & RecordEscrowAuditEntryParams,
    algorithm: EscrowAuditHashAlgorithm | undefined,
    hmacKey: string,
): string {
    const payload: string = JSON.stringify({
        sequence: input.sequence,
        previousHash: input.previousHash ?? "",
        action: input.action,
        holderUserUid: input.holderUserUid,
        matterId: input.matterId,
        mailboxUid: input.mailboxUid,
        requestId: input.requestId,
        occurredAt: input.occurredAt.toISOString(),
        details: input.details ?? {},
    });
    if (algorithm === EscrowAuditHashAlgorithm.HMAC_SHA256) {
        return crypto.createHmac("sha256", hmacKey).update(payload).digest("hex");
    }
    return crypto.createHash("sha256").update(payload).digest("hex");
}

function computeHeadMac(chainId: string, sequence: number, hash: string, hmacKey: string): string {
    return crypto.createHmac("sha256", hmacKey).update(JSON.stringify({ chainId, sequence, hash })).digest("hex");
}

function safeEqual(a: string | undefined | null, b: string): boolean {
    if (typeof a !== "string" || a.length !== b.length) {
        return false;
    }
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

async function latestEntry(repo: RepoUtils<EscrowAuditLogEntry>): Promise<EscrowAuditLogEntry | undefined> {
    const [latest] = await repo.find({ sort: "-sequence", limit: 1 } as any, { ignoreACL: true, limit: 1 });
    return latest;
}

async function findHead(repo: RepoUtils<EscrowAuditHead>): Promise<EscrowAuditHead | undefined> {
    const [head] = await repo.find({ chainId: ESCROW_AUDIT_HEAD_CHAIN_ID, limit: 1 } as any, {
        ignoreACL: true,
        limit: 1,
        skipCache: true,
    });
    return head;
}

/**
 * Moves the head record forward to `entry` (creating it on the first append after upgrade). Uses
 * `RepoUtils.update()`'s optimistic lock (`version`): a conflicting concurrent writer (409, or a unique-index
 * collision on `chainId` for two racing creates) makes this re-read the head and retry, and a head already at
 * or past `entry.sequence` (a later concurrent append won) is left alone - the head only ever moves forward.
 *
 * Not transactional with the entry insert (see `EscrowAuditUtils.record()` for why there's no transaction): if
 * this fails after the entry was inserted, the head lags behind. That is logged at `error` level but NOT
 * propagated - the tamper-evident entry itself was persisted, `EscrowAuditUtils.verifyChain()` tolerates a lagging
 * head (entries past it still have to verify), and the next successful append heals it.
 */
async function advanceHead(ctx: ChainContext, entry: EscrowAuditLogEntry): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_HEAD_ATTEMPTS; attempt++) {
        try {
            const headRepo: RepoUtils<EscrowAuditHead> = await ctx.getHeadRepo!();
            const head: EscrowAuditHead | undefined = await findHead(headRepo);
            if (head && head.sequence >= entry.sequence) {
                return;
            }
            const fields: Partial<EscrowAuditHead> = {
                chainId: ESCROW_AUDIT_HEAD_CHAIN_ID,
                sequence: entry.sequence,
                hash: entry.hash,
                // `null` rather than `undefined` so an update actually clears a MAC left over from a keyed era.
                hashAlgorithm: ctx.hmacKey ? EscrowAuditHashAlgorithm.HMAC_SHA256 : (null as any),
                mac: ctx.hmacKey ? computeHeadMac(ESCROW_AUDIT_HEAD_CHAIN_ID, entry.sequence, entry.hash, ctx.hmacKey) : (null as any),
            };
            if (!head) {
                await headRepo.create(ctx.makeHead(fields), { ignoreACL: true });
            } else {
                // `asEntity()`: on Mongo `find()` returns a plain document, and `RepoUtils.update()` only
                // enforces its optimistic `version` lock when `existing` is a real entity instance - without it
                // two concurrent appenders could both overwrite the head (a lost update that can leave the head
                // behind a later append, or pointing at the wrong entry), instead of the loser getting a
                // conflict and re-reading here.
                await headRepo.update(ctx.makeHead({ ...head, ...fields }), asEntity(headRepo, head), { ignoreACL: true });
            }
            return;
        } catch (err) {
            lastError = err;
        }
    }
    ctx.logger?.error?.(
        `EscrowAuditUtils: escrow audit entry ${entry.sequence} was recorded but the chain head could not be advanced; ` +
            `verification tolerates the lag until the next successful append: ${(lastError as any)?.message ?? String(lastError)}`,
    );
}

/** The body of `EscrowAuditUtils.record()` - see its doc comment. */
async function appendEntry(ctx: ChainContext, params: RecordEscrowAuditEntryParams): Promise<EscrowAuditLogEntry> {
    const repo: RepoUtils<EscrowAuditLogEntry> = ctx.entryRepo;
    const hashAlgorithm: EscrowAuditHashAlgorithm = ctx.hmacKey ? EscrowAuditHashAlgorithm.HMAC_SHA256 : EscrowAuditHashAlgorithm.SHA256;

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
        const latest: EscrowAuditLogEntry | undefined = await latestEntry(repo);
        const sequence: number = latest ? latest.sequence + 1 : 0;
        const previousHash: string | undefined = latest?.hash;
        const occurredAt: Date = new Date();
        const hash: string = computeEscrowAuditHash({ ...params, sequence, previousHash, occurredAt }, hashAlgorithm, ctx.hmacKey);

        let entry: EscrowAuditLogEntry;
        try {
            entry = await repo.create(
                ctx.makeEntry({ ...params, sequence, previousHash, hash, hashAlgorithm, occurredAt }),
                { ignoreACL: true },
            );
        } catch (err) {
            lastError = err;
            continue;
        }
        if (ctx.getHeadRepo) {
            await advanceHead(ctx, entry);
        }
        return entry;
    }
    throw lastError;
}

/** Why `EscrowAuditUtils.verifyChain()` reported the chain invalid. */
export type EscrowAuditVerificationFailure =
    /** An entry's `previousHash` doesn't match the preceding entry's `hash` (a deleted, inserted, or reordered entry). */
    | "link_mismatch"
    /** An entry's `hash` doesn't match a recomputation from its own stored fields (an edited entry). */
    | "hash_mismatch"
    /** An entry carries a `hashAlgorithm` this version doesn't recognize. */
    | "unknown_algorithm"
    /** An unkeyed entry follows an HMAC entry - the scheme only ever moves forward, never back. */
    | "algorithm_downgrade"
    /** An HMAC entry or head MAC exists but `mail:escrow:audit_hmac_key` isn't configured, so it can't be checked. */
    | "hmac_key_unavailable"
    /** The head record points past the last entry actually present - entries were deleted from the tail. */
    | "truncated"
    /** The entry at the head's `sequence` doesn't carry the head's `hash`. */
    | "head_mismatch"
    /** The head record's MAC doesn't verify (forged/edited head), or was stripped where one is required. */
    | "head_mac_mismatch"
    /** No head record exists, but the chain contains entries written after head tracking was introduced. */
    | "head_missing";

export interface EscrowAuditVerificationResult {
    valid: boolean;
    brokenAtSequence?: number;
    reason?: EscrowAuditVerificationFailure;
}

/** The body of `EscrowAuditUtils.verifyChain()` - see its doc comment. */
async function verifyChain(ctx: ChainContext): Promise<EscrowAuditVerificationResult> {
    const repo: RepoUtils<EscrowAuditLogEntry> = ctx.entryRepo;
    const head: EscrowAuditHead | undefined = ctx.getHeadRepo ? await findHead(await ctx.getHeadRepo()) : undefined;

    let expectedPreviousHash: string | undefined;
    let sawHmac = false;
    let sawExplicitAlgorithm = false;
    let last: EscrowAuditLogEntry | undefined;
    let headEntry: EscrowAuditLogEntry | undefined;
    for (let page = 0; ; page++) {
        const batch: EscrowAuditLogEntry[] = await repo.find(
            { sort: "sequence", limit: VERIFY_PAGE_SIZE, page } as any,
            { ignoreACL: true, limit: VERIFY_PAGE_SIZE, page },
        );
        for (const entry of batch) {
            const broken = (reason: EscrowAuditVerificationFailure): EscrowAuditVerificationResult => ({
                valid: false,
                brokenAtSequence: entry.sequence,
                reason,
            });
            if ((entry.previousHash ?? undefined) !== expectedPreviousHash) {
                return broken("link_mismatch");
            }
            const algorithm: EscrowAuditHashAlgorithm | undefined = entry.hashAlgorithm ?? undefined;
            if (algorithm === EscrowAuditHashAlgorithm.HMAC_SHA256) {
                if (!ctx.hmacKey) {
                    return broken("hmac_key_unavailable");
                }
                sawHmac = true;
            } else if (algorithm !== undefined && algorithm !== EscrowAuditHashAlgorithm.SHA256) {
                return broken("unknown_algorithm");
            } else if (sawHmac) {
                return broken("algorithm_downgrade");
            }
            sawExplicitAlgorithm = sawExplicitAlgorithm || algorithm !== undefined;
            if (!safeEqual(entry.hash, computeEscrowAuditHash({ ...entry, occurredAt: new Date(entry.occurredAt) }, algorithm, ctx.hmacKey))) {
                return broken("hash_mismatch");
            }
            if (head && entry.sequence === head.sequence) {
                headEntry = entry;
            }
            expectedPreviousHash = entry.hash;
            last = entry;
        }
        if (batch.length < VERIFY_PAGE_SIZE) {
            break;
        }
    }

    if (!ctx.getHeadRepo) {
        return { valid: true };
    }
    if (!head) {
        // Residual: a chain with no entries AND no head (both deleted wholesale) is indistinguishable from a
        // fresh deployment that has never appended - there is nothing left in the datastore to compare
        // against. Only an external anchor (see this function's doc comment) can detect that.
        return sawExplicitAlgorithm ? { valid: false, brokenAtSequence: last?.sequence, reason: "head_missing" } : { valid: true };
    }
    if (ctx.hmacKey && !head.mac) {
        // With a key configured every head write carries a MAC (`advanceHead()`), so a MAC-less head is either
        // stripped/forged (e.g. rolled back onto a legacy SHA-256 entry after deleting every HMAC entry, which
        // the per-entry checks alone can't see) or was last written before the key was enabled. The latter
        // heals on the next append after enabling the key; until then verification fails closed.
        return { valid: false, brokenAtSequence: head.sequence, reason: "head_mac_mismatch" };
    }
    if (head.mac || head.hashAlgorithm) {
        if (!ctx.hmacKey) {
            return { valid: false, brokenAtSequence: head.sequence, reason: "hmac_key_unavailable" };
        }
        if (!safeEqual(head.mac, computeHeadMac(head.chainId, head.sequence, head.hash, ctx.hmacKey))) {
            return { valid: false, brokenAtSequence: head.sequence, reason: "head_mac_mismatch" };
        }
    }
    if (!last || head.sequence > last.sequence) {
        return { valid: false, brokenAtSequence: last ? last.sequence + 1 : 0, reason: "truncated" };
    }
    if (!headEntry || headEntry.hash !== head.hash) {
        return { valid: false, brokenAtSequence: head.sequence, reason: "head_mismatch" };
    }
    return { valid: true };
}

/**
 * Records and verifies the hash-chained escrow-access audit log, built once by the consuming route/job's
 * `@Init` hook through the `ObjectFactory` with the (already built) repositories -
 * `await objectFactory.newInstance(EscrowAuditUtils, { name: EscrowAuditLogEntryClass.name, args: [entryRepo, headRepo] })`.
 * The HMAC key (`mail:escrow:audit_hmac_key`) and the logger are injected; the missing-key warning is logged once per
 * instance. `headRepo` may be `null`/omitted to disable head maintenance and tail-truncation checking.
 *
 * The HMAC key defaults to `""` so a deployment that never sets `mail:escrow:audit_hmac_key` (escrow is optional) still builds the
 * service and falls back, with a one-time warning, to unkeyed SHA-256.
 */
export class EscrowAuditUtils {
    @Config(ESCROW_AUDIT_HMAC_KEY_CONFIG, "")
    protected hmacKey: string | number = "";

    /** The deployment environment, read from `NODE_ENV` (config first, then the process environment); `production`
     * logs the missing-key warning at `error` level. */
    @Config("NODE_ENV", process.env.NODE_ENV)
    protected environment?: string;

    @Logger
    protected logger: any;

    /** Whether the missing-key warning was already logged by this instance. */
    protected warnedMissingKey: boolean = false;

    constructor(
        protected readonly entryRepo: RepoUtils<EscrowAuditLogEntry>,
        protected readonly headRepo?: RepoUtils<EscrowAuditHead> | null,
    ) {}

    /** `hmacKey` as a string: nconf's `parseValues` turns an all-digit env value into a number, which is accepted rather than
     * silently falling back to the unkeyed scheme. `""` when unset. */
    protected get resolvedKey(): string {
        return typeof this.hmacKey === "string" || typeof this.hmacKey === "number" ? String(this.hmacKey) : "";
    }

    /** Logs (once per instance) that `mail:escrow:audit_hmac_key` is unset - see `warnIfKeyMissing()`. Never throws. */
    protected warnIfKeyMissing(): void {
        if (this.resolvedKey || this.warnedMissingKey) {
            return;
        }
        this.warnedMissingKey = true;
        const message = missingKeyMessage();
        if (this.environment === "production") {
            this.logger?.error?.(message);
        } else {
            this.logger?.warn?.(message);
        }
    }

    protected chainContext(): ChainContext {
        const headRepo: RepoUtils<EscrowAuditHead> | undefined = this.headRepo ?? undefined;
        return {
            entryRepo: this.entryRepo,
            getHeadRepo: headRepo ? async () => headRepo : undefined,
            makeEntry: (data) => asEntity(this.entryRepo, data),
            makeHead: (data) => asEntity(headRepo!, data),
            hmacKey: this.resolvedKey,
            logger: this.logger,
        };
    }

    /**
     * Persists one hash-chained escrow-access audit entry. Unlike `AuditLogUtils.record()`, this THROWS/propagates a
     * persistence failure rather than swallowing it - a failed write here means an escrow access happened with
     * no tamper-evident record of it, which undermines the entire feature's compliance value; the caller must
     * let this fail the whole request rather than silently continue.
     *
     * Scheme: HMAC-SHA256 keyed by `mail:escrow:audit_hmac_key` when set, otherwise unkeyed SHA-256 (with a
     * one-time warning - see `warnIfKeyMissing()`). The scheme used is recorded on the entry (`hashAlgorithm`).
     *
     * Concurrency: reads the current highest `sequence`, computes the next entry's hash, and attempts to
     * insert it. `EscrowAuditLogEntrySQL`/`Mongo` carry a unique index on `sequence`, so two concurrent callers
     * racing for the same next sequence number can't fork the chain - the loser's insert fails, and this
     * retries (re-reading the now-updated latest entry) up to `MAX_APPEND_ATTEMPTS` times before giving
     * up. That unique index (not the head record) is what serializes appends; the head is advanced right after
     * (`advanceHead()`). Claiming the head first instead would make a failure between the two leave the head
     * pointing at an entry that was never written - a permanent verification failure - whereas this order can
     * only leave a self-healing lag. Not wrapped in `@Transactional()`: that decorator resolves the datasource to
     * open a transaction against from a `@Model`-decorated ROUTE class's own `modelClass` getter (see
     * `BaseKeyVaultRoute.ts`'s), which a plain, non-route utility service like this one has no equivalent of.
     */
    public async record(params: RecordEscrowAuditEntryParams): Promise<EscrowAuditLogEntry> {
        this.warnIfKeyMissing();
        return appendEntry(this.chainContext(), params);
    }

    /**
     * Walks every `EscrowAuditLogEntry` in `sequence` order (paginated, `VERIFY_PAGE_SIZE` at a time - same
     * pattern `MailboxQuotaRecalcJob.findAllPages()` already establishes), and for each one: checks
     * `entry.previousHash` matches the running expected value, then recomputes `hash` from the entry's own
     * stored fields with the entry's own `hashAlgorithm` (absent = legacy SHA-256) and compares. Returns the
     * first (lowest) sequence at which any check fails.
     *
     * Then compares the chain against the separately stored head record (read BEFORE the walk, so a concurrent
     * append can only add entries past it, never make the chain look truncated):
     * - head `sequence` beyond the last entry present -> `truncated` (tail deletion).
     * - the entry at head `sequence` has a different hash -> `head_mismatch`. Entries AFTER the head are
     * tolerated (a head lagging after a failed `advanceHead()`); they still had to pass the per-entry checks.
     * - head MAC present -> must verify with the configured key. With a key configured, a head MAC is required
     * (`head_mac_mismatch` when missing).
     * - no head row at all -> "no head yet" (valid) only while every entry is a pre-upgrade legacy entry (no
     * `hashAlgorithm`), i.e. a deployment that hasn't appended since upgrading - its first append creates the
     * head. Once any entry carries `hashAlgorithm`, a head must exist (`head_missing`).
     *
     * Residual limits (inherent to keeping all state in the same database an attacker is assumed to write to):
     * with the key configured, an attacker without it can't forge entries or a head, but can still (a) restore a
     * previously captured head row after deleting the entries appended since, or (b) rewrite every entry as a
     * pre-upgrade legacy SHA-256 entry (no `hashAlgorithm`) and delete the head. Only an external anchor (e.g.
     * periodically recording the head off-box) closes those.
     */
    public async verifyChain(): Promise<EscrowAuditVerificationResult> {
        this.warnIfKeyMissing();
        return verifyChain(this.chainContext());
    }
}
