///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { DEFAULT_REQUEST_LIST_LIMIT, MAX_REQUEST_LIST_LIMIT, parseListPaging } from "../../src/util/RequestListUtils.js";

describe("RequestListUtils Tests", () => {
    it("parseListPaging() defaults, caps and accepts numbers or numeric strings.", () => {
        expect(parseListPaging(undefined)).toEqual({ limit: DEFAULT_REQUEST_LIST_LIMIT, page: 0 });
        expect(parseListPaging({ limit: "", page: "" })).toEqual({ limit: DEFAULT_REQUEST_LIST_LIMIT, page: 0 });
        expect(parseListPaging({ limit: "25", page: "3" })).toEqual({ limit: 25, page: 3 });
        expect(parseListPaging({ limit: 10, page: 0 })).toEqual({ limit: 10, page: 0 });
        expect(parseListPaging({ limit: "100000" })).toEqual({ limit: MAX_REQUEST_LIST_LIMIT, page: 0 });
    });

    it("parseListPaging() rejects zero, negative, fractional, non-numeric and repeated values (400).", () => {
        for (const query of [{ limit: "0" }, { limit: 0 }, { limit: "-1" }, { limit: "1.5" }, { limit: 2.5 }, { page: "x" }, { page: ["1", "2"] }, { limit: {} }]) {
            expect(() => parseListPaging(query)).toThrow();
        }
    });
});
