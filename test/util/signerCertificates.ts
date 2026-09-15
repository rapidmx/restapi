///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Generates certificates for the "Trust this signer" and key rotation tests (`SignerCertificateUtils.test.ts`, `KeyringUtils.test.ts`,
// `test/routes/keyTrustSuite.ts`, `test/routes/keyResolveSuite.ts`).
import "reflect-metadata";
import * as x509 from "@peculiar/x509";

x509.cryptoProvider.set(crypto);

const DAY = 24 * 60 * 60 * 1000;

export interface SignerCertificateOptions {
    /** subjectAltName rfc822Name entries; omitted (no SAN extension) when undefined. */
    sanEmails?: string[];
    /** A subject `E=` (emailAddress) attribute. */
    subjectEmail?: string;
    notBefore?: Date;
    notAfter?: Date;
    /** A keyUsage extension with these flags. */
    keyUsage?: number;
    /** An extKeyUsage extension with these OIDs. */
    extKeyUsage?: string[];
    /** Extra raw extensions. */
    extensions?: x509.Extension[];
}

export interface SignerCertificate {
    certificate: string;
    fingerprint: string;
}

export async function makeSignerCertificate(options: SignerCertificateOptions = {}): Promise<SignerCertificate> {
    const keys: CryptoKeyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const extensions: x509.Extension[] = [...(options.extensions ?? [])];
    if (options.sanEmails) {
        extensions.push(new x509.SubjectAlternativeNameExtension(options.sanEmails.map((value) => ({ type: "email" as const, value }))));
    }
    if (options.keyUsage !== undefined) {
        extensions.push(new x509.KeyUsagesExtension(options.keyUsage, true));
    }
    if (options.extKeyUsage) {
        extensions.push(new x509.ExtendedKeyUsageExtension(options.extKeyUsage));
    }
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        name: options.subjectEmail ? `CN=Signer, E=${options.subjectEmail}` : "CN=Signer",
        notBefore: options.notBefore ?? new Date(Date.now() - DAY),
        notAfter: options.notAfter ?? new Date(Date.now() + 365 * DAY),
        keys,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        extensions,
    });
    return {
        certificate: Buffer.from(cert.rawData).toString("base64"),
        fingerprint: Buffer.from(await cert.getThumbprint("SHA-256")).toString("hex"),
    };
}

export { x509 };

/** A test issuing CA for the key rotation tests (`KeyringUtils.test.ts`, `test/routes/keyResolveSuite.ts`). */
export interface TestIssuer {
    keys: CryptoKeyPair;
    cert: x509.X509Certificate;
    /** Base64 DER, what `PublicKey.issuerCertificate` holds. */
    certificate: string;
}

export interface TestIssuerOptions {
    name?: string;
    /** The basicConstraints `cA` flag; `null` omits the extension. Defaults to `true`. */
    ca?: boolean | null;
    /** Sign with this key pair instead of a fresh one (a second certificate for the same CA key). */
    keys?: CryptoKeyPair;
}

export async function makeTestIssuer(options: TestIssuerOptions = {}): Promise<TestIssuer> {
    const keys: CryptoKeyPair = options.keys ?? (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]));
    const ca: boolean | null = options.ca === undefined ? true : options.ca;
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        name: options.name ?? "CN=Rotation Test CA",
        notBefore: new Date(Date.now() - DAY),
        notAfter: new Date(Date.now() + 3650 * DAY),
        keys,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        extensions: ca === null ? [] : [new x509.BasicConstraintsExtension(ca, undefined, true)],
    });
    return { keys, cert, certificate: Buffer.from(cert.rawData).toString("base64") };
}

/** A certificate signed by `issuer` (or, with `signingKey`, by another key while still naming `issuer` as issuer). */
export async function issueCertificate(
    issuer: TestIssuer,
    options: SignerCertificateOptions & { signingKey?: CryptoKey; issuerName?: string } = {},
): Promise<SignerCertificate> {
    const keys: CryptoKeyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const extensions: x509.Extension[] = [...(options.extensions ?? [])];
    if (options.sanEmails) {
        extensions.push(new x509.SubjectAlternativeNameExtension(options.sanEmails.map((value) => ({ type: "email" as const, value }))));
    }
    if (options.keyUsage !== undefined) {
        extensions.push(new x509.KeyUsagesExtension(options.keyUsage, true));
    }
    if (options.extKeyUsage) {
        extensions.push(new x509.ExtendedKeyUsageExtension(options.extKeyUsage));
    }
    const cert = await x509.X509CertificateGenerator.create({
        subject: "CN=Rotated",
        issuer: options.issuerName ?? issuer.cert.subject,
        notBefore: options.notBefore ?? new Date(Date.now() - DAY),
        notAfter: options.notAfter ?? new Date(Date.now() + 365 * DAY),
        publicKey: keys.publicKey,
        signingKey: options.signingKey ?? issuer.keys.privateKey,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        extensions,
    });
    return {
        certificate: Buffer.from(cert.rawData).toString("base64"),
        fingerprint: Buffer.from(await cert.getThumbprint("SHA-256")).toString("hex"),
    };
}
