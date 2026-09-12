///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { type ObjectFactory } from "@rapidrest/core";
import { RepoUtils } from "@rapidrest/service-core";
import { EscrowAuditAction, EscrowAuditLogEntry } from "../models/types.js";

/** Caches one `RepoUtils` per concrete `EscrowAuditLogEntry` class (Mongo vs SQL), mirroring
 * `AuditLogUtils.ts`'s/`EscrowUtils.ts`'s identical lazy-repo caching pattern. */
const escrowAuditRepoCache = new WeakMap<any, Promise<RepoUtils<EscrowAuditLogEntry>>>();

function getEscrowAuditRepo(objectFactory: ObjectFactory, escrowAuditLogClass: any): Promise<RepoUtils<EscrowAuditLogEntry>> {
    let cached = escrowAuditRepoCache.get(escrowAuditLogClass);
    if (!cached) {
        cached = Promise.resolve(
            objectFactory.newInstance(RepoUtils, { name: escrowAuditLogClass.name, args: [escrowAuditLogClass] }),
        );
        escrowAuditRepoCache.set(escrowAuditLogClass, cached);
    }
    return cached;
}

/** How many times `recordEscrowAuditEntry()` retries a `sequence` collision before giving up - see its own
 * doc comment for why this is a retry loop rather than a transaction. */
const MAX_APPEND_ATTEMPTS = 5;

/** How many entries `verifyEscrowAuditChain()` fetches per page - same pattern/size as
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

/** Computes the SHA-256 hex digest covering one entry's own content plus the previous entry's hash - the
 * link in the chain. Every field is written into the object literal in this exact, fixed order every time
 * (never derived from `Object.keys()` on caller-supplied data), so `JSON.stringify` is deterministic here -
 * the same reasoning `util/KeyDiscoveryClient.ts`'s own hashing relies on for its z-base32 discovery hash. */
function computeEscrowAuditHash(
    input: { sequence: number; previousHash?: string; occurredAt: Date } & RecordEscrowAuditEntryParams,
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
    return crypto.createHash("sha256").update(payload).digest("hex");
}

async function latestEntry(repo: RepoUtils<EscrowAuditLogEntry>): Promise<EscrowAuditLogEntry | undefined> {
    const [latest] = await repo.find({ sort: "-sequence", limit: 1 } as any, { ignoreACL: true, limit: 1 });
    return latest;
}

/**
 * Persists one hash-chained escrow-access audit entry. Unlike `recordAuditLog()`, this THROWS/propagates a
 * persistence failure rather than swallowing it - a failed write here means an escrow access happened with
 * no tamper-evident record of it, which undermines the entire feature's compliance value; the caller must
 * let this fail the whole request rather than silently continue.
 *
 * Concurrency: reads the current highest `sequence`, computes the next entry's hash, and attempts to
 * insert it. `EscrowAuditLogEntrySQL`/`Mongo` carry a unique index on `sequence`, so two concurrent callers
 * racing for the same next sequence number can't silently corrupt the chain - the loser's insert fails,
 * and this function retries (re-reading the now-updated latest entry) up to `MAX_APPEND_ATTEMPTS` times
 * before giving up. This mirrors `BaseKeyVaultRoute.findOrCreateKeyVault()`'s existing TOCTOU-tolerant
 * retry shape. Not wrapped in `@Transactional()`: that decorator resolves the datasource to open a
 * transaction against from a `@Model`-decorated ROUTE class's own `modelClass` getter (see
 * `BaseKeyVaultRoute.ts`'s), which a plain, non-route utility function like this one has no equivalent of.
 */
export async function recordEscrowAuditEntry(
    objectFactory: ObjectFactory,
    escrowAuditLogClass: any,
    params: RecordEscrowAuditEntryParams,
): Promise<EscrowAuditLogEntry> {
    const repo: RepoUtils<EscrowAuditLogEntry> = await getEscrowAuditRepo(objectFactory, escrowAuditLogClass);

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
        const latest: EscrowAuditLogEntry | undefined = await latestEntry(repo);
        const sequence: number = latest ? latest.sequence + 1 : 0;
        const previousHash: string | undefined = latest?.hash;
        const occurredAt: Date = new Date();
        const hash: string = computeEscrowAuditHash({ ...params, sequence, previousHash, occurredAt });

        try {
            return await repo.create(new escrowAuditLogClass({ ...params, sequence, previousHash, hash, occurredAt }), {
                ignoreACL: true,
            });
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError;
}

export interface EscrowAuditVerificationResult {
    valid: boolean;
    brokenAtSequence?: number;
}

/**
 * Walks every `EscrowAuditLogEntry` in `sequence` order (paginated, `VERIFY_PAGE_SIZE` at a time - same
 * pattern `MailboxQuotaRecalcJob.findAllPages()` already establishes), and for each one: checks
 * `entry.previousHash` matches the running expected value, then recomputes `hash` from the entry's own
 * stored fields and compares. Returns the first (lowest) sequence at which either check fails - editing or
 * deleting any row directly against the database (bypassing this app entirely) breaks its own `hash`
 * and/or every later entry's `previousHash`, so tampering anywhere in the chain is detectable here even
 * though it can't be prevented at the database layer.
 */
export async function verifyEscrowAuditChain(
    objectFactory: ObjectFactory,
    escrowAuditLogClass: any,
): Promise<EscrowAuditVerificationResult> {
    const repo: RepoUtils<EscrowAuditLogEntry> = await getEscrowAuditRepo(objectFactory, escrowAuditLogClass);

    let expectedPreviousHash: string | undefined;
    for (let page = 0; ; page++) {
        const batch: EscrowAuditLogEntry[] = await repo.find(
            { sort: "sequence", limit: VERIFY_PAGE_SIZE, page } as any,
            { ignoreACL: true, limit: VERIFY_PAGE_SIZE, page },
        );
        for (const entry of batch) {
            if ((entry.previousHash ?? undefined) !== expectedPreviousHash) {
                return { valid: false, brokenAtSequence: entry.sequence };
            }
            const recomputed: string = computeEscrowAuditHash(entry);
            if (recomputed !== entry.hash) {
                return { valid: false, brokenAtSequence: entry.sequence };
            }
            expectedPreviousHash = entry.hash;
        }
        if (batch.length < VERIFY_PAGE_SIZE) {
            break;
        }
    }
    return { valid: true };
}
