///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for findActiveHoldsFor()/assertNotOnLegalHold() - objectFactory/repo are hand-built
// mocks so this can assert behavior without a real DB. See test/util/EscrowUtils.test.ts's identical
// rationale for why each test declares its own fresh, locally-scoped stub class rather than a single
// shared one - both functions cache one repo per `matterClass` object identity in a module-level WeakMap.
import { assertNotOnLegalHold, findActiveHoldsFor, loadLegalHoldIndex } from "../../src/util/LegalHoldUtils.js";

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

    // A bare, unpaginated `find()` silently truncates at the framework's default limit (100 rows) - see
    // DataExportJob.findAllPages()'s identical rationale. This proves findActiveHoldsFor() walks every
    // page rather than trusting a single call, by returning a hold-matching matter ONLY on a page past
    // where a naive single-call implementation would have stopped looking.
    it("Detects a hold on a matter beyond the first page, proving the query is paginated.", async () => {
        const pageSize = 500;
        const heldMatter = makeMatter({ uid: "matter-late", custodianMailboxUids: ["mailbox-1"] });
        const find = vi.fn().mockImplementation(async (_criteria: any, options: any) => {
            const page = options.page ?? 0;
            if (page === 0) {
                return Array.from({ length: pageSize }, (_, i) => makeMatter({ uid: `matter-page0-${i}`, custodianMailboxUids: ["someone-else"] }));
            }
            if (page === 1) {
                return [heldMatter];
            }
            return [];
        });
        const repo = { find };
        const objectFactory = makeObjectFactory(repo);

        const result = await findActiveHoldsFor(objectFactory, makeStubClass(), "mailbox-1");

        expect(result.map((m) => m.uid)).toEqual(["matter-late"]);
        // Page 1 returns fewer than `pageSize` rows, so the loop correctly stops there without a 3rd call.
        expect(find).toHaveBeenCalledTimes(2);
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

describe("loadLegalHoldIndex() Tests", () => {
    it("Indexes open matters by custodian, ignoring closed ones, and honors each matter's date range.", async () => {
        const repo = {
            find: vi.fn().mockResolvedValue([
                makeMatter({ uid: "open", custodianMailboxUids: ["held", "both"], dateRangeStart: new Date("2020-01-01"), dateRangeEnd: new Date("2020-12-31") }),
                makeMatter({ uid: "closed", custodianMailboxUids: ["closed-only", "both"], closedAt: new Date() }),
                makeMatter({ uid: "no-custodians", custodianMailboxUids: undefined }),
            ]),
        };

        const index = await loadLegalHoldIndex(makeObjectFactory(repo), makeStubClass());

        expect([...index.heldMailboxUids].sort()).toEqual(["both", "held"]);
        expect(index.isHeld("held")).toBe(true);
        expect(index.isHeld("held", new Date("2020-06-01"))).toBe(true);
        expect(index.isHeld("held", new Date("2021-06-01"))).toBe(false);
        expect(index.isHeld("closed-only")).toBe(false);
        expect(index.isHeld("nobody", new Date("2020-06-01"))).toBe(false);
    });
});
