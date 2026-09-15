///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as util from "../../src/util/index.js";
import {
    MAX_RETAINED_BODY_BLOB_KEYS,
    RETAINED_BODY_BLOB_KEY_PREFIX,
    retainedBodyBlobKeysOf,
    withRetainedBodyBlobKey,
} from "../../src/util/DraftBodyRetentionUtils.js";

describe("DraftBodyRetentionUtils Tests", () => {
    it("retainedBodyBlobKeysOf() keeps only distinct body-prefixed string keys, in order.", () => {
        expect(RETAINED_BODY_BLOB_KEY_PREFIX).toBe("bodies/");
        expect(retainedBodyBlobKeysOf(undefined)).toEqual([]);
        expect(retainedBodyBlobKeysOf({ retainedBodyBlobKeys: null })).toEqual([]);
        expect(retainedBodyBlobKeysOf({ retainedBodyBlobKeys: "bodies/a" as any })).toEqual([]);
        expect(retainedBodyBlobKeysOf({ retainedBodyBlobKeys: ["bodies/b", 42, "attachments/x", "bodies/", "bodies/a", "bodies/b"] as any })).toEqual([
            "bodies/b",
            "bodies/a",
        ]);
    });

    it("withRetainedBodyBlobKey() appends a replaced body key once, ignores other keys, and refuses (409) past the bound.", () => {
        expect(withRetainedBodyBlobKey({}, "bodies/1")).toEqual(["bodies/1"]);
        expect(withRetainedBodyBlobKey({ retainedBodyBlobKeys: ["bodies/1"] }, "bodies/2")).toEqual(["bodies/1", "bodies/2"]);
        expect(withRetainedBodyBlobKey({ retainedBodyBlobKeys: ["bodies/1"] }, "bodies/1")).toEqual(["bodies/1"]);
        for (const other of [undefined, null, "", "imported/1", "ingest/1"]) {
            expect(withRetainedBodyBlobKey({ retainedBodyBlobKeys: ["bodies/1"] }, other)).toEqual(["bodies/1"]);
        }
        const full = { retainedBodyBlobKeys: Array.from({ length: MAX_RETAINED_BODY_BLOB_KEYS }, (_, i) => `bodies/${i}`) };
        expect(() => withRetainedBodyBlobKey(full, "bodies/next")).toThrow(expect.objectContaining({ status: 409 }));
        // A key already kept is still fine at the bound.
        expect(withRetainedBodyBlobKey(full, "bodies/0")).toHaveLength(MAX_RETAINED_BODY_BLOB_KEYS);
    });

    it("is exported from the util barrel.", () => {
        expect(util.withRetainedBodyBlobKey).toBe(withRetainedBodyBlobKey);
        expect(util.MAX_RETAINED_BODY_BLOB_KEYS).toBe(500);
    });
});
