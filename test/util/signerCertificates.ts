///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Generates self-signed certificates for the "Trust this signer" tests (`SignerCertificateUtils.test.ts`,
// `test/routes/keyTrustSuite.ts`).
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
