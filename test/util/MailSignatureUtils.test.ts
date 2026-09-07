///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { resolveDefaultSignature } from "../../src/util/MailSignatureUtils.js";
import { MailSignature } from "../../src/models/types.js";

function makeSignature(overrides: Partial<MailSignature> = {}): MailSignature {
    return {
        uid: "sig-1",
        version: 0,
        dateCreated: new Date(),
        dateModified: new Date(),
        mailboxUid: "mbx-1",
        name: "Signature",
        contentHtml: "<p>Signature</p>",
        isDefaultForNewMessages: false,
        isDefaultForReplyForward: false,
        ...overrides,
    };
}

describe("resolveDefaultSignature() Tests", () => {
    it("Returns undefined when no signature is marked default for the given context.", () => {
        expect(resolveDefaultSignature([makeSignature()], "new")).toBeUndefined();
        expect(resolveDefaultSignature([makeSignature()], "reply_forward")).toBeUndefined();
    });

    it("Returns the signature marked isDefaultForNewMessages for context 'new'.", () => {
        const signature = makeSignature({ name: "Work", isDefaultForNewMessages: true });
        const result = resolveDefaultSignature([makeSignature({ name: "Other" }), signature], "new");
        expect(result).toBe(signature);
    });

    it("Returns the signature marked isDefaultForReplyForward for context 'reply_forward'.", () => {
        const signature = makeSignature({ name: "Short", isDefaultForReplyForward: true });
        const result = resolveDefaultSignature([makeSignature({ name: "Other" }), signature], "reply_forward");
        expect(result).toBe(signature);
    });

    it("Returns undefined for an empty signature list.", () => {
        expect(resolveDefaultSignature([], "new")).toBeUndefined();
    });
});
