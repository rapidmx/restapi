///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for findActiveHoldsFor()/assertNotOnLegalHold()/loadLegalHoldIndex() - the repository is a hand-built mock so
// this can assert behavior without a real DB.
import { assertNotOnLegalHold, findActiveHoldsFor, loadLegalHoldIndex } from "../../src/util/LegalHoldUtils.js";

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

        const result = await findActiveHoldsFor(repo as any, "mailbox-1");

        expect(result).toEqual([]);
    });

    it("Excludes a closed matter even when the mailbox is a named custodian.", async () => {
        const repo = { find: vi.fn().mockResolvedValue([makeMatter({ closedAt: new Date() })]) };

        const result = await findActiveHoldsFor(repo as any, "mailbox-1");

        expect(result).toEqual([]);
    });

    it("Matches an open matter naming the mailbox when no reference date is given (whole-record scope).", async () => {
        const matter = makeMatter();
        const repo = { find: vi.fn().mockResolvedValue([matter]) };

        const result = await findActiveHoldsFor(repo as any, "mailbox-1");

        expect(result).toEqual([matter]);
    });

    it("Excludes a matter whose date range doesn't cover the given reference date.", async () => {
        const matter = makeMatter({ dateRangeStart: new Date("2020-01-01"), dateRangeEnd: new Date("2020-06-01") });
        const repo = { find: vi.fn().mockResolvedValue([matter]) };

        const result = await findActiveHoldsFor(repo as any, "mailbox-1", new Date("2021-01-01"));

        expect(result).toEqual([]);
    });

    it("Includes a matter whose date range covers the given reference date.", async () => {
        const matter = makeMatter({ dateRangeStart: new Date("2020-01-01"), dateRangeEnd: new Date("2025-01-01") });
        const repo = { find: vi.fn().mockResolvedValue([matter]) };

        const result = await findActiveHoldsFor(repo as any, "mailbox-1", new Date("2021-06-01"));

        expect(result).toEqual([matter]);
    });

    it("Reads a stored date range given as strings, and still holds when a bound can't be read at all.", async () => {
        const asStrings = makeMatter({ dateRangeStart: "2020-01-01T00:00:00.000Z", dateRangeEnd: "2025-01-01T00:00:00.000Z" });
        const unreadable = makeMatter({ uid: "matter-2", dateRangeStart: "not a date", dateRangeEnd: undefined });
        const repo = { find: vi.fn().mockResolvedValue([asStrings, unreadable]) };

        expect(await findActiveHoldsFor(repo as any, "mailbox-1", new Date("2021-06-01"))).toEqual([asStrings, unreadable]);
        // Outside the readable range only the matter whose range can't be read (it fails closed) still holds.
        expect(await findActiveHoldsFor(repo as any, "mailbox-1", new Date("2026-06-01"))).toEqual([unreadable]);
        const index = await loadLegalHoldIndex(repo as any);
        expect(index.isHeld("mailbox-1", new Date("2026-06-01"))).toBe(true);
    });

    it("Returns every matching open matter, not just the first.", async () => {
        const matterA = makeMatter({ uid: "matter-a" });
        const matterB = makeMatter({ uid: "matter-b" });
        const repo = { find: vi.fn().mockResolvedValue([matterA, matterB]) };

        const result = await findActiveHoldsFor(repo as any, "mailbox-1");

        expect(result.map((m) => m.uid).sort()).toEqual(["matter-a", "matter-b"]);
    });

    // A bare, unpaginated `find()` silently truncates at the framework's default limit (100 rows) - see
    // DataExportJob.findAllPages()'s identical rationale. This proves findActiveHoldsFor() walks every
    // page rather than trusting a single call, by returning a hold-matching matter ONLY on a page past
    // where a naive single-call implementation would have stopped looking.
    it("Detects a hold on a matter beyond the first page, proving the query is paginated.", async () => {
        const pageSize = 500;
        const heldMatter = makeMatter({ uid: "matter-late", custodianMailboxUids: ["mailbox-1"] });
        const firstPage = Array.from({ length: pageSize }, (_, i) =>
            makeMatter({ uid: `matter-page0-${String(i).padStart(4, "0")}`, custodianMailboxUids: ["someone-else"] }),
        );
        const find = vi.fn().mockImplementation(async (criteria: any) => {
            if (criteria.uid === undefined) {
                return firstPage;
            }
            if (criteria.uid === `gt(${firstPage[pageSize - 1].uid})`) {
                return [heldMatter];
            }
            return [];
        });
        const repo = { find };

        const result = await findActiveHoldsFor(repo as any, "mailbox-1");

        expect(result.map((m) => m.uid)).toEqual(["matter-late"]);
        // Page 1 returns fewer than `pageSize` rows, so the loop correctly stops there without a 3rd call.
        expect(find).toHaveBeenCalledTimes(2);
        // Keyset-paged on a stable uid sort, not unsorted offset paging.
        for (const [criteria, options] of find.mock.calls) {
            expect(criteria.sort).toEqual({ uid: "ASC" });
            expect(criteria.page).toBeUndefined();
            expect(options.page).toBeUndefined();
        }
    });
});

describe("assertNotOnLegalHold() Tests", () => {
    it("Resolves without throwing when no hold matches.", async () => {
        const repo = { find: vi.fn().mockResolvedValue([]) };

        await expect(assertNotOnLegalHold(repo as any, "mailbox-1")).resolves.toBeUndefined();
    });

    it("Names every blocking matter in the 409, and passes for another mailbox or a reference date outside every range.", async () => {
        const repo = { find: vi.fn().mockResolvedValue([makeMatter({ uid: "matter-1" }), makeMatter({ uid: "m2" })]) };

        await expect(assertNotOnLegalHold(repo as any, "mailbox-1")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("matter-1, m2") });
        await expect(assertNotOnLegalHold(repo as any, "someone-else")).resolves.toBeUndefined();
        await expect(assertNotOnLegalHold(repo as any, "mailbox-1", new Date("2040-01-01"))).resolves.toBeUndefined();
    });

    it("Throws, naming the blocking matter, when an active hold matches.", async () => {
        const repo = { find: vi.fn().mockResolvedValue([makeMatter({ uid: "matter-1" })]) };

        await expect(assertNotOnLegalHold(repo as any, "mailbox-1")).rejects.toThrow(/matter-1/);
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

        const index = await loadLegalHoldIndex(repo as any);

        expect([...index.heldMailboxUids].sort()).toEqual(["both", "held"]);
        expect(index.isHeld("held")).toBe(true);
        expect(index.isHeld("held", new Date("2020-06-01"))).toBe(true);
        expect(index.isHeld("held", new Date("2021-06-01"))).toBe(false);
        expect(index.isHeld("closed-only")).toBe(false);
        expect(index.isHeld("nobody", new Date("2020-06-01"))).toBe(false);
    });
});
