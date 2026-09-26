///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    changeMailboxSenderList,
    evaluateSenderLists,
    MAX_FILTER_SENDER_ENTRIES,
    MAX_SENDER_ENTRY_LENGTH,
    MAX_SENDER_LIST_ENTRIES,
    moveSenderEntry,
    normalizeFilterSenderList,
    normalizeSenderList,
    parseSenderAddress,
    parseSenderDomain,
    parseSenderEntry,
    SENDER_LIST_MAX_ATTEMPTS,
    senderDomainOf,
    senderEntryMatches,
    senderListMatches,
} from "../../src/util/SenderListUtils.js";

describe("parseSenderDomain() Tests", () => {
    it.each([
        ["example.com", "example.com"],
        ["  @Example.COM ", "example.com"],
        ["mail.example.co.uk", "mail.example.co.uk"],
        ["xn--bcher-kva.example", "xn--bcher-kva.example"],
    ])("Reads %j as %j.", (input, expected) => {
        expect(parseSenderDomain(input)).toBe(expected);
    });

    it.each([
        [undefined],
        [42],
        [""],
        ["@"],
        ["localhost"],
        ["-bad.example"],
        ["bad-.example"],
        ["a b.example"],
        ["user@example.com"],
        ["@@example.com"],
        ["exa_mple.com"],
        ["example..com"],
        [`${"a".repeat(64)}.example`],
        [`${"a".repeat(MAX_SENDER_ENTRY_LENGTH)}.com`],
    ])("Refuses %j.", (input) => {
        expect(parseSenderDomain(input)).toBeUndefined();
    });
});

describe("parseSenderAddress() Tests", () => {
    it("Lowercases and trims a plain address.", () => {
        expect(parseSenderAddress("  Ann@Example.COM ")).toBe("ann@example.com");
    });

    it.each([
        [undefined],
        [7],
        [""],
        ["ann"],
        ["Ann <ann@example.com>"],
        ["<ann@example.com>"],
        ['"ann"@example.com'],
        ["a@b@example.com"],
        ["ann@example.com, bob@example.com"],
        ["ann example@example.com"],
        [`${"a".repeat(MAX_SENDER_ENTRY_LENGTH)}@example.com`],
    ])("Refuses %j.", (input) => {
        expect(parseSenderAddress(input)).toBeUndefined();
    });

    it("Accepts an address of exactly the maximum length.", () => {
        const address = `${"a".repeat(MAX_SENDER_ENTRY_LENGTH - "@example.com".length)}@example.com`;

        expect(address).toHaveLength(MAX_SENDER_ENTRY_LENGTH);
        expect(parseSenderAddress(address)).toBe(address);
    });
});

describe("parseSenderEntry() Tests", () => {
    it.each([
        ["ann@example.com", "ann@example.com"],
        ["ANN@Example.com", "ann@example.com"],
        ["@example.com", "@example.com"],
        ["example.com", "@example.com"],
        [" Example.COM ", "@example.com"],
    ])("Reads %j as %j.", (input, expected) => {
        expect(parseSenderEntry(input)).toBe(expected);
    });

    it.each([[undefined], [null], [{}], [""], ["@@x.com"], ["not an entry"], ["ann@"], ["x@y@z.com"], ["localhost"]])("Refuses %j.", (input) => {
        expect(parseSenderEntry(input)).toBeUndefined();
    });
});

describe("senderDomainOf() and senderEntryMatches() Tests", () => {
    it("Finds the domain after the last @, lowercased.", () => {
        expect(senderDomainOf("ann@Example.com")).toBe("example.com");
        expect(senderDomainOf(undefined)).toBeUndefined();
        expect(senderDomainOf("no-at-sign")).toBeUndefined();
        expect(senderDomainOf("trailing@")).toBeUndefined();
    });

    it("Matches an address entry exactly, ignoring case and never as a substring.", () => {
        expect(senderEntryMatches("ann@x.com", "Ann@X.com")).toBe(true);
        expect(senderEntryMatches("ann@x.com", "joann@x.com")).toBe(false);
        expect(senderEntryMatches("ann@x.com", "ann@x.com.evil.example")).toBe(false);
    });

    it("Matches a domain entry against the exact domain only.", () => {
        expect(senderEntryMatches("@x.com", "anyone@X.com")).toBe(true);
        expect(senderEntryMatches("@x.com", "anyone@mail.x.com")).toBe(false);
        expect(senderEntryMatches("@x.com", "anyone@notx.com")).toBe(false);
        expect(senderEntryMatches("@x.com", "no-at-sign")).toBe(false);
    });
});

describe("senderListMatches() Tests", () => {
    it("Is true when any entry names any candidate, and ignores empty candidates and a missing list.", () => {
        expect(senderListMatches(["ann@x.com", "@y.com"], [undefined, "", "bob@y.com"])).toBe(true);
        expect(senderListMatches(["ann@x.com"], ["bob@y.com", null])).toBe(false);
        expect(senderListMatches(null, ["ann@x.com"])).toBe(false);
        expect(senderListMatches(undefined, ["ann@x.com"])).toBe(false);
        expect(senderListMatches(["ann@x.com"], [])).toBe(false);
    });
});

describe("normalizeSenderList() Tests", () => {
    it("Canonicalizes each entry and removes repeats, keeping the first appearance's order.", () => {
        expect(normalizeSenderList(["B@x.com", "example.com", "@Example.com", "b@x.com", " a@x.com "], "blockedSenders")).toEqual([
            "b@x.com",
            "@example.com",
            "a@x.com",
        ]);
    });

    it("Accepts an empty list.", () => {
        expect(normalizeSenderList([], "safeSenders")).toEqual([]);
    });

    it.each([["nope"], [undefined], [null], [{}], [[42]], [["ok@x.com", "not an entry"]]])("Refuses %j with a 400 naming the field.", (input) => {
        expect(() => normalizeSenderList(input, "safeSenders")).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining("safeSenders") }));
    });

    it("Accepts exactly the maximum number of distinct entries and refuses one more.", () => {
        const entries = Array.from({ length: MAX_SENDER_LIST_ENTRIES }, (_, i) => `user${i}@x.com`);

        expect(normalizeSenderList(entries, "blockedSenders")).toHaveLength(MAX_SENDER_LIST_ENTRIES);
        expect(() => normalizeSenderList([...entries, "one-more@x.com"], "blockedSenders")).toThrow(expect.objectContaining({ status: 400 }));
    });

    it("Counts entries after removing repeats.", () => {
        const entries = Array.from({ length: MAX_SENDER_LIST_ENTRIES }, (_, i) => `user${i}@x.com`);

        expect(normalizeSenderList([...entries, ...entries], "blockedSenders")).toHaveLength(MAX_SENDER_LIST_ENTRIES);
    });

    it("Refuses a body far past the cap without reading it.", () => {
        expect(() => normalizeSenderList(new Array(MAX_SENDER_LIST_ENTRIES * 4 + 1).fill("a@x.com"), "blockedSenders")).toThrow(
            expect.objectContaining({ status: 400 }),
        );
    });
});

describe("normalizeFilterSenderList() Tests", () => {
    it("Normalizes addresses and domains, dropping repeats and the domain's @.", () => {
        expect(normalizeFilterSenderList(["Ann@X.com", "ann@x.com"], "fromEquals", "address")).toEqual(["ann@x.com"]);
        expect(normalizeFilterSenderList(["@X.com", "x.com", "y.com"], "fromDomainEquals", "domain")).toEqual(["x.com", "y.com"]);
    });

    it("Refuses a non-array, a bad address, a bad domain and an address given as a domain.", () => {
        expect(() => normalizeFilterSenderList("ann@x.com", "fromEquals", "address")).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining("addresses") }));
        expect(() => normalizeFilterSenderList("x.com", "fromDomainEquals", "domain")).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining("domains") }));
        expect(() => normalizeFilterSenderList(["Ann <ann@x.com>"], "fromEquals", "address")).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining("plain address") }));
        expect(() => normalizeFilterSenderList(["x.com"], "fromEquals", "address")).toThrow(expect.objectContaining({ status: 400 }));
        expect(() => normalizeFilterSenderList(["ann@x.com"], "fromDomainEquals", "domain")).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining("domain") }));
    });

    it("Bounds the number of entries.", () => {
        const entries = Array.from({ length: MAX_FILTER_SENDER_ENTRIES }, (_, i) => `user${i}@x.com`);

        expect(normalizeFilterSenderList(entries, "fromEquals", "address")).toHaveLength(MAX_FILTER_SENDER_ENTRIES);
        expect(() => normalizeFilterSenderList([...entries, "more@x.com"], "fromEquals", "address")).toThrow(expect.objectContaining({ status: 400 }));
        expect(() => normalizeFilterSenderList(new Array(MAX_FILTER_SENDER_ENTRIES * 4 + 1).fill("a@x.com"), "fromEquals", "address")).toThrow(
            expect.objectContaining({ status: 400 }),
        );
    });
});

describe("moveSenderEntry() Tests", () => {
    it("Adds to one list and takes the entry off the other, without touching its arguments.", () => {
        const lists = { blockedSenders: ["a@x.com"], safeSenders: ["b@x.com", "c@x.com"] };

        const change = moveSenderEntry(lists, "blockedSenders", "b@x.com", true);

        expect(change).toEqual({ blockedSenders: ["a@x.com", "b@x.com"], safeSenders: ["c@x.com"], changed: true });
        expect(lists).toEqual({ blockedSenders: ["a@x.com"], safeSenders: ["b@x.com", "c@x.com"] });
    });

    it("Adds to the safe list the same way.", () => {
        expect(moveSenderEntry({ blockedSenders: ["a@x.com"], safeSenders: [] }, "safeSenders", "a@x.com", true)).toEqual({
            blockedSenders: [],
            safeSenders: ["a@x.com"],
            changed: true,
        });
    });

    it("Changes nothing when the entry is already on the list and on no other.", () => {
        expect(moveSenderEntry({ blockedSenders: ["a@x.com"], safeSenders: [] }, "blockedSenders", "a@x.com", true).changed).toBe(false);
    });

    it("Treats a missing list (a SQL row from before the columns) as empty.", () => {
        expect(moveSenderEntry({ blockedSenders: null }, "blockedSenders", "a@x.com", true)).toEqual({ blockedSenders: ["a@x.com"], safeSenders: [], changed: true });
    });

    it("Removes an entry from the named list only, and reports nothing changed for an absent one.", () => {
        const lists = { blockedSenders: ["a@x.com"], safeSenders: ["a@x.com"] };

        expect(moveSenderEntry(lists, "blockedSenders", "a@x.com", false)).toEqual({ blockedSenders: [], safeSenders: ["a@x.com"], changed: true });
        expect(moveSenderEntry(lists, "blockedSenders", "z@x.com", false).changed).toBe(false);
    });

    it("Refuses an addition past the cap.", () => {
        const full = Array.from({ length: MAX_SENDER_LIST_ENTRIES }, (_, i) => `user${i}@x.com`);

        expect(() => moveSenderEntry({ blockedSenders: full }, "blockedSenders", "one-more@x.com", true)).toThrow(expect.objectContaining({ status: 400 }));
        expect(moveSenderEntry({ blockedSenders: full }, "blockedSenders", "user1@x.com", true).changed).toBe(false);
    });
});

describe("evaluateSenderLists() Tests", () => {
    const lists = { blockedSenders: ["bad@x.com", "@spam.example"], safeSenders: ["good@x.com", "@friends.example"] };

    it("Blocks on the From address or the envelope sender.", () => {
        expect(evaluateSenderLists(lists, "bad@x.com", "other@y.com").blocked).toBe(true);
        expect(evaluateSenderLists(lists, "other@y.com", "anyone@spam.example").blocked).toBe(true);
        expect(evaluateSenderLists(lists, "other@y.com", undefined).blocked).toBe(false);
    });

    it("Marks safe on the From address only.", () => {
        expect(evaluateSenderLists(lists, "GOOD@x.com", undefined).safe).toBe(true);
        expect(evaluateSenderLists(lists, "anyone@friends.example", "z@z.com").safe).toBe(true);
        expect(evaluateSenderLists(lists, "other@y.com", "good@x.com").safe).toBe(false);
        expect(evaluateSenderLists(lists, undefined, "good@x.com").safe).toBe(false);
    });

    it("Finds nothing in a mailbox with no lists.", () => {
        expect(evaluateSenderLists({ blockedSenders: null }, "bad@x.com", "bad@x.com")).toEqual({ blocked: false, safe: false });
    });
});

describe("changeMailboxSenderList() Tests", () => {
    /** A fake repository over one stored row, with an optional number of version conflicts to lose first. */
    function fakeRepo(row: any | undefined, conflicts: number = 0, error?: any) {
        let remaining = conflicts;
        const repo: any = {
            row,
            findOne: vi.fn(async () => (repo.row ? { ...repo.row } : undefined)),
            update: vi.fn(async (patch: any) => {
                if (error) {
                    throw error;
                }
                if (remaining > 0) {
                    remaining--;
                    repo.row = { ...repo.row, blockedSenders: [...repo.row.blockedSenders, `raced${remaining}@x.com`], version: repo.row.version + 1 };
                    throw Object.assign(new Error("conflict"), { status: 409 });
                }
                repo.row = { ...repo.row, ...patch, version: repo.row.version + 1 };
                return repo.row;
            }),
        };
        return repo;
    }

    const stored = () => ({ uid: "m1", version: 3, blockedSenders: ["a@x.com"], safeSenders: ["z@x.com"] });

    it("Writes the change with the row's version.", async () => {
        const repo = fakeRepo(stored());

        const change = await changeMailboxSenderList(repo, "m1", "safeSenders", "a@x.com", true);

        expect(change).toEqual({ blockedSenders: [], safeSenders: ["z@x.com", "a@x.com"], changed: true });
        expect(repo.update).toHaveBeenCalledWith(
            { uid: "m1", version: 3, blockedSenders: [], safeSenders: ["z@x.com", "a@x.com"] },
            expect.anything(),
            { ignoreACL: true },
        );
    });

    it("Writes nothing when nothing changes, and answers undefined for a mailbox that is not there.", async () => {
        const repo = fakeRepo(stored());

        expect((await changeMailboxSenderList(repo, "m1", "blockedSenders", "a@x.com", true))!.changed).toBe(false);
        expect(repo.update).not.toHaveBeenCalled();
        expect(await changeMailboxSenderList(fakeRepo(undefined), "m1", "blockedSenders", "a@x.com", true)).toBeUndefined();
    });

    it("Re-reads and applies the change to what a concurrent write left, so neither is lost.", async () => {
        const repo = fakeRepo(stored(), 2);

        const change = await changeMailboxSenderList(repo, "m1", "blockedSenders", "new@x.com", true);

        expect(change!.blockedSenders).toEqual(["a@x.com", "raced1@x.com", "raced0@x.com", "new@x.com"]);
        expect(repo.update).toHaveBeenCalledTimes(3);
    });

    it("Gives up with a 409 after the maximum number of lost races.", async () => {
        const repo = fakeRepo(stored(), 100);

        await expect(changeMailboxSenderList(repo, "m1", "blockedSenders", "new@x.com", true)).rejects.toMatchObject({ status: 409 });
        expect(repo.update).toHaveBeenCalledTimes(SENDER_LIST_MAX_ATTEMPTS);
    });

    it("Passes any other write failure through.", async () => {
        const repo = fakeRepo(stored(), 0, Object.assign(new Error("disk"), { status: 500 }));

        await expect(changeMailboxSenderList(repo, "m1", "blockedSenders", "new@x.com", true)).rejects.toThrow("disk");
        expect(repo.update).toHaveBeenCalledTimes(1);
    });
});
