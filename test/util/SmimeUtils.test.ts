///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for isEncryptedBody() - exercised against mailparser's real ParsedMail shape (built via
// simpleParser against small hand-built raw MIME messages), same rationale as test/scan/ScanPipeline.test.ts.
import { simpleParser } from "mailparser";
import { isEncryptedBody } from "../../src/util/SmimeUtils.js";

async function parse(contentTypeLine: string, body = "irrelevant body content"): Promise<any> {
    const raw = ["From: sender@example.com", "To: recipient@example.com", "Subject: Test", contentTypeLine, "", body, ""].join(
        "\r\n",
    );
    return await simpleParser(Buffer.from(raw));
}

describe("isEncryptedBody() Tests", () => {
    it("Returns true for application/pkcs7-mime; smime-type=enveloped-data.", async () => {
        const parsed = await parse('Content-Type: application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"');
        expect(isEncryptedBody(parsed)).toBe(true);
    });

    it("Is case-insensitive on both the content type and the smime-type parameter value.", async () => {
        const parsed = await parse("Content-Type: APPLICATION/PKCS7-MIME; smime-type=ENVELOPED-DATA");
        expect(isEncryptedBody(parsed)).toBe(true);
    });

    it("Returns true for multipart/encrypted (OpenPGP/MIME).", async () => {
        const parsed = await parse('Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="B"', "");
        expect(isEncryptedBody(parsed)).toBe(true);
    });

    it("Returns false for application/pkcs7-mime; smime-type=signed-data (opaque signing, not encryption).", async () => {
        const parsed = await parse('Content-Type: application/pkcs7-mime; smime-type=signed-data; name="smime.p7m"');
        expect(isEncryptedBody(parsed)).toBe(false);
    });

    it("Returns false for application/pkcs7-mime with no smime-type parameter at all.", async () => {
        const parsed = await parse('Content-Type: application/pkcs7-mime; name="smime.p7m"');
        expect(isEncryptedBody(parsed)).toBe(false);
    });

    it("Returns false for an ordinary text/plain message.", async () => {
        const parsed = await parse("Content-Type: text/plain; charset=utf-8");
        expect(isEncryptedBody(parsed)).toBe(false);
    });

    it("Returns false for an ordinary text/html message.", async () => {
        const parsed = await parse("Content-Type: text/html; charset=utf-8", "<p>Hello</p>");
        expect(isEncryptedBody(parsed)).toBe(false);
    });

    it("Returns false when there is no Content-Type header at all (mailparser defaults it to text/plain).", async () => {
        const raw = ["From: sender@example.com", "To: recipient@example.com", "Subject: Test", "", "Plain body.", ""].join("\r\n");
        const parsed = await simpleParser(Buffer.from(raw));
        expect(isEncryptedBody(parsed)).toBe(false);
    });
});
