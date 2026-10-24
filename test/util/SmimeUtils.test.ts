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

    const armored = "-----BEGIN PGP MESSAGE-----\r\n\r\nwV4DAAAAAAAAAAASAQdA\r\n=abcd\r\n-----END PGP MESSAGE-----";

    it("Returns true for an inline OpenPGP message: a plain-text body that is one armored PGP MESSAGE block.", async () => {
        expect(isEncryptedBody(await parse("Content-Type: text/plain; charset=us-ascii", armored))).toBe(true);
        // No Content-Type at all is text/plain.
        expect(isEncryptedBody(await simpleParser(Buffer.from(["From: a@example.com", "Subject: x", "", armored, ""].join("\r\n"))))).toBe(true);
    });

    it("Returns false for a Content-Type header mailparser didn't structure.", () => {
        expect(isEncryptedBody({ headers: new Map([["content-type", "text/plain"]]) } as any)).toBe(false);
        expect(isEncryptedBody({ headers: new Map([["content-type", { value: 5 }]]) } as any)).toBe(false);
    });

    it("Does not treat text around an armored block, an HTML body, an attachment or a signed block as an inline encrypted message.", async () => {
        expect(isEncryptedBody(await parse("Content-Type: text/plain", `Hello\r\n${armored}`))).toBe(false);
        expect(isEncryptedBody(await parse("Content-Type: text/html", armored))).toBe(false);
        expect(isEncryptedBody(await parse("Content-Type: text/plain", "-----BEGIN PGP SIGNED MESSAGE-----\r\nHash: SHA256\r\n\r\nhi\r\n-----BEGIN PGP SIGNATURE-----\r\nx\r\n-----END PGP SIGNATURE-----"))).toBe(false);
        const withAttachment = [
            "From: a@example.com",
            'Content-Type: multipart/mixed; boundary="M"',
            "",
            "--M",
            "Content-Type: text/plain",
            "",
            armored,
            "--M",
            "Content-Type: application/octet-stream",
            "Content-Disposition: attachment; filename=x.bin",
            "",
            "AAAA",
            "--M--",
            "",
        ].join("\r\n");
        expect(isEncryptedBody(await simpleParser(Buffer.from(withAttachment)))).toBe(false);
        expect(isEncryptedBody(await simpleParser(Buffer.from(["From: a@example.com", "Subject: x", "", "plain words", ""].join("\r\n"))))).toBe(false);
    });
});
