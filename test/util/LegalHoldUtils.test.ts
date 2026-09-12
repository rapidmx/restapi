///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for findActiveHoldsFor()/assertNotOnLegalHold() - objectFactory/repo are hand-built
// mocks so this can assert behavior without a real DB. See test/util/EscrowUtils.test.ts's identical
// rationale for why each test declares its own fresh, locally-scoped stub class rather than a single
// shared one - both functions cache one repo per `matterClass` object identity in a module-level WeakMap.
import { assertNotOnLegalHold, findActiveHoldsFor } from "../../src/util/LegalHoldUtils.js";

function makeStubClass(): any {
    return class StubMatter {};
}

function makeObjectFactory(repo: any): any {
    return { newInstance: vi.fn().mockResolvedValue(repo) };
}

function makeMatter(overrides: any = {}) {
    return {
        uid: "matter-1",
        custodianMailboxUids: ["mailbox-1"],
        dateRangeStart: new Date("2020-01-01"),
        dateRangeEnd: new Date("2030-01-01"),
        closedAt: undefined,
        ...overrides,
    };
}

describe("findActiveHoldsFor() Tests", () => {
    it("Returns an empty array when no matter names the mailbox as a custodian.", async () => {
        const repo = { find: vi.fn().mockResolvedValue([makeMatter({ custodianMailboxUids: ["someone-else"] })]) };
        const objectFactory = makeObjectFactory(repo);

        const result = await findActiveHoldsFor(objectFactory, makeStubClass(), "mailbox-1");

        expect(result).toEqual([]);
    });

    it("Excludes a closed matter even when the mailbox is a named custodian.", async () => {
        const repo = { find: vi.fn().mockResolvedValue([makeMatter({ closedAt: new Date() })]) };
        const objectFactory = makeObjectFactory(repo);

        const result = await findActiveHoldsFor(objectFactory, makeStubClass(), "mailbox-1");

        expect(result).toEqual([]);
    });

    it("Matches an open matter naming the mailbox when no reference date is given (whole-record scope).", async () => {
        const matter = makeMatter();
        const repo = { find: vi.fn().mockResolvedValue([matter]) };
        const objectFactory = makeObjectFactory(repo);

        const result = await findActiveHoldsFor(objectFactory, makeStubClass(), "mailbox-1");

        expect(result).toEqual([matter]);
    });

    it("Excludes a matter whose date range doesn't cover the given reference date.", async () => {
        const matter = makeMatter({ dateRangeStart: new Date("2020-01-01"), dateRangeEnd: new Date("2020-06-01") });
        const repo = { find: vi.fn().mockResolvedValue([matter]) };
        const objectFactory = makeObjectFactory(repo);

        const result = await findActiveHoldsFor(objectFactory, makeStubClass(), "mailbox-1", new Date("2021-01-01"));

        expect(result).toEqual([]);
    });

    it("Includes a matter whose date range covers the given reference date.", async () => {
        const matter = makeMatter({ dateRangeStart: new Date("2020-01-01"), dateRangeEnd: new Date("2025-01-01") });
        const repo = { find: vi.fn().mockResolvedValue([matter]) };
        const objectFactory = makeObjectFactory(repo);

        const result = await findActiveHoldsFor(objectFactory, makeStubClass(), "mailbox-1", new Date("2021-06-01"));

        expect(result).toEqual([matter]);
    });

    it("Returns every matching open matter, not just the first.", async () => {
        const matterA = makeMatter({ uid: "matter-a" });
        const matterB = makeMatter({ uid: "matter-b" });
        const repo = { find: vi.fn().mockResolvedValue([matterA, matterB]) };
        const objectFactory = makeObjectFactory(repo);

        const result = await findActiveHoldsFor(objectFactory, makeStubClass(), "mailbox-1");

        expect(result.map((m) => m.uid).sort()).toEqual(["matter-a", "matter-b"]);
    });
});

describe("assertNotOnLegalHold() Tests", () => {
    it("Resolves without throwing when no hold matches.", async () => {
        const repo = { find: vi.fn().mockResolvedValue([]) };
        const objectFactory = makeObjectFactory(repo);

        await expect(assertNotOnLegalHold(objectFactory, makeStubClass(), "mailbox-1")).resolves.toBeUndefined();
    });

    it("Throws, naming the blocking matter, when an active hold matches.", async () => {
        const repo = { find: vi.fn().mockResolvedValue([makeMatter({ uid: "matter-1" })]) };
        const objectFactory = makeObjectFactory(repo);

        await expect(assertNotOnLegalHold(objectFactory, makeStubClass(), "mailbox-1")).rejects.toThrow(/matter-1/);
    });
});
