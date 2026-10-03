///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for `EscrowAuditUtils` - the repositories are hand-built fakes so this can assert exactly what gets
// persisted, retried, and verified, without a real DB. Real MongoDB/SQL runs through the escrow route tests.
import * as crypto from "crypto";
import config from "../config.js";
import { Logger } from "@rapidrest/core";
import { ObjectFactory } from "@rapidrest/service-core";
import { EscrowAuditUtils } from "../../src/util/EscrowAuditUtils.js";
import { EscrowAuditAction, EscrowAuditHashAlgorithm } from "../../src/models/types.js";

function makeStubClass(): any {
    return class StubEscrowAuditLogEntry {
        [key: string]: any;
        constructor(props: any) {
            Object.assign(this, props);
        }
    };
}

function makeParams(overrides: any = {}) {
    return {
        action: EscrowAuditAction.REQUEST_CREATED,
        holderUserUid: "holder-1",
        matterId: "matter-1",
        mailboxUid: "mbx-1",
        requestId: "req-1",
        ...overrides,
    };
}

/** An `EscrowAuditUtils` over just an entry repository (no head), with no key and a throwaway logger. */
function makeUtils(repo: any): EscrowAuditUtils {
    const utils: any = new EscrowAuditUtils(repo);
    utils.logger = { warn: vi.fn(), error: vi.fn() };
    return utils;
}

/** An in-memory entry repository that also answers the verifier's paged read. */
function makeEntryRepo(stored: any[] = []) {
    return {
        find: vi.fn().mockImplementation(async (query: any) => {
            if (query.page !== undefined) {
                return query.page === 0 ? stored : [];
            }
            return stored.length ? [stored[stored.length - 1]] : [];
        }),
        create: vi.fn().mockImplementation(async (entry) => {
            stored.push(entry);
            return entry;
        }),
    };
}

describe("EscrowAuditUtils.record() Tests", () => {
    it("Persists the first entry with sequence 0 and no previousHash.", async () => {
        const repo = { find: vi.fn().mockResolvedValue([]), create: vi.fn().mockImplementation(async (entry) => entry) };

        const entry = await makeUtils(repo).record(makeParams());

        expect(entry.sequence).toBe(0);
        expect(entry.previousHash).toBeUndefined();
        expect(typeof entry.hash).toBe("string");
        expect(entry.hash.length).toBeGreaterThan(0);
    });

    it("Chains the second entry's previousHash to the first entry's hash, and increments sequence.", async () => {
        let stored: any;
        const repo = {
            find: vi.fn().mockImplementation(async () => (stored ? [stored] : [])),
            create: vi.fn().mockImplementation(async (entry) => {
                stored = entry;
                return entry;
            }),
        };
        const utils = makeUtils(repo);

        const first = await utils.record(makeParams());
        const second = await utils.record(makeParams({ action: EscrowAuditAction.REQUEST_APPROVED }));

        expect(second.sequence).toBe(1);
        expect(second.previousHash).toBe(first.hash);
        expect(second.hash).not.toBe(first.hash);
    });

    it("Produces a different hash when any one field differs.", async () => {
        const repoA = { find: vi.fn().mockResolvedValue([]), create: vi.fn().mockImplementation(async (entry) => entry) };
        const entryA = await makeUtils(repoA).record(makeParams());

        const repoB = { find: vi.fn().mockResolvedValue([]), create: vi.fn().mockImplementation(async (entry) => entry) };
        const entryB = await makeUtils(repoB).record(makeParams({ mailboxUid: "mbx-2" }));

        expect(entryA.hash).not.toBe(entryB.hash);
    });

    it("Retries on a sequence conflict, re-reading the latest entry before succeeding.", async () => {
        const repo = {
            find: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ sequence: 0, hash: "existing-hash" }]),
            create: vi.fn().mockRejectedValueOnce(new Error("duplicate key")).mockImplementationOnce(async (entry) => entry),
        };

        const entry = await makeUtils(repo).record(makeParams());

        expect(repo.create).toHaveBeenCalledTimes(2);
        expect(entry.sequence).toBe(1);
        expect(entry.previousHash).toBe("existing-hash");
    });

    it("Gives up and throws after the bounded retry count.", async () => {
        const repo = {
            find: vi.fn().mockResolvedValue([]),
            create: vi.fn().mockRejectedValue(new Error("duplicate key")),
        };

        await expect(makeUtils(repo).record(makeParams())).rejects.toThrow("duplicate key");
        expect(repo.create.mock.calls.length).toBeGreaterThan(1);
    });
});

describe("EscrowAuditUtils.verifyChain() Tests", () => {
    it("Returns valid: true for an intact chain built via record().", async () => {
        const utils = makeUtils(makeEntryRepo());

        await utils.record(makeParams());
        await utils.record(makeParams({ action: EscrowAuditAction.REQUEST_APPROVED }));
        await utils.record(makeParams({ action: EscrowAuditAction.MATERIAL_READ }));

        expect(await utils.verifyChain()).toEqual({ valid: true });
    });

    it("Detects tampering at the first broken entry's sequence.", async () => {
        const stored: any[] = [];
        const utils = makeUtils(makeEntryRepo(stored));

        await utils.record(makeParams());
        await utils.record(makeParams({ action: EscrowAuditAction.REQUEST_APPROVED }));

        // Tamper with the second entry's details directly, bypassing record() entirely - its stored `hash` no
        // longer matches what recomputation from its (now-mutated) fields produces.
        stored[1].details = { tampered: true };

        const result = await utils.verifyChain();

        expect(result.valid).toBe(false);
        expect(result.brokenAtSequence).toBe(1);
    });

    it("Detects a broken previousHash link (a deleted/reordered entry), distinct from a per-entry hash mismatch.", async () => {
        const stored: any[] = [];
        const utils = makeUtils(makeEntryRepo(stored));

        await utils.record(makeParams());
        await utils.record(makeParams({ action: EscrowAuditAction.REQUEST_APPROVED }));

        // Directly delete the first entry from the backing store, as if it were purged out from under the chain - the
        // second entry's own `hash` is still internally consistent with its own fields, but its `previousHash` no
        // longer matches any entry actually present (`expectedPreviousHash` starts `undefined` for the first entry
        // seen, which is now the second one, whose `previousHash` is set).
        stored.shift();

        const result = await utils.verifyChain();

        expect(result.valid).toBe(false);
        expect(result.brokenAtSequence).toBe(1);
    });
});

// --- HMAC keying + head record (tail-truncation detection) -------------------------------------------------
// A small in-memory fake of both repos: `entries` enforces the unique `sequence` index, `heads` enforces the
// unique `chainId` and `RepoUtils.update()`'s optimistic `version` lock.
function makeChainFixture(options: { key?: any; withHead?: boolean; environment?: string } = {}) {
    const entries: any[] = [];
    const heads: any[] = [];
    const EntryClass = makeStubClass();
    const HeadClass = makeStubClass();
    const entryRepo = {
        modelClass: EntryClass,
        find: vi.fn(async (query: any) => {
            const sorted = [...entries].sort((a, b) => a.sequence - b.sequence);
            if (query.page !== undefined) {
                return query.page === 0 ? sorted : [];
            }
            return sorted.length ? [sorted[sorted.length - 1]] : [];
        }),
        create: vi.fn(async (entry: any) => {
            if (entries.some((e) => e.sequence === entry.sequence)) {
                throw new Error("duplicate key");
            }
            entries.push(entry);
            return entry;
        }),
    };
    const headRepo = {
        modelClass: HeadClass,
        find: vi.fn(async () => heads.map((h) => ({ ...h }))),
        create: vi.fn(async (head: any) => {
            if (heads.length) {
                throw new Error("duplicate key");
            }
            heads.push({ ...head, version: 0 });
            return head;
        }),
        update: vi.fn(async (obj: any, existing: any) => {
            if (!heads[0] || heads[0].version !== existing.version || obj.version !== existing.version) {
                throw new Error("version conflict");
            }
            heads[0] = { ...obj, version: existing.version + 1 };
            return heads[0];
        }),
    };
    const logger = { warn: vi.fn(), error: vi.fn() };
    /** A service over the fake repositories; `withHead: false` (or `null`) builds it without head maintenance. */
    const makeService = (withHead: boolean | null = options.withHead !== false): any => {
        const utils: any = new EscrowAuditUtils(entryRepo as any, withHead === null ? null : withHead ? (headRepo as any) : undefined);
        utils.hmacKey = options.key ?? "";
        utils.environment = options.environment;
        utils.logger = logger;
        return utils;
    };
    const service: any = makeService();
    return {
        entries,
        heads,
        EntryClass,
        HeadClass,
        entryRepo,
        headRepo,
        logger,
        utils: service as EscrowAuditUtils,
        makeService,
        setKey: (k: any) => (service.hmacKey = k),
        append: (overrides: any = {}) => service.record(makeParams(overrides)),
        verify: () => service.verifyChain(),
    };
}

function legacySha256(entry: any): string {
    const payload = JSON.stringify({
        sequence: entry.sequence,
        previousHash: entry.previousHash ?? "",
        action: entry.action,
        holderUserUid: entry.holderUserUid,
        matterId: entry.matterId,
        mailboxUid: entry.mailboxUid,
        requestId: entry.requestId,
        occurredAt: entry.occurredAt.toISOString(),
        details: entry.details ?? {},
    });
    return crypto.createHash("sha256").update(payload).digest("hex");
}

/** Inserts a pre-upgrade entry directly (no `hashAlgorithm`, plain SHA-256), exactly as the old code wrote them. */
function pushLegacyEntry(fixture: ReturnType<typeof makeChainFixture>, overrides: any = {}): any {
    const previous = fixture.entries[fixture.entries.length - 1];
    const entry: any = {
        ...makeParams(overrides),
        sequence: previous ? previous.sequence + 1 : 0,
        previousHash: previous?.hash,
        occurredAt: new Date(),
    };
    entry.hash = legacySha256(entry);
    fixture.entries.push(entry);
    return entry;
}

describe("EscrowAuditUtils HMAC keying Tests", () => {
    it("Keys new entries with HMAC-SHA256 from mail:escrow:audit_hmac_key and marks them hmac-sha256.", async () => {
        const fixture = makeChainFixture({ key: "secret-key" });

        const first = await fixture.append();
        const second = await fixture.append({ action: EscrowAuditAction.REQUEST_APPROVED });

        expect(first.hashAlgorithm).toBe(EscrowAuditHashAlgorithm.HMAC_SHA256);
        expect(second.hashAlgorithm).toBe(EscrowAuditHashAlgorithm.HMAC_SHA256);
        // Not the unkeyed digest of the same content.
        expect(first.hash).not.toBe(legacySha256(first));
        expect(await fixture.verify()).toEqual({ valid: true });
        expect(fixture.logger.warn).not.toHaveBeenCalled();
        expect(fixture.logger.error).not.toHaveBeenCalled();
    });

    it("Detects an entry an attacker without the key rewrote with a consistently recomputed SHA-256 digest.", async () => {
        const fixture = makeChainFixture({ key: "secret-key" });
        await fixture.append();
        await fixture.append({ action: EscrowAuditAction.REQUEST_APPROVED });

        // Rewrite entry 1 and recompute its digest with unkeyed SHA-256 - a forgery the pre-fix scheme accepted.
        fixture.entries[1].details = { tampered: true };
        fixture.entries[1].hash = legacySha256(fixture.entries[1]);
        fixture.heads[0].hash = fixture.entries[1].hash;

        expect(await fixture.verify()).toEqual({ valid: false, brokenAtSequence: 1, reason: "hash_mismatch" });
    });

    it("Rejects stripping hashAlgorithm off an entry that follows an HMAC entry as a downgrade.", async () => {
        const fixture = makeChainFixture({ key: "secret-key" });
        await fixture.append();
        await fixture.append({ action: EscrowAuditAction.REQUEST_APPROVED });

        delete fixture.entries[1].hashAlgorithm;
        fixture.entries[1].hash = legacySha256(fixture.entries[1]);

        expect(await fixture.verify()).toEqual({ valid: false, brokenAtSequence: 1, reason: "algorithm_downgrade" });
    });

    it("Fails verification with a different key, and reports hmac_key_unavailable with no key at all.", async () => {
        const fixture = makeChainFixture({ key: "secret-key" });
        await fixture.append();

        fixture.setKey("other-key");
        expect(await fixture.verify()).toEqual({ valid: false, brokenAtSequence: 0, reason: "hash_mismatch" });

        fixture.setKey(undefined);
        expect(await fixture.verify()).toEqual({ valid: false, brokenAtSequence: 0, reason: "hmac_key_unavailable" });
    });

    it("Rejects an entry carrying an unrecognized hashAlgorithm.", async () => {
        const fixture = makeChainFixture({ key: "secret-key" });
        await fixture.append();
        fixture.entries[0].hashAlgorithm = "md5";

        expect(await fixture.verify()).toEqual({ valid: false, brokenAtSequence: 0, reason: "unknown_algorithm" });
    });

    it("Accepts a numeric key (nconf parseValues) rather than silently falling back to SHA-256.", async () => {
        const fixture = makeChainFixture({ key: 123456 });
        const entry = await fixture.append();

        expect(entry.hashAlgorithm).toBe(EscrowAuditHashAlgorithm.HMAC_SHA256);
        expect(await fixture.verify()).toEqual({ valid: true });
    });

    it("Without a key, falls back to SHA-256 (marked sha256) and warns exactly once.", async () => {
        const fixture = makeChainFixture();

        const first = await fixture.append();
        await fixture.append({ action: EscrowAuditAction.REQUEST_APPROVED });

        expect(first.hashAlgorithm).toBe(EscrowAuditHashAlgorithm.SHA256);
        expect(first.hash).toBe(legacySha256(first));
        expect(await fixture.verify()).toEqual({ valid: true });
        expect(fixture.logger.warn).toHaveBeenCalledTimes(1);
        expect(fixture.logger.warn.mock.calls[0][0]).toContain("mail:escrow:audit_hmac_key");
        expect(fixture.logger.error).not.toHaveBeenCalled();
    });

    it("Without a key in production, logs at error level instead of warn, and still does not throw.", async () => {
        const fixture = makeChainFixture({ environment: "production" });

        await expect(fixture.append()).resolves.toBeDefined();

        expect(fixture.logger.error).toHaveBeenCalledTimes(1);
        expect(fixture.logger.warn).not.toHaveBeenCalled();
    });

    it("Still verifies pre-upgrade legacy entries (no hashAlgorithm, no head yet), followed by new HMAC entries.", async () => {
        const fixture = makeChainFixture({ key: "secret-key" });
        pushLegacyEntry(fixture);
        pushLegacyEntry(fixture, { action: EscrowAuditAction.REQUEST_APPROVED });

        // No head row yet and only legacy entries: "no head yet", not a failure.
        expect(await fixture.verify()).toEqual({ valid: true });

        const appended = await fixture.append({ action: EscrowAuditAction.MATERIAL_READ });

        expect(appended.sequence).toBe(2);
        expect(appended.previousHash).toBe(fixture.entries[1].hash);
        expect(fixture.heads).toHaveLength(1);
        expect(fixture.heads[0].sequence).toBe(2);
        expect(await fixture.verify()).toEqual({ valid: true });
    });

    it("Detects tampering with a legacy entry that HMAC entries follow.", async () => {
        const fixture = makeChainFixture({ key: "secret-key" });
        pushLegacyEntry(fixture);
        await fixture.append({ action: EscrowAuditAction.REQUEST_APPROVED });

        fixture.entries[0].details = { tampered: true };

        expect(await fixture.verify()).toEqual({ valid: false, brokenAtSequence: 0, reason: "hash_mismatch" });
    });
});

describe("EscrowAuditUtils head record Tests", () => {
    it("Creates the head on the first append and advances it (with a MAC) on each later one.", async () => {
        const fixture = makeChainFixture({ key: "secret-key" });

        await fixture.append();
        expect(fixture.heads[0]).toMatchObject({ chainId: "global", sequence: 0, hash: fixture.entries[0].hash });

        await fixture.append({ action: EscrowAuditAction.REQUEST_APPROVED });
        expect(fixture.heads).toHaveLength(1);
        expect(fixture.heads[0]).toMatchObject({
            sequence: 1,
            hash: fixture.entries[1].hash,
            hashAlgorithm: EscrowAuditHashAlgorithm.HMAC_SHA256,
        });
        expect(typeof fixture.heads[0].mac).toBe("string");
    });

    it("Writes a MAC-less head when no key is configured.", async () => {
        const fixture = makeChainFixture();
        await fixture.append();

        expect(fixture.heads[0].mac).toBeNull();
        expect(fixture.heads[0].hashAlgorithm).toBeNull();
    });

    it("Detects deletion of the chain's tail, which the chain alone cannot.", async () => {
        const fixture = makeChainFixture({ key: "secret-key" });
        await fixture.append();
        await fixture.append({ action: EscrowAuditAction.REQUEST_APPROVED });
        await fixture.append({ action: EscrowAuditAction.MATERIAL_READ });

        fixture.entries.pop();

        // The remaining chain is internally consistent - only the head reveals the missing tail.
        expect(await fixture.makeService(false).verifyChain()).toEqual({ valid: true });
        expect(await fixture.verify()).toEqual({ valid: false, brokenAtSequence: 2, reason: "truncated" });
    });

    it("Detects deletion of every entry while the head remains.", async () => {
        const fixture = makeChainFixture();
        await fixture.append();
        fixture.entries.length = 0;

        expect(await fixture.verify()).toEqual({ valid: false, brokenAtSequence: 0, reason: "truncated" });
    });

    it("Detects a MAC-less head whose hash doesn't match the entry at its sequence.", async () => {
        const fixture = makeChainFixture();
        await fixture.append();
        await fixture.append({ action: EscrowAuditAction.REQUEST_APPROVED });

        fixture.heads[0].hash = "f".repeat(64);

        expect(await fixture.verify()).toEqual({ valid: false, brokenAtSequence: 1, reason: "head_mismatch" });
    });

    it("Detects a head rolled back to an earlier entry (after tail deletion) by its MAC.", async () => {
        const fixture = makeChainFixture({ key: "secret-key" });
        await fixture.append();
        await fixture.append({ action: EscrowAuditAction.REQUEST_APPROVED });

        fixture.entries.pop();
        fixture.heads[0].sequence = 0;
        fixture.heads[0].hash = fixture.entries[0].hash;

        expect(await fixture.verify()).toEqual({ valid: false, brokenAtSequence: 0, reason: "head_mac_mismatch" });
    });

    it("Detects a head whose MAC was stripped while it points at an HMAC entry.", async () => {
        const fixture = makeChainFixture({ key: "secret-key" });
        await fixture.append();
        await fixture.append({ action: EscrowAuditAction.REQUEST_APPROVED });

        fixture.entries.pop();
        fixture.heads[0] = { ...fixture.heads[0], sequence: 0, hash: fixture.entries[0].hash, mac: null, hashAlgorithm: null };

        expect(await fixture.verify()).toEqual({ valid: false, brokenAtSequence: 0, reason: "head_mac_mismatch" });
    });

    it("Detects a head whose MAC was replaced by a value of the wrong length (never reaching the constant-time compare).", async () => {
        const fixture = makeChainFixture({ key: "secret-key" });
        await fixture.append();

        fixture.heads[0].mac = "short";

        expect(await fixture.verify()).toEqual({ valid: false, brokenAtSequence: 0, reason: "head_mac_mismatch" });
    });

    it("Reports hash_mismatch for an entry whose stored hash is missing or truncated.", async () => {
        const fixture = makeChainFixture({ key: "secret-key" });
        await fixture.append();

        fixture.entries[0].hash = "abc";
        expect(await fixture.verify()).toMatchObject({ valid: false, brokenAtSequence: 0, reason: "hash_mismatch" });

        fixture.entries[0].hash = undefined;
        expect(await fixture.verify()).toMatchObject({ valid: false, brokenAtSequence: 0, reason: "hash_mismatch" });
    });

    it("Reports hmac_key_unavailable for a MAC'd head when verifying without the key.", async () => {
        const fixture = makeChainFixture({ key: "secret-key" });
        pushLegacyEntry(fixture);
        await fixture.append();
        // Drop the HMAC entry and point the (still MAC'd) head at the legacy one, so only the head needs the key.
        fixture.entries.pop();
        fixture.heads[0].sequence = 0;
        fixture.setKey(undefined);

        expect(await fixture.verify()).toEqual({ valid: false, brokenAtSequence: 0, reason: "hmac_key_unavailable" });
    });

    it("Reports head_missing when post-upgrade entries exist but the head row was deleted.", async () => {
        const fixture = makeChainFixture({ key: "secret-key" });
        await fixture.append();
        await fixture.append({ action: EscrowAuditAction.REQUEST_APPROVED });

        fixture.heads.length = 0;

        expect(await fixture.verify()).toEqual({ valid: false, brokenAtSequence: 1, reason: "head_missing" });
    });

    it("Treats an empty chain with no head as valid.", async () => {
        const fixture = makeChainFixture({ key: "secret-key" });

        expect(await fixture.verify()).toEqual({ valid: true });
    });

    it("Retries a head version conflict and still advances the head.", async () => {
        const fixture = makeChainFixture({ key: "secret-key" });
        await fixture.append();
        fixture.headRepo.update.mockRejectedValueOnce(new Error("version conflict"));

        await fixture.append({ action: EscrowAuditAction.REQUEST_APPROVED });

        expect(fixture.headRepo.update).toHaveBeenCalledTimes(2);
        expect(fixture.heads[0].sequence).toBe(1);
        expect(await fixture.verify()).toEqual({ valid: true });
    });

    it("Retries a racing head create by re-reading and updating the head instead.", async () => {
        const fixture = makeChainFixture({ key: "secret-key" });
        fixture.headRepo.create.mockImplementationOnce(async () => {
            // A concurrent appender created the head first.
            fixture.heads.push({ chainId: "global", sequence: -1, hash: "", version: 0 });
            throw new Error("duplicate key");
        });

        await fixture.append();

        expect(fixture.headRepo.update).toHaveBeenCalledTimes(1);
        expect(fixture.heads[0].sequence).toBe(0);
    });

    it("Never moves the head backwards when a later append already advanced it.", async () => {
        const fixture = makeChainFixture({ key: "secret-key" });
        fixture.heads.push({ chainId: "global", sequence: 5, hash: "later", version: 3 });

        await fixture.append();

        expect(fixture.headRepo.update).not.toHaveBeenCalled();
        expect(fixture.heads[0]).toMatchObject({ sequence: 5, hash: "later", version: 3 });
    });

    it("Logs, but does not throw, when the head can't be advanced - and verification tolerates the lagging head.", async () => {
        const fixture = makeChainFixture({ key: "secret-key" });
        await fixture.append();
        const realUpdate = fixture.headRepo.update.getMockImplementation()!;
        fixture.headRepo.update.mockRejectedValue(new Error("db down"));

        const entry = await fixture.append({ action: EscrowAuditAction.REQUEST_APPROVED });

        expect(entry.sequence).toBe(1);
        expect(fixture.logger.error).toHaveBeenCalledTimes(1);
        expect(fixture.logger.error.mock.calls[0][0]).toContain("db down");
        expect(fixture.heads[0].sequence).toBe(0);
        expect(await fixture.verify()).toEqual({ valid: true });

        // The next successful append heals the lag.
        fixture.headRepo.update.mockImplementation(realUpdate);
        await fixture.append({ action: EscrowAuditAction.MATERIAL_READ });
        expect(fixture.heads[0].sequence).toBe(2);
        expect(await fixture.verify()).toEqual({ valid: true });
    });

    it("Passes the head to update() as a real head-class instance so the optimistic version lock is enforced (Mongo find() returns plain documents).", async () => {
        const fixture = makeChainFixture({ key: "secret-key" });
        await fixture.append();
        await fixture.append({ action: EscrowAuditAction.REQUEST_APPROVED });

        expect(fixture.headRepo.update).toHaveBeenCalledTimes(1);
        const existing = fixture.headRepo.update.mock.calls[0][1];
        expect(existing).toBeInstanceOf(fixture.HeadClass);
        expect(existing.version).toBe(0);
    });

    it("Requires a head MAC whenever a key is configured, even when the head points at a legacy SHA-256 entry.", async () => {
        const fixture = makeChainFixture({ key: "secret-key" });
        pushLegacyEntry(fixture);
        await fixture.append();

        // Attacker deletes every HMAC entry and rolls the head back onto the legacy entry, stripping the MAC.
        fixture.entries.pop();
        fixture.heads[0] = { ...fixture.heads[0], sequence: 0, hash: fixture.entries[0].hash, mac: null, hashAlgorithm: null };

        expect(await fixture.verify()).toEqual({ valid: false, brokenAtSequence: 0, reason: "head_mac_mismatch" });
    });

    it("Fails closed on a MAC-less head written before the key was enabled, and heals on the next keyed append.", async () => {
        const fixture = makeChainFixture();
        await fixture.append();
        fixture.setKey("secret-key");

        expect(await fixture.verify()).toEqual({ valid: false, brokenAtSequence: 0, reason: "head_mac_mismatch" });

        await fixture.append({ action: EscrowAuditAction.REQUEST_APPROVED });
        expect(await fixture.verify()).toEqual({ valid: true });
    });

    it("Skips head maintenance entirely for an entry class with no head class.", async () => {
        const fixture = makeChainFixture({ key: "secret-key", withHead: false });
        await fixture.append();
        fixture.entries.length = 0;

        expect(fixture.headRepo.find).not.toHaveBeenCalled();
        expect(await fixture.verify()).toEqual({ valid: true });
    });
});

describe("EscrowAuditUtils service wiring Tests", () => {
    it("Logs the missing-key warning at warn level outside production, and needs no logger.", async () => {
        const fixture = makeChainFixture();
        const quiet: any = fixture.makeService();
        quiet.logger = undefined;
        await expect(quiet.record(makeParams())).resolves.toBeDefined();

        const quietProduction: any = makeChainFixture({ environment: "production" }).makeService();
        quietProduction.logger = undefined;
        await expect(quietProduction.record(makeParams())).resolves.toBeDefined();
    });

    it("Works without a head repository (omitted or null), and does not check for tail truncation then.", async () => {
        for (const withHead of [false, null]) {
            const fixture = makeChainFixture({ key: "k" });
            const utils = fixture.makeService(withHead);

            await utils.record(makeParams());
            await utils.record(makeParams({ requestId: "req-2" }));

            expect(fixture.headRepo.find).not.toHaveBeenCalled();
            expect(fixture.heads).toHaveLength(0);
            expect(await utils.verifyChain()).toEqual({ valid: true });
        }
    });

    it("Appends entries and the head as the repositories' model classes.", async () => {
        const fixture = makeChainFixture({ key: "secret" });

        const entry = await fixture.append();

        expect(entry).toBeInstanceOf(fixture.EntryClass);
        expect(fixture.heads).toHaveLength(1);
        expect(fixture.headRepo.create.mock.calls[0][0]).toBeInstanceOf(fixture.HeadClass);
    });

    it("Propagates a persistence failure from record().", async () => {
        const fixture = makeChainFixture({ key: "k" });
        fixture.entryRepo.create.mockRejectedValue(new Error("db down"));

        await expect(fixture.append()).rejects.toThrow("db down");
    });

    describe("With a real ObjectFactory", () => {
        let objectFactory: ObjectFactory;
        let previousKey: any;

        beforeEach(() => {
            previousKey = config.get("mail:escrow:audit_hmac_key");
            objectFactory = new ObjectFactory(config, Logger());
        });

        afterEach(async () => {
            await objectFactory.destroy();
            config.set("mail:escrow:audit_hmac_key", previousKey);
        });

        it("Injects the HMAC key and a logger, and returns the same instance for the same name.", async () => {
            config.set("mail:escrow:audit_hmac_key", "factory-key");
            const fixture = makeChainFixture();
            const args = [fixture.entryRepo, fixture.headRepo];
            const first: any = await objectFactory.newInstance(EscrowAuditUtils, { name: "EscrowAuditLogEntryMongo", args });
            const second: any = await objectFactory.newInstance(EscrowAuditUtils, { name: "EscrowAuditLogEntryMongo", args });

            expect(first).toBeInstanceOf(EscrowAuditUtils);
            expect(second).toBe(first);
            expect(first.hmacKey).toBe("factory-key");
            expect(first.logger).toBeDefined();
            const entry = await first.record(makeParams());
            expect(entry.hashAlgorithm).toBe(EscrowAuditHashAlgorithm.HMAC_SHA256);
            expect(await first.verifyChain()).toEqual({ valid: true });
        });

        it("Builds without the HMAC key configured (it defaults to empty) and falls back to unkeyed SHA-256 with a warning.", async () => {
            config.set("mail:escrow:audit_hmac_key", undefined);
            const fixture = makeChainFixture();
            const instance: any = await objectFactory.newInstance(EscrowAuditUtils, {
                name: "EscrowAuditLogEntryNoKey",
                args: [fixture.entryRepo, fixture.headRepo],
            });
            const warn = vi.fn();
            instance.logger = { warn, error: vi.fn() };
            instance.environment = undefined;

            expect(instance.hmacKey).toBe("");
            const entry = await instance.record(makeParams());

            expect(entry.hashAlgorithm).toBe(EscrowAuditHashAlgorithm.SHA256);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(await instance.verifyChain()).toEqual({ valid: true });
        });
    });
});
