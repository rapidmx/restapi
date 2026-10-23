///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import { webcrypto } from "node:crypto";
import { gunzipSync } from "node:zlib";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import * as x509 from "@peculiar/x509";
import type { ZeroAccessIndexDocument } from "../../src/models/types.js";
import {
    isoWeekId,
    PROTECTED_SUBJECT,
    sealIndexDocument,
    sealMessage,
    sealSummary,
    sealToCertificate,
    ZERO_ACCESS_CONTENT_TYPE,
} from "../../src/zeroaccess/ZeroAccessSealer.js";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);
const ENGINE = new pkijs.CryptoEngine({ name: "test", crypto: webcrypto as unknown as Crypto }) as unknown as pkijs.ICryptoEngine;

/** A P-256 keypair and a self-signed certificate for it - what a mailbox's zero-access key looks like to the sealer. */
async function makeRecipient(): Promise<{ certDer: Uint8Array; certificate: pkijs.Certificate; privateKey: CryptoKey }> {
    const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        name: "CN=alice@example.com",
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 86_400_000),
        keys: keys as CryptoKeyPair,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    });
    const certDer = new Uint8Array(cert.rawData);
    const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
    // Re-imported for key agreement, as web-client's keySession does with an unlocked encryption key.
    const privateKey = await webcrypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    return { certDer, certificate: new pkijs.Certificate({ schema: asn1js.fromBER(cert.rawData).result }), privateKey: privateKey as CryptoKey };
}

/** Decrypts a DER `ContentInfo(EnvelopedData)` the way web-client's `decryptEnvelopedDataWithKeys()` does. */
async function open(der: Uint8Array, recipient: { certificate: pkijs.Certificate; privateKey: CryptoKey }): Promise<Buffer> {
    const contentInfo = new pkijs.ContentInfo({ schema: asn1js.fromBER(der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength)).result });
    const envelopedData = new pkijs.EnvelopedData({ schema: contentInfo.content });
    // AES-256-GCM, the only content encryption web-client accepts.
    expect(envelopedData.encryptedContentInfo.contentEncryptionAlgorithm.algorithmId).toBe("2.16.840.1.101.3.4.1.46");
    const plain = await envelopedData.decrypt(0, { recipientCertificate: recipient.certificate, recipientPrivateKey: recipient.privateKey }, ENGINE);
    return Buffer.from(plain);
}

const RAW: Buffer = Buffer.from(
    [
        "Received: from mx.example.org by mail.example.com",
        "From: Bob <bob@example.org>",
        "To: Alice <alice@example.com>,",
        " Carol <carol@example.com>",
        "Cc: dave@example.com",
        "Subject: Quarterly numbers",
        "Date: Thu, 22 Oct 2026 10:00:00 +0000",
        "Message-ID: <abc@example.org>",
        "In-Reply-To: <parent@example.org>",
        "References: <root@example.org> <parent@example.org>",
        "X-Secret-Header: leaks",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "The numbers are up.",
        "",
    ].join("\r\n"),
);

describe("ZeroAccessSealer", () => {
    it("seals content that only the certificate's private key opens", async () => {
        const recipient = await makeRecipient();
        const other = await makeRecipient();
        const sealed = await sealToCertificate(Buffer.from("hello"), recipient.certDer);

        expect((await open(sealed, recipient)).toString()).toBe("hello");
        await expect(open(sealed, other)).rejects.toThrow();
    });

    it("rejects a certificate that isn't DER", async () => {
        await expect(sealToCertificate(Buffer.from("x"), new Uint8Array([1, 2, 3]))).rejects.toThrow("Could not parse the zero-access certificate");
    });

    it("seals a message as S/MIME enveloped-data wrapping the original MIME byte for byte, keeping only routing headers outside", async () => {
        const recipient = await makeRecipient();
        const sealed: Buffer = await sealMessage(RAW, recipient.certDer);
        const text: string = sealed.toString("latin1");
        const [header, body] = text.split("\r\n\r\n");

        expect(header).toContain("From: Bob <bob@example.org>");
        expect(header).toContain("To: Alice <alice@example.com>,\r\n Carol <carol@example.com>");
        expect(header).toContain("Cc: dave@example.com");
        expect(header).toContain("Date: Thu, 22 Oct 2026 10:00:00 +0000");
        expect(header).toContain("Message-ID: <abc@example.org>");
        expect(header).toContain("In-Reply-To: <parent@example.org>");
        expect(header).toContain("References: <root@example.org> <parent@example.org>");
        expect(header).toContain(`Subject: ${PROTECTED_SUBJECT}`);
        expect(header).toContain(`Content-Type: ${ZERO_ACCESS_CONTENT_TYPE}`);
        expect(header).toContain("Content-Transfer-Encoding: base64");
        // Nothing of the content, nor any other header, is left in the clear.
        expect(text).not.toContain("Quarterly");
        expect(text).not.toContain("numbers are up");
        expect(text).not.toContain("X-Secret-Header");
        expect(text).not.toContain("Received:");
        expect(body.split("\r\n").every((line) => line.length <= 76)).toBe(true);

        const opened: Buffer = await open(Buffer.from(body.replace(/\r\n/g, ""), "base64"), recipient);
        expect(opened.equals(RAW)).toBe(true);
    });

    it("handles a message with bare LF line endings and no body separator", async () => {
        const recipient = await makeRecipient();
        const lfOnly = Buffer.from("From: bob@example.org\nSubject: hi\n\nbody\n");
        const headerOnly = Buffer.from("From: bob@example.org\r\nSubject: hi");

        expect((await sealMessage(lfOnly, recipient.certDer)).toString("latin1")).toMatch(/^From: bob@example.org\r\nSubject: \[\.\.\.\]/);
        expect((await sealMessage(headerOnly, recipient.certDer)).toString("latin1")).toMatch(/^From: bob@example.org\r\nSubject: \[\.\.\.\]/);
    });

    it("keeps the delivery's Authentication-Results outside, in their order, so a verified sender can still be told apart", async () => {
        const recipient = await makeRecipient();
        const raw = Buffer.from(
            [
                "Authentication-Results: mx.example.com; dkim=pass header.d=example.org",
                "Received: from relay",
                "Authentication-Results: upstream.example; dkim=fail",
                "From: bob@example.org",
                "Subject: secret",
                "",
                "body",
            ].join("\r\n"),
        );

        const header: string = (await sealMessage(raw, recipient.certDer)).toString("latin1").split("\r\n\r\n")[0];

        expect(
            header.startsWith(
                "Authentication-Results: mx.example.com; dkim=pass header.d=example.org\r\nAuthentication-Results: upstream.example; dkim=fail\r\nFrom: bob@example.org\r\n",
            ),
        ).toBe(true);
        expect(header).not.toContain("Received");
        expect(header).not.toContain("secret");
    });

    it("ignores a leading continuation line with no field to belong to", async () => {
        const recipient = await makeRecipient();
        const odd = Buffer.from(" stray\r\nFrom: bob@example.org\r\n\r\nbody");

        const header: string = (await sealMessage(odd, recipient.certDer)).toString("latin1").split("\r\n\r\n")[0];
        expect(header.startsWith("From: bob@example.org\r\nSubject: [...]")).toBe(true);
        expect(header).not.toContain("stray");
    });

    it("seals a summary as base64 JSON of only subject and preview", async () => {
        const recipient = await makeRecipient();
        const sealed: string = await sealSummary({ subject: "Quarterly numbers", preview: "The numbers", extra: "x" } as any, recipient.certDer);

        expect(JSON.parse((await open(Buffer.from(sealed, "base64"), recipient)).toString("utf-8"))).toEqual({
            subject: "Quarterly numbers",
            preview: "The numbers",
        });
    });

    it("seals an index document gzipped", async () => {
        const recipient = await makeRecipient();
        const document: ZeroAccessIndexDocument = {
            v: 1,
            messageUid: "m1",
            subject: "Quarterly numbers",
            body: "The numbers are up.",
            attachmentText: ["sheet"],
            attachmentNames: ["q3.xlsx"],
            deferredAttachments: [],
            from: "bob@example.org",
            to: ["alice@example.com"],
            cc: [],
            participants: ["bob@example.org", "alice@example.com"],
            dateForSort: 1,
        };
        const sealed: string = await sealIndexDocument(document, recipient.certDer);

        const opened: Buffer = await open(Buffer.from(sealed, "base64"), recipient);
        expect(JSON.parse(gunzipSync(opened).toString("utf-8"))).toEqual(document);
    });

    describe("isoWeekId()", () => {
        it.each([
            ["2026-10-22T12:00:00Z", "2026-W43"],
            // Monday starts the week; Sunday ends it.
            ["2026-10-19T00:00:00Z", "2026-W43"],
            ["2026-10-25T23:59:59Z", "2026-W43"],
            ["2026-10-26T00:00:00Z", "2026-W44"],
            // Around the new year the ISO year differs from the calendar year.
            ["2027-01-01T00:00:00Z", "2026-W53"],
            ["2024-12-30T00:00:00Z", "2025-W01"],
            ["2021-01-03T00:00:00Z", "2020-W53"],
        ])("puts %s in %s", (iso, expected) => {
            expect(isoWeekId(new Date(iso))).toBe(expected);
        });

        it("uses UTC, not the server's time zone", () => {
            // 23:30 on Sunday in UTC-5 is already Monday in UTC.
            expect(isoWeekId(new Date("2026-10-25T23:30:00-05:00"))).toBe("2026-W44");
        });
    });
});
