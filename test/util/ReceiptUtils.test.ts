///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { simpleParser } from "mailparser";
import { buildDispositionNotification, parseDispositionNotification } from "../../src/util/ReceiptUtils.js";

/** Builds an MDN then runs it back through `mailparser` exactly the way `ScanPipeline` does in production
 * (scan `parsed.attachments` for the `message/disposition-notification` part), returning that part's raw
 * decoded text - the same input `parseDispositionNotification()` receives for real. */
async function buildAndExtractPart(params: Parameters<typeof buildDispositionNotification>[0]): Promise<string> {
    const raw: Buffer = await buildDispositionNotification(params);
    const parsed = await simpleParser(raw);
    const part = parsed.attachments.find((a) => a.contentType === "message/disposition-notification");
    return part!.content.toString("binary");
}

const baseParams = {
    from: { address: "bob@example.com", displayName: "Bob" },
    to: "ada@example.com",
    subject: "Read: Hello",
    finalRecipient: "bob@example.com",
    originalMessageId: "abc123@example.com",
    dispositionType: "read" as const,
    reportingUa: "mail.example.com; RapidMX",
};

describe("buildDispositionNotification() / parseDispositionNotification() round-trip", () => {
    it("Round-trips a read disposition through a real MIME build+parse.", async () => {
        const part = await buildAndExtractPart(baseParams);
        const result = parseDispositionNotification(part);

        expect(result?.originalMessageId).toBe("abc123@example.com");
        expect(result?.finalRecipient).toBe("bob@example.com");
        expect(result?.dispositionType).toBe("read");
    });

    it("Round-trips a delivery disposition.", async () => {
        const part = await buildAndExtractPart({ ...baseParams, dispositionType: "delivery" });
        const result = parseDispositionNotification(part);

        expect(result?.dispositionType).toBe("delivery");
    });

    it("Strips angle brackets from Original-Message-ID and normalizes an already-bracketed input the same way.", async () => {
        const part = await buildAndExtractPart({ ...baseParams, originalMessageId: "<abc123@example.com>" });
        const result = parseDispositionNotification(part);

        expect(result?.originalMessageId).toBe("abc123@example.com");
    });

    it("Normalizes Final-Recipient to lowercase.", async () => {
        const part = await buildAndExtractPart({ ...baseParams, finalRecipient: "Bob@EXAMPLE.com" });
        const result = parseDispositionNotification(part);

        expect(result?.finalRecipient).toBe("bob@example.com");
    });

    it("Builds a From header with a display name.", async () => {
        const raw = await buildDispositionNotification(baseParams);
        expect(raw.toString()).toContain("Bob <bob@example.com>");
    });

    it("Leaves an address-like or multi-line display name out of the From header.", async () => {
        for (const displayName of ["ceo@corp.example", "ceo\uFF20corp.example", "Bob\r\nBcc: x@y"]) {
            const raw = (await buildDispositionNotification({ ...baseParams, from: { address: "bob@example.com", displayName } })).toString();
            expect(raw).toContain("From: bob@example.com");
            expect(raw).not.toContain("corp.example");
            expect(raw).not.toContain("Bcc: x@y");
        }
    });

    it("Builds a From header with no display name.", async () => {
        const raw = await buildDispositionNotification({ ...baseParams, from: { address: "bob@example.com" } });
        expect(raw.toString()).toContain("From: bob@example.com");
    });

    it("Round-trips the Rotation Notification (E5) extension fields when both are set.", async () => {
        const part = await buildAndExtractPart({ ...baseParams, rotatedKeyFingerprint: "aabbcc", policyId: "1" });
        const result = parseDispositionNotification(part);

        expect(result?.rotatedKeyFingerprint).toBe("aabbcc");
        expect(result?.policyId).toBe("1");
    });

    it("Omits both Rotation Notification extension fields when neither is set.", async () => {
        const part = await buildAndExtractPart(baseParams);
        const result = parseDispositionNotification(part);

        expect(result?.rotatedKeyFingerprint).toBeUndefined();
        expect(result?.policyId).toBeUndefined();
        expect(part).not.toContain("X-RapidMX-Key-Fingerprint");
        expect(part).not.toContain("X-RapidMX-Policy-Id");
    });

    it("Emits only the fingerprint extension field when policyId is unset.", async () => {
        const part = await buildAndExtractPart({ ...baseParams, rotatedKeyFingerprint: "aabbcc" });
        const result = parseDispositionNotification(part);

        expect(result?.rotatedKeyFingerprint).toBe("aabbcc");
        expect(result?.policyId).toBeUndefined();
    });
});

describe("parseDispositionNotification() Tests", () => {
    it("Returns undefined when Original-Message-ID is entirely missing.", () => {
        const result = parseDispositionNotification("Final-Recipient: rfc822;bob@example.com\r\nDisposition: automatic-action/MDN-sent-automatically; displayed\r\n");
        expect(result).toBeUndefined();
    });

    it("Omits finalRecipient when Final-Recipient is missing, without invalidating the whole result.", () => {
        const result = parseDispositionNotification("Original-Message-ID: <abc123@example.com>\r\nDisposition: automatic-action/MDN-sent-automatically; displayed\r\n");
        expect(result?.originalMessageId).toBe("abc123@example.com");
        expect(result?.finalRecipient).toBeUndefined();
    });

    it("Omits dispositionType when Disposition is missing entirely.", () => {
        const result = parseDispositionNotification("Original-Message-ID: <abc123@example.com>\r\n");
        expect(result?.dispositionType).toBeUndefined();
    });

    it("Maps every other recognized RFC 3798 disposition-type to 'delivery' under the documented fallback rule.", () => {
        for (const dispositionValue of [
            "manual-action/MDN-sent-manually; deleted",
            "automatic-action/MDN-sent-automatically; dispatched",
            "automatic-action/MDN-sent-automatically; processed",
        ]) {
            const result = parseDispositionNotification(
                `Original-Message-ID: <abc123@example.com>\r\nDisposition: ${dispositionValue}\r\n`,
            );
            expect(result?.dispositionType).toBe("delivery");
        }
    });

    it("Tolerates a real-world MDN shape carrying extra fields this library never generates itself.", () => {
        const result = parseDispositionNotification(
            "Reporting-UA: mail.example.com; Example Corp Mail Server\r\n" +
                "Original-Recipient: rfc822;bob@example.com\r\n" +
                "Final-Recipient: rfc822;Bob Smith <bob@example.com>\r\n" +
                "Original-Message-ID: <xyz789@example.com>\r\n" +
                "Disposition: manual-action/MDN-sent-manually; displayed\r\n" +
                "X-Some-Vendor-Extension: whatever\r\n",
        );

        expect(result?.originalMessageId).toBe("xyz789@example.com");
        expect(result?.finalRecipient).toBe("bob@example.com");
        expect(result?.dispositionType).toBe("read");
    });

    it("Handles a Final-Recipient with no rfc822; type prefix at all, taking the last token as the address.", () => {
        const result = parseDispositionNotification(
            "Original-Message-ID: <abc123@example.com>\r\nFinal-Recipient: bob@example.com\r\n",
        );
        expect(result?.finalRecipient).toBe("bob@example.com");
    });

    it("Parses the X-RapidMX-Key-Fingerprint/X-RapidMX-Policy-Id extension fields when present.", () => {
        const result = parseDispositionNotification(
            "Original-Message-ID: <abc123@example.com>\r\n" +
                "X-RapidMX-Key-Fingerprint: aabbccdd\r\n" +
                "X-RapidMX-Policy-Id: 42\r\n",
        );
        expect(result?.rotatedKeyFingerprint).toBe("aabbccdd");
        expect(result?.policyId).toBe("42");
    });

    it("Leaves rotatedKeyFingerprint/policyId undefined when neither extension field is present.", () => {
        const result = parseDispositionNotification("Original-Message-ID: <abc123@example.com>\r\n");
        expect(result?.rotatedKeyFingerprint).toBeUndefined();
        expect(result?.policyId).toBeUndefined();
    });
});
