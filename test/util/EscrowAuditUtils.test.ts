///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for recordEscrowAuditEntry()/verifyEscrowAuditChain() - objectFactory/repo are
// hand-built mocks so this can assert exactly what gets persisted, retried, and verified, without a real
// DB.
//
// Both functions cache one repo per `escrowAuditLogClass` *object identity* in a module-level WeakMap (see
// EscrowAuditUtils.ts's own doc comment on getEscrowAuditRepo()) - shared across every call in this
// process, not reset between tests. Each test below therefore declares its own fresh, locally-scoped stub
// class rather than a single shared one, so no test's cache entry can leak into (and mask a missing
// `newInstance()` call in) another.
import { recordEscrowAuditEntry, verifyEscrowAuditChain } from "../../src/util/EscrowAuditUtils.js";
import { EscrowAuditAction } from "../../src/models/types.js";

function makeStubClass(): any {
    return class StubEscrowAuditLogEntry {
        [key: string]: any;
        constructor(props: any) {
            Object.assign(this, props);
        }
    };
}

function makeObjectFactory(repo: any): any {
    return { newInstance: vi.fn().mockResolvedValue(repo) };
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

describe("recordEscrowAuditEntry() Tests", () => {
    it("Persists the first entry with sequence 0 and no previousHash.", async () => {
        const repo = { find: vi.fn().mockResolvedValue([]), create: vi.fn().mockImplementation(async (entry) => entry) };
        const objectFactory = makeObjectFactory(repo);

        const entry = await recordEscrowAuditEntry(objectFactory, makeStubClass(), makeParams());

        expect(entry.sequence).toBe(0);
        expect(entry.previousHash).toBeUndefined();
        expect(typeof entry.hash).toBe("string");
        expect(entry.hash.length).toBeGreaterThan(0);
    });

    it("Chains the second entry's previousHash to the first entry's hash, and increments sequence.", async () => {
        const stubClass = makeStubClass();
        const objectFactory = makeObjectFactory(null);
        let stored: any;
        const repo = {
            find: vi.fn().mockImplementation(async () => (stored ? [stored] : [])),
            create: vi.fn().mockImplementation(async (entry) => {
                stored = entry;
                return entry;
            }),
        };
        objectFactory.newInstance.mockResolvedValue(repo);

        const first = await recordEscrowAuditEntry(objectFactory, stubClass, makeParams());
        const second = await recordEscrowAuditEntry(objectFactory, stubClass, makeParams({ action: EscrowAuditAction.REQUEST_APPROVED }));

        expect(second.sequence).toBe(1);
        expect(second.previousHash).toBe(first.hash);
        expect(second.hash).not.toBe(first.hash);
    });

    it("Produces a different hash when any one field differs.", async () => {
        const repoA = { find: vi.fn().mockResolvedValue([]), create: vi.fn().mockImplementation(async (entry) => entry) };
        const entryA = await recordEscrowAuditEntry(makeObjectFactory(repoA), makeStubClass(), makeParams());

        const repoB = { find: vi.fn().mockResolvedValue([]), create: vi.fn().mockImplementation(async (entry) => entry) };
        const entryB = await recordEscrowAuditEntry(makeObjectFactory(repoB), makeStubClass(), makeParams({ mailboxUid: "mbx-2" }));

        expect(entryA.hash).not.toBe(entryB.hash);
    });

    it("Retries on a sequence conflict, re-reading the latest entry before succeeding.", async () => {
        const repo = {
            find: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ sequence: 0, hash: "existing-hash" }]),
            create: vi.fn().mockRejectedValueOnce(new Error("duplicate key")).mockImplementationOnce(async (entry) => entry),
        };
        const objectFactory = makeObjectFactory(repo);

        const entry = await recordEscrowAuditEntry(objectFactory, makeStubClass(), makeParams());

        expect(repo.create).toHaveBeenCalledTimes(2);
        expect(entry.sequence).toBe(1);
        expect(entry.previousHash).toBe("existing-hash");
    });

    it("Gives up and throws after the bounded retry count.", async () => {
        const repo = {
            find: vi.fn().mockResolvedValue([]),
            create: vi.fn().mockRejectedValue(new Error("duplicate key")),
        };
        const objectFactory = makeObjectFactory(repo);

        await expect(recordEscrowAuditEntry(objectFactory, makeStubClass(), makeParams())).rejects.toThrow("duplicate key");
        expect(repo.create.mock.calls.length).toBeGreaterThan(1);
    });
});

describe("verifyEscrowAuditChain() Tests", () => {
    it("Returns valid: true for an intact chain built via recordEscrowAuditEntry().", async () => {
        const stubClass = makeStubClass();
        let stored: any[] = [];
        const repo = {
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
        const objectFactory = makeObjectFactory(repo);

        await recordEscrowAuditEntry(objectFactory, stubClass, makeParams());
        await recordEscrowAuditEntry(objectFactory, stubClass, makeParams({ action: EscrowAuditAction.REQUEST_APPROVED }));
        await recordEscrowAuditEntry(objectFactory, stubClass, makeParams({ action: EscrowAuditAction.MATERIAL_READ }));

        const result = await verifyEscrowAuditChain(objectFactory, stubClass);

        expect(result).toEqual({ valid: true });
    });

    it("Detects tampering at the first broken entry's sequence.", async () => {
        const stubClass = makeStubClass();
        let stored: any[] = [];
        const repo = {
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
        const objectFactory = makeObjectFactory(repo);

        await recordEscrowAuditEntry(objectFactory, stubClass, makeParams());
        await recordEscrowAuditEntry(objectFactory, stubClass, makeParams({ action: EscrowAuditAction.REQUEST_APPROVED }));

        // Tamper with the second entry's details directly, bypassing recordEscrowAuditEntry() entirely -
        // its stored `hash` no longer matches what recomputation from its (now-mutated) fields produces.
        stored[1].details = { tampered: true };

        const result = await verifyEscrowAuditChain(objectFactory, stubClass);

        expect(result.valid).toBe(false);
        expect(result.brokenAtSequence).toBe(1);
    });

    it("Detects a broken previousHash link (a deleted/reordered entry), distinct from a per-entry hash mismatch.", async () => {
        const stubClass = makeStubClass();
        let stored: any[] = [];
        const repo = {
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
        const objectFactory = makeObjectFactory(repo);

        await recordEscrowAuditEntry(objectFactory, stubClass, makeParams());
        await recordEscrowAuditEntry(objectFactory, stubClass, makeParams({ action: EscrowAuditAction.REQUEST_APPROVED }));

        // Directly delete the first entry from the backing store, as if it were purged out from under the
        // chain - the second entry's own `hash` is still internally consistent with its own fields, but its
        // `previousHash` no longer matches any entry actually present (`expectedPreviousHash` starts
        // `undefined` for the first entry seen, which is now the second one, whose `previousHash` is set).
        stored.shift();

        const result = await verifyEscrowAuditChain(objectFactory, stubClass);

        expect(result.valid).toBe(false);
        expect(result.brokenAtSequence).toBe(1);
    });
});
