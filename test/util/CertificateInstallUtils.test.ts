///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import * as nodeCrypto from "crypto";
import * as x509 from "@peculiar/x509";
import {
    publicKeyFromCertificatePem,
    revokeInactiveKeys,
    splitPemCertificates,
    supersedeKeys,
    verifiedIssuerCertificate,
} from "../../src/util/CertificateInstallUtils.js";
import type { PublicKey } from "../../src/models/types.js";
import { issueTestLeaf, makeTestCa } from "../routes/keyRotationContinuitySuite.js";

x509.cryptoProvider.set(crypto);

const key = (fields: Partial<PublicKey>): PublicKey => ({
    publicKey: "QUJD",
    type: "x509",
    useType: "encrypt",
    fingerprint: "fp",
    notBefore: 0,
    notAfter: Number.MAX_SAFE_INTEGER,
    ...fields,
});

describe("CertificateInstallUtils", () => {
    describe("PEM chains", () => {
        it("splits every CERTIFICATE block in order and ignores surrounding text", async () => {
            const ca = await makeTestCa();
            const leaf = await issueTestLeaf(ca, "a@example.com");
            expect(splitPemCertificates(`subject=...\n${leaf}\nissuer=...\n${ca.pem}\n`)).toEqual([leaf.trim(), ca.pem.trim()]);
            expect(splitPemCertificates("no certificates")).toEqual([]);
            expect(splitPemCertificates(undefined as any)).toEqual([]);
        });

        it("stores the second certificate as issuerCertificate when it verifiably issued the leaf, installing the leaf only", async () => {
            const ca = await makeTestCa();
            const leafPem = await issueTestLeaf(ca, "a@example.com");
            const { publicKey, fingerprint } = publicKeyFromCertificatePem(`${leafPem}\n${ca.pem}`, "sign", "a@example.com");
            const leaf = new nodeCrypto.X509Certificate(leafPem);
            expect(publicKey.publicKey).toBe(leaf.raw.toString("base64"));
            expect(fingerprint).toBe(leaf.fingerprint256.replace(/:/g, "").toLowerCase());
            expect(publicKey.issuerCertificate).toBe(ca.der);
            // A lone leaf (no chain) has no issuer.
            expect(publicKeyFromCertificatePem(leafPem, "sign", "a@example.com").publicKey.issuerCertificate).toBeUndefined();
            // A third certificate is ignored.
            const root = await makeTestCa("CN=Root");
            expect(publicKeyFromCertificatePem(`${leafPem}${ca.pem}${root.pem}`, "sign", "a@example.com").publicKey.issuerCertificate).toBe(ca.der);
        });

        it("drops an issuer with another name, the same name but another key, or that doesn't parse; still refuses a bad leaf", async () => {
            const ca = await makeTestCa("CN=Issuer");
            const leafPem = await issueTestLeaf(ca, "a@example.com");
            const leaf = new nodeCrypto.X509Certificate(leafPem);
            expect(verifiedIssuerCertificate(leaf, (await makeTestCa("CN=Other")).pem)).toBeUndefined();
            expect(verifiedIssuerCertificate(leaf, (await makeTestCa("CN=Issuer")).pem)).toBeUndefined();
            expect(verifiedIssuerCertificate(leaf, "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----")).toBeUndefined();
            expect(verifiedIssuerCertificate(leaf, undefined)).toBeUndefined();
            expect(verifiedIssuerCertificate(leaf, ca.pem)).toBe(ca.der);
            // The leaf's own certificate isn't its issuer.
            expect(verifiedIssuerCertificate(leaf, leafPem)).toBeUndefined();

            expect(() => publicKeyFromCertificatePem(`${leafPem}${ca.pem}`, "sign", "b@example.com")).toThrow(/does not identify/);
            expect(() => publicKeyFromCertificatePem("garbage", "sign", "a@example.com")).toThrow(/could not be parsed/);
        });

        it("drops an issuer whose DER exceeds 16 KB of base64", async () => {
            const keys: CryptoKeyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
            const name = "CN=Big CA";
            // A long SAN list pads the CA certificate past the bound.
            const big = await x509.X509CertificateGenerator.createSelfSigned({
                name,
                notBefore: new Date(Date.now() - 60_000),
                notAfter: new Date(Date.now() + 86_400_000),
                keys,
                signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
                extensions: [
                    new x509.BasicConstraintsExtension(true, undefined, true),
                    new x509.SubjectAlternativeNameExtension(Array.from({ length: 400 }, (_, i) => ({ type: "dns" as const, value: `host-${i}-padding-padding.example.com` }))),
                ],
            });
            const bigCa = { keys, cert: big, pem: big.toString("pem"), der: Buffer.from(big.rawData).toString("base64") };
            expect(bigCa.der.length).toBeGreaterThan(16384);
            const leaf = new nodeCrypto.X509Certificate(await issueTestLeaf(bigCa, "a@example.com"));
            expect(verifiedIssuerCertificate(leaf, bigCa.pem)).toBeUndefined();
        });
    });

    describe("supersedeKeys()", () => {
        it("revokes older unrevoked keys of the installed useType as superseded, replaces a same-fingerprint entry and appends the new key", () => {
            const keys: PublicKey[] = [
                key({ fingerprint: "e1" }),
                key({ fingerprint: "s1", useType: "sign" }),
                key({ fingerprint: "e0", revokedAt: 5, revocationReason: "compromised" }),
                key({ fingerprint: "e2", revokedAt: 6 }),
                key({ fingerprint: "new", revokedAt: 7 }),
            ];
            const installed = key({ fingerprint: "new", issuerCertificate: "QUJD" });
            expect(supersedeKeys(keys, installed, 100)).toEqual([
                key({ fingerprint: "e1", revokedAt: 100, revocationReason: "superseded" }),
                key({ fingerprint: "s1", useType: "sign" }),
                key({ fingerprint: "e0", revokedAt: 5, revocationReason: "compromised" }),
                key({ fingerprint: "e2", revokedAt: 6 }),
                installed,
            ]);
            // The input isn't mutated.
            expect(keys[0].revokedAt).toBeUndefined();
            expect(supersedeKeys(null, installed, 1)).toEqual([installed]);
        });
    });

    describe("revokeInactiveKeys()", () => {
        it("keeps each useType's active key (latest notBefore among unrevoked, unexpired) and revokes the other unrevoked ones as superseded", () => {
            const now = 1_000;
            const keys: PublicKey[] = [
                key({ fingerprint: "new", notBefore: 500 }),
                key({ fingerprint: "old", notBefore: 100 }),
                key({ fingerprint: "expired-newest", notBefore: 900, notAfter: 999 }),
                key({ fingerprint: "revoked", notBefore: 950, revokedAt: 10, revocationReason: "compromised" }),
                key({ fingerprint: "tie-first", useType: "sign", notBefore: 100 }),
                key({ fingerprint: "tie-last", useType: "sign", notBefore: 100 }),
            ];
            expect(revokeInactiveKeys(keys, now).map((k) => [k.fingerprint, k.revokedAt ?? null, k.revocationReason ?? null])).toEqual([
                ["new", null, null],
                ["old", now, "superseded"],
                ["expired-newest", now, "superseded"],
                ["revoked", 10, "compromised"],
                ["tie-first", now, "superseded"],
                ["tie-last", null, null],
            ]);
        });

        it("leaves a useType with no unexpired unrevoked key alone", () => {
            const keys: PublicKey[] = [key({ fingerprint: "a", notAfter: 5 }), key({ fingerprint: "b", notAfter: 6 })];
            expect(revokeInactiveKeys(keys, 10)).toEqual(keys);
        });
    });
});
