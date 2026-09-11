///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { parseRapidMxKeyHeader } from "../../src/util/RapidMxKeyHeaderUtils.js";

x509.cryptoProvider.set(crypto);

async function makeCertBase64(cn: string): Promise<string> {
    const keys: CryptoKeyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
    ]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        name: `CN=${cn}`,
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        keys,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    });
    return Buffer.from(cert.rawData).toString("base64");
}

describe("parseRapidMxKeyHeader() Tests", () => {
    it("Parses a well-formed header into a PublicKey with useType 'encrypt'.", async () => {
        const keydata = await makeCertBase64("alice@example.com");
        const header = `addr=alice@example.com; prefer-encrypt=mutual; type=x509; keydata=${keydata}`;

        const result = parseRapidMxKeyHeader([header], "alice@example.com");

        expect(result?.addr).toBe("alice@example.com");
        expect(result?.preferEncrypt).toBe("mutual");
        expect(result?.publicKey.useType).toBe("encrypt");
        expect(result?.publicKey.type).toBe("x509");
        expect(result?.publicKey.publicKey).toBe(keydata);
        expect(result?.publicKey.fingerprint).toMatch(/^[0-9a-f]+$/);
    });

    it("Defaults preferEncrypt to 'nopreference' when the attribute is absent.", async () => {
        const keydata = await makeCertBase64("bob@example.com");
        const header = `addr=bob@example.com; type=x509; keydata=${keydata}`;

        const result = parseRapidMxKeyHeader([header], "bob@example.com");

        expect(result?.preferEncrypt).toBe("nopreference");
    });

    it("Matches addr to fromAddress case-insensitively.", async () => {
        const keydata = await makeCertBase64("carol@example.com");
        const header = `addr=Carol@Example.com; type=x509; keydata=${keydata}`;

        const result = parseRapidMxKeyHeader([header], "carol@example.com");

        expect(result).toBeDefined();
    });

    it("Ignores the header when zero values are given.", () => {
        expect(parseRapidMxKeyHeader([], "alice@example.com")).toBeUndefined();
    });

    it("Ignores the header when more than one value is given (all copies rejected).", async () => {
        const keydata = await makeCertBase64("alice@example.com");
        const header = `addr=alice@example.com; type=x509; keydata=${keydata}`;

        expect(parseRapidMxKeyHeader([header, header], "alice@example.com")).toBeUndefined();
    });

    it("Ignores the header when addr does not match the From address.", async () => {
        const keydata = await makeCertBase64("attacker@evil.com");
        const header = `addr=attacker@evil.com; type=x509; keydata=${keydata}`;

        expect(parseRapidMxKeyHeader([header], "alice@example.com")).toBeUndefined();
    });

    it("Ignores the header when an unknown attribute without an underscore prefix is present.", async () => {
        const keydata = await makeCertBase64("alice@example.com");
        const header = `addr=alice@example.com; type=x509; keydata=${keydata}; bogus=1`;

        expect(parseRapidMxKeyHeader([header], "alice@example.com")).toBeUndefined();
    });

    it("Ignores an unknown attribute WITH an underscore prefix, per forward-compatible extension.", async () => {
        const keydata = await makeCertBase64("alice@example.com");
        const header = `addr=alice@example.com; type=x509; keydata=${keydata}; _future=1`;

        expect(parseRapidMxKeyHeader([header], "alice@example.com")).toBeDefined();
    });

    it("Ignores the header when type is missing.", async () => {
        const keydata = await makeCertBase64("alice@example.com");
        const header = `addr=alice@example.com; keydata=${keydata}`;

        expect(parseRapidMxKeyHeader([header], "alice@example.com")).toBeUndefined();
    });

    it("Ignores the header when keydata is missing.", () => {
        const header = `addr=alice@example.com; type=x509`;
        expect(parseRapidMxKeyHeader([header], "alice@example.com")).toBeUndefined();
    });

    it("Ignores the header when keydata does not decode as a parseable certificate.", () => {
        const header = `addr=alice@example.com; type=x509; keydata=bm90LWEtY2VydA==`;
        expect(parseRapidMxKeyHeader([header], "alice@example.com")).toBeUndefined();
    });

    it("Tolerates an empty attribute segment from a stray double semicolon.", async () => {
        const keydata = await makeCertBase64("alice@example.com");
        const header = `addr=alice@example.com;; type=x509; keydata=${keydata}`;

        expect(parseRapidMxKeyHeader([header], "alice@example.com")).toBeDefined();
    });

    it("Ignores the header when an attribute token has no '=' at all.", async () => {
        const keydata = await makeCertBase64("alice@example.com");
        const header = `addr=alice@example.com; type=x509; keydata=${keydata}; standalone-token`;

        expect(parseRapidMxKeyHeader([header], "alice@example.com")).toBeUndefined();
    });
});
