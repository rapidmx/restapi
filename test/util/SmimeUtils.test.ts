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

    const pgpParts = (...types: string[]): string =>
        types.map((type) => `--B\r\nContent-Type: ${type}\r\n\r\nVersion: 1\r\n`).join("") + "--B--";

    it("Returns true for multipart/encrypted (OpenPGP/MIME): the protocol, a control part and the ciphertext.", async () => {
        const header = 'Content-Type: multipart/encrypted; protocol="Application/PGP-Encrypted"; boundary="B"';
        expect(isEncryptedBody(await parse(header, pgpParts("application/pgp-encrypted", "application/octet-stream")))).toBe(true);
        expect(isEncryptedBody(await parse(header, pgpParts("application/octet-stream", "application/pgp-encrypted; name=x")))).toBe(true);
    });

    it("Does not trust a self-declared multipart/encrypted that is not that shape, so it still gets the attachment scan.", async () => {
        const header = 'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="B"';
        // No parts, a readable body beside the ciphertext, an executable instead of ciphertext, an extra part, a wrong protocol.
        expect(isEncryptedBody(await parse(header, ""))).toBe(false);
        expect(isEncryptedBody(await parse(header, pgpParts("application/pgp-encrypted", "application/octet-stream", "text/html")))).toBe(false);
        expect(isEncryptedBody(await parse(header, pgpParts("text/html", "application/x-msdownload")))).toBe(false);
        expect(isEncryptedBody(await parse(header, pgpParts("application/pgp-encrypted", "application/octet-stream", "application/zip")))).toBe(false);
        expect(isEncryptedBody(await parse(header, pgpParts("text/plain", "application/octet-stream")))).toBe(false);
        expect(isEncryptedBody(await parse('Content-Type: multipart/encrypted; boundary="B"', pgpParts("application/pgp-encrypted", "application/octet-stream")))).toBe(false);
        expect(
            isEncryptedBody(await parse('Content-Type: multipart/encrypted; protocol="application/x-other"; boundary="B"', pgpParts("application/pgp-encrypted", "application/octet-stream"))),
        ).toBe(false);
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
