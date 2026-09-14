///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { createHash } from "crypto";
import { boundIndexedValue, deriveConversationId, MAX_INDEXED_VALUE_LENGTH } from "../../src/util/ConversationUtils.js";

describe("deriveConversationId() Tests", () => {
    it("Uses the oldest entry in references (index 0) when present, regardless of inReplyTo.", () => {
        expect(deriveConversationId(["root@example.com", "second@example.com"], "second@example.com", "self@example.com")).toBe(
            "root@example.com",
        );
    });

    it("Falls back to inReplyTo when references is empty.", () => {
        expect(deriveConversationId([], "parent@example.com", "self@example.com")).toBe("parent@example.com");
    });

    it("Falls back to the message's own messageId when both references and inReplyTo are absent.", () => {
        expect(deriveConversationId([], undefined, "self@example.com")).toBe("self@example.com");
    });
});

describe("boundIndexedValue() Tests", () => {
    const sha256 = (value: string): string => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

    it("Returns values up to the limit unchanged, and null/undefined as-is.", () => {
        const atLimit: string = "x".repeat(MAX_INDEXED_VALUE_LENGTH);
        expect(boundIndexedValue(atLimit)).toBe(atLimit);
        expect(boundIndexedValue("")).toBe("");
        expect(boundIndexedValue(undefined)).toBeUndefined();
        expect(boundIndexedValue(null)).toBeNull();
    });

    it("Replaces a longer value with its SHA-256, deterministically and idempotently.", () => {
        const long: string = "é".repeat(MAX_INDEXED_VALUE_LENGTH + 1);
        const bounded: string = boundIndexedValue(long);
        expect(bounded).toBe(sha256(long));
        expect(bounded.length).toBeLessThanOrEqual(MAX_INDEXED_VALUE_LENGTH);
        expect(boundIndexedValue(bounded)).toBe(bounded);
        expect(boundIndexedValue(`${long}z`)).not.toBe(bounded);
    });

    it("deriveConversationId() bounds an over-long root id the same way.", () => {
        const long: string = `${"r".repeat(400)}@example.com`;
        expect(deriveConversationId([long], undefined, "self@example.com")).toBe(boundIndexedValue(long));
        expect(deriveConversationId([], long, "self@example.com")).toBe(sha256(long));
        expect(deriveConversationId([], undefined, long)).toBe(sha256(long));
    });
});
