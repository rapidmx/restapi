///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// A test certificate authority: certificates for a CSR, with every property `validateIssuedCertificate()` looks at controllable.
import "reflect-metadata";
import * as x509 from "@peculiar/x509";

x509.cryptoProvider.set(crypto);

export interface IssueOptions {
    /** The e-mail in the subjectAltName (default: the CSR's CN). `null` for none. */
    email?: string | null;
    /** The subject `emailAddress` attribute to carry instead (used with `email: null`). */
    subjectEmail?: string;
    /** Whether the certificate has the `emailProtection` extended key usage (default true). `"other"` gives serverAuth only. */
    eku?: boolean | "other";
    /** The key usage bits (default digitalSignature). `false` for no extension. */
    keyUsage?: number | false;
    notBefore?: Date;
    notAfter?: Date;
    /** Issue for this public key instead of the CSR's. */
    publicKey?: CryptoKey;
}

export interface TestCa {
    /** The CA certificate, PEM. */
    pem: string;
    issue(csrPem: string, options?: IssueOptions): Promise<string>;
}

/** A P-256 CSR for `identity` and its key pair. */
export async function generateCsrWithKeys(identity: string): Promise<{ csr: string; keys: CryptoKeyPair }> {
    const keys: CryptoKeyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const csr = await x509.Pkcs10CertificateRequestGenerator.create({ name: `CN=${identity}`, keys, signingAlgorithm: { name: "ECDSA", hash: "SHA-256" } });
    return { csr: csr.toString("pem"), keys };
}

export async function createTestCa(name: string = "Test Public CA"): Promise<TestCa> {
    const keys: CryptoKeyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const ca = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: "01",
        name: `CN=${name}`,
        notBefore: new Date(Date.now() - 86_400_000),
        notAfter: new Date(Date.now() + 10 * 365 * 86_400_000),
        keys,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
    });
    let serial = 1;
    return {
        pem: ca.toString("pem"),
        async issue(csrPem: string, options: IssueOptions = {}): Promise<string> {
            const csr = new x509.Pkcs10CertificateRequest(csrPem);
            const cn: string = csr.subjectName.getField("CN")[0] ?? "";
            const email: string | null = options.email === undefined ? cn : options.email;
            const extensions: x509.Extension[] = [];
            if (email !== null) {
                extensions.push(new x509.SubjectAlternativeNameExtension([{ type: "email", value: email }]));
            }
            if (options.eku !== false) {
                extensions.push(new x509.ExtendedKeyUsageExtension([options.eku === "other" ? x509.ExtendedKeyUsage.serverAuth : x509.ExtendedKeyUsage.emailProtection], false));
            }
            if (options.keyUsage !== false) {
                extensions.push(new x509.KeyUsagesExtension(options.keyUsage ?? x509.KeyUsageFlags.digitalSignature, true));
            }
            const cert = await x509.X509CertificateGenerator.create({
                serialNumber: (++serial).toString(16).padStart(2, "0"),
                subject: options.subjectEmail ? `CN=${cn}, E=${options.subjectEmail}` : csr.subjectName,
                issuer: ca.subject,
                notBefore: options.notBefore ?? new Date(Date.now() - 60_000),
                notAfter: options.notAfter ?? new Date(Date.now() + 365 * 86_400_000),
                publicKey: options.publicKey ?? csr.publicKey,
                signingKey: keys.privateKey,
                signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
                extensions,
            });
            return cert.toString("pem");
        },
    };
}
