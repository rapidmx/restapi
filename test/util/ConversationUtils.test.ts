///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { createHash } from "crypto";
import {
    boundIndexedValue,
    conversationAncestorIds,
    deriveConversationId,
    findThreadConversationId,
    MAX_CONVERSATION_ANCESTORS,
    MAX_INDEXED_VALUE_LENGTH,
    resolveConversationId,
} from "../../src/util/ConversationUtils.js";

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

describe("conversationAncestorIds() Tests", () => {
    it("Lists the direct parent first, then references newest to oldest.", () => {
        expect(conversationAncestorIds(["root@example.com", "second@example.com"], "second@example.com")).toEqual([
            "second@example.com",
            "root@example.com",
        ]);
    });

    it("Works from references alone, and from inReplyTo alone.", () => {
        expect(conversationAncestorIds(["root@example.com", "second@example.com"], undefined)).toEqual([
            "second@example.com",
            "root@example.com",
        ]);
        expect(conversationAncestorIds([], "parent@example.com")).toEqual(["parent@example.com"]);
    });

    it("Is empty for a message that replies to nothing, and ignores blank entries.", () => {
        expect(conversationAncestorIds([], undefined)).toEqual([]);
        expect(conversationAncestorIds(["", "   "], "  ")).toEqual([]);
        expect(conversationAncestorIds([], 5 as any)).toEqual([]);
    });

    it("Trims each entry and never repeats one.", () => {
        expect(conversationAncestorIds([" a@example.com ", "b@example.com", "a@example.com"], " b@example.com ")).toEqual([
            "b@example.com",
            "a@example.com",
        ]);
    });

    it("Bounds every entry the way Message.messageId is stored, and caps how many it reports.", () => {
        const long: string = `${"r".repeat(400)}@example.com`;
        expect(conversationAncestorIds([long], undefined)).toEqual([boundIndexedValue(long)]);
        const many: string[] = Array.from({ length: MAX_CONVERSATION_ANCESTORS + 5 }, (_, i) => `r${i}@example.com`);
        const ancestors: string[] = conversationAncestorIds(many, "parent@example.com");
        expect(ancestors).toHaveLength(MAX_CONVERSATION_ANCESTORS);
        expect(ancestors[0]).toBe("parent@example.com");
        expect(ancestors[1]).toBe(`r${many.length - 1}@example.com`);
    });
});

describe("findThreadConversationId() Tests", () => {
    const repo = (rows: { messageId?: string; conversationId?: string }[]) => ({
        queries: [] as any[],
        async find(query: any, options: any) {
            this.queries.push({ query, options });
            return rows;
        },
    });

    it("Asks for nothing at all when there are no ancestors.", async () => {
        const messages = repo([]);
        expect(await findThreadConversationId(messages, "mb1", [])).toBeUndefined();
        expect(messages.queries).toHaveLength(0);
    });

    it("Queries the mailbox for every ancestor at once.", async () => {
        const messages = repo([{ messageId: "a@example.com", conversationId: "root@example.com" }]);
        expect(await findThreadConversationId(messages, "mb1", ["a@example.com", "b@example.com"])).toBe("root@example.com");
        expect(messages.queries[0].query.mailboxUid).toBeDefined();
        expect(messages.queries[0].options).toMatchObject({ ignoreACL: true });
    });

    it("Prefers the nearest ancestor, not whichever row the database returned first.", async () => {
        const messages = repo([
            { messageId: "older@example.com", conversationId: "other@example.com" },
            { messageId: "nearest@example.com", conversationId: "root@example.com" },
        ]);
        expect(await findThreadConversationId(messages, "mb1", ["nearest@example.com", "older@example.com"])).toBe("root@example.com");
    });

    it("Ignores a matching row that has no conversation of its own.", async () => {
        const messages = repo([
            { messageId: "nearest@example.com" },
            { messageId: "older@example.com", conversationId: "root@example.com" },
        ]);
        expect(await findThreadConversationId(messages, "mb1", ["nearest@example.com", "older@example.com"])).toBe("root@example.com");
    });

    it("Reports nothing when the mailbox holds none of the ancestors.", async () => {
        expect(await findThreadConversationId(repo([]), "mb1", ["a@example.com"])).toBeUndefined();
        expect(await findThreadConversationId(repo([{ messageId: "z@example.com", conversationId: "z" }]), "mb1", ["a@example.com"])).toBeUndefined();
    });
});

describe("resolveConversationId() Tests", () => {
    it("Joins the conversation an ancestor is already filed under.", async () => {
        const seen: string[][] = [];
        const id: string = await resolveConversationId(["root@example.com"], "root@example.com", "self@example.com", async (ancestors) => {
            seen.push(ancestors);
            return "thread-1@example.com";
        });
        expect(id).toBe("thread-1@example.com");
        expect(seen).toEqual([["root@example.com"]]);
    });

    it("Falls back to the headers when the mailbox holds no ancestor - including a deeper chain's parent.", async () => {
        expect(await resolveConversationId(["root@example.com", "second@example.com"], "second@example.com", "self@example.com", async () => undefined)).toBe(
            "root@example.com",
        );
        expect(await resolveConversationId([], "parent@example.com", "self@example.com", async () => undefined)).toBe("parent@example.com");
    });

    it("Never looks anything up for a message that replies to nothing - it starts its own conversation.", async () => {
        let asked = false;
        const id: string = await resolveConversationId([], undefined, "self@example.com", async () => {
            asked = true;
            return "should-not-be-used";
        });
        expect(id).toBe("self@example.com");
        expect(asked).toBe(false);
    });

    it("Bounds a conversation id the lookup returns, so it matches the stored value.", async () => {
        const long: string = `${"c".repeat(400)}@example.com`;
        expect(await resolveConversationId([], "parent@example.com", "self@example.com", async () => long)).toBe(boundIndexedValue(long));
    });
});
