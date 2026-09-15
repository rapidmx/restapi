///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    DIRECTORY_DEFAULT_LIMIT,
    DIRECTORY_MAX_LIMIT,
    DIRECTORY_MAX_TERMS,
    directoryNameWords,
    escapeDirectoryLike,
    escapeDirectoryRegExp,
    matchesDirectoryTerms,
    parseDirectoryQuery,
    rankDirectoryEntries,
} from "../../src/routes/BaseDirectoryRoute.js";

describe("BaseDirectoryRoute helpers", () => {
    it("parses a query into distinct lowercase terms and a capped limit", () => {
        expect(parseDirectoryQuery("  Alice  JOHNSON alice ", undefined)).toEqual({ terms: ["alice", "johnson"], text: "alice  johnson alice", limit: DIRECTORY_DEFAULT_LIMIT });
        expect(parseDirectoryQuery("ab", "")).toMatchObject({ limit: DIRECTORY_DEFAULT_LIMIT });
        expect(parseDirectoryQuery("ab", "5")).toMatchObject({ limit: 5 });
        expect(parseDirectoryQuery("ab", 7)).toMatchObject({ limit: 7 });
        expect(parseDirectoryQuery("ab", "999999")).toMatchObject({ limit: DIRECTORY_MAX_LIMIT });
        expect(parseDirectoryQuery("a b c d e f g", undefined).terms).toHaveLength(DIRECTORY_MAX_TERMS);
    });

    it("refuses anything but one string query of a sensible length and a positive integer limit", () => {
        for (const q of [undefined, ["ab", "cd"], 12, "a", " a ", "x".repeat(101)]) {
            expect(() => parseDirectoryQuery(q, undefined)).toThrow();
        }
        for (const limit of ["0", "-1", "1.5", "1e3", "1234567", 0, 2.5, {}, ["3"]]) {
            expect(() => parseDirectoryQuery("ab", limit)).toThrow(/limit/);
        }
    });

    it("splits names into words on spaces and hyphens and matches every term", () => {
        expect(directoryNameWords("Jean-Philippe  Steinmetz", undefined, "")).toEqual(["jean", "philippe", "steinmetz"]);
        const words = directoryNameWords("Jean-Philippe Steinmetz");
        expect(matchesDirectoryTerms(["phil", "stein"], words, "jp@example.com")).toBe(true);
        expect(matchesDirectoryTerms(["jp@ex"], words, "JP@example.com")).toBe(true);
        expect(matchesDirectoryTerms(["phil", "smith"], words, "jp@example.com")).toBe(false);
        expect(matchesDirectoryTerms(["hilippe"], words, "jp@example.com")).toBe(false);
    });

    it("escapes regular expression and LIKE syntax", () => {
        const source = escapeDirectoryRegExp("(a+)+$.*[x]{2}|\\^?");
        expect(new RegExp(`^${source}$`).test("(a+)+$.*[x]{2}|\\^?")).toBe(true);
        expect(escapeDirectoryLike("50%_\\")).toBe("50\\%\\_\\\\");
    });

    it("ranks entries starting with the whole query first, de-duplicates addresses and keeps the limit", () => {
        const entries = [
            { displayName: "Bob Jones", address: "bob@example.com", kind: "user" as const },
            { displayName: "jo Zimmer", address: "zim@example.com", kind: "user" as const },
            { displayName: "Joan", address: "BOB@example.com", kind: "contact" as const },
            { displayName: "Anna", address: "jo@example.com", kind: "list" as const },
            { displayName: "Anna", address: "a@example.com", kind: "list" as const },
        ];
        expect(rankDirectoryEntries(entries, "jo", 10).map((entry) => entry.address)).toEqual([
            "jo@example.com",
            "zim@example.com",
            "BOB@example.com",
            "a@example.com",
        ]);
        expect(rankDirectoryEntries(entries, "jo", 2)).toHaveLength(2);
    });
});
