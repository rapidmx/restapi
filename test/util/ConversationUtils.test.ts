///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { deriveConversationId } from "../../src/util/ConversationUtils.js";

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
