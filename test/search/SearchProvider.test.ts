///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Unit tests for the provider-agnostic paging/truncation helpers exported from SearchProvider.ts.
import {
    DEFAULT_SEARCH_PAGE_SIZE,
    MAX_SEARCH_OFFSET,
    MAX_SEARCH_PAGE_SIZE,
    nextSearchCursor,
    resolveSearchPaging,
    truncateSearchDocumentText,
    type SearchDocument,
} from "../../src/search/SearchProvider.js";

const baseDoc: SearchDocument = { entityType: "message", entityUid: "m", mailboxUid: "mbx" };

describe("SearchProvider helpers", () => {
    describe("resolveSearchPaging()", () => {
        it("Defaults limit and offset when neither is given, or when limit is not a finite number.", () => {
            expect(resolveSearchPaging(undefined, undefined)).toEqual({ limit: DEFAULT_SEARCH_PAGE_SIZE, offset: 0 });
            expect(resolveSearchPaging(NaN, "abc")).toEqual({ limit: DEFAULT_SEARCH_PAGE_SIZE, offset: 0 });
        });

        it("Clamps limit to 1..MAX_SEARCH_PAGE_SIZE and offset to 0..MAX_SEARCH_OFFSET.", () => {
            expect(resolveSearchPaging(0, "-1")).toEqual({ limit: 1, offset: 0 });
            expect(resolveSearchPaging(5000, "99999999")).toEqual({ limit: MAX_SEARCH_PAGE_SIZE, offset: MAX_SEARCH_OFFSET });
            expect(resolveSearchPaging(10.7, "40")).toEqual({ limit: 10, offset: 40 });
        });
    });

    describe("nextSearchCursor()", () => {
        it("Returns the next offset only when there are more results and it stays within MAX_SEARCH_OFFSET.", () => {
            expect(nextSearchCursor(true, 0, 25)).toBe("25");
            expect(nextSearchCursor(false, 0, 25)).toBeUndefined();
            expect(nextSearchCursor(true, MAX_SEARCH_OFFSET - 25, 25)).toBe(String(MAX_SEARCH_OFFSET));
            expect(nextSearchCursor(true, MAX_SEARCH_OFFSET, 25)).toBeUndefined();
        });
    });

    describe("truncateSearchDocumentText()", () => {
        it("Returns the same object when the document is within budget.", () => {
            const doc: SearchDocument = { ...baseDoc, subject: "hi", body: "there", attachmentText: ["x"] };
            expect(truncateSearchDocumentText(doc, 100)).toBe(doc);
        });

        it("Fills subject, then body, then attachment text in order, dropping entries past the budget.", () => {
            const doc: SearchDocument = { ...baseDoc, subject: "abc", body: "defgh", attachmentText: ["ijklm", "nop"] };
            expect(truncateSearchDocumentText(doc, 10)).toEqual({ ...doc, subject: "abc", body: "defgh", attachmentText: ["ij"] });
            expect(truncateSearchDocumentText(doc, 2)).toEqual({ ...doc, subject: "ab", body: "", attachmentText: [] });
        });

        it("Never splits a UTF-16 surrogate pair at the cut point.", () => {
            const doc: SearchDocument = { ...baseDoc, body: "a\u{1F600}b" };
            const result = truncateSearchDocumentText(doc, 2);
            expect(result.body).toBe("a");
        });
    });
});
