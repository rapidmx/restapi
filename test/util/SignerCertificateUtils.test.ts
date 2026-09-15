///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MAX_TRUSTED_CERTIFICATE_LENGTH, parseContactKey, parseTrustedSignerKey } from "../../src/util/SignerCertificateUtils.js";
import { makeSignerCertificate, x509 } from "./signerCertificates.js";

const ADDRESS = "Alice@Example.net";

async function expect400(certificate: unknown, message: string, address: string = ADDRESS): Promise<void> {
    let thrown: any;
    try {
        parseTrustedSignerKey(certificate, address);
    } catch (err) {
        thrown = err;
    }
    expect(thrown).toMatchObject({ status: 400 });
    expect(thrown.message).toContain(message);
}

describe("SignerCertificateUtils Tests", () => {
    it("Returns a sign key whose fingerprint and dates come from the certificate, matching the SAN case-insensitively.", async () => {
        const notBefore = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
        const notAfter = new Date(notBefore.getTime() + 86_400_000);
        const { certificate, fingerprint } = await makeSignerCertificate({
            sanEmails: ["alice@example.net"],
            notBefore,
            notAfter,
            keyUsage: x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.nonRepudiation,
            extKeyUsage: [x509.ExtendedKeyUsage.emailProtection],
        });
        expect(parseTrustedSignerKey(certificate, ADDRESS)).toEqual({
            publicKey: certificate,
            type: "x509",
            useType: "sign",
            fingerprint,
            notBefore: notBefore.getTime(),
            notAfter: notAfter.getTime(),
        });
    });

    it("Falls back to the subject emailAddress only when the certificate has no SAN email.", async () => {
        const subjectOnly = await makeSignerCertificate({ subjectEmail: "alice@example.net" });
        expect(parseTrustedSignerKey(subjectOnly.certificate, ADDRESS).fingerprint).toBe(subjectOnly.fingerprint);
        const sanElsewhere = await makeSignerCertificate({ subjectEmail: "alice@example.net", sanEmails: ["bob@example.net"] });
        await expect400(sanElsewhere.certificate, "does not identify");
    });

    it("Refuses a certificate that isn't a base64 string or is too long.", async () => {
        await expect400(undefined, "must be a base64");
        await expect400(42, "must be a base64");
        await expect400("not base64!", "must be a base64");
        await expect400("A".repeat(MAX_TRUSTED_CERTIFICATE_LENGTH + 4), "must be a base64");
    });

    it("Refuses base64 that isn't a certificate, and a certificate with a malformed extension.", async () => {
        await expect400("AAAA", "could not be parsed");
        const malformed = await makeSignerCertificate({
            sanEmails: undefined,
            extensions: [new x509.Extension("2.5.29.17", false, new Uint8Array([1, 2, 3, 4]))],
        });
        await expect400(malformed.certificate, "could not be parsed");
    });

    it("Refuses a certificate outside its validity period.", async () => {
        const expired = await makeSignerCertificate({
            sanEmails: ["alice@example.net"],
            notBefore: new Date(Date.now() - 10 * 86_400_000),
            notAfter: new Date(Date.now() - 86_400_000),
        });
        await expect400(expired.certificate, "not currently valid");
        const future = await makeSignerCertificate({
            sanEmails: ["alice@example.net"],
            notBefore: new Date(Date.now() + 86_400_000),
            notAfter: new Date(Date.now() + 10 * 86_400_000),
        });
        await expect400(future.certificate, "not currently valid");
    });

    it("Refuses a certificate that doesn't name the address.", async () => {
        const other = await makeSignerCertificate({ sanEmails: ["mallory@example.net"] });
        await expect400(other.certificate, "does not identify");
        const none = await makeSignerCertificate();
        await expect400(none.certificate, "does not identify");
    });

    it("Refuses keyUsage without digitalSignature and extKeyUsage without emailProtection.", async () => {
        const keyUsage = await makeSignerCertificate({ sanEmails: ["alice@example.net"], keyUsage: x509.KeyUsageFlags.keyEncipherment });
        await expect400(keyUsage.certificate, "key usage");
        const eku = await makeSignerCertificate({ sanEmails: ["alice@example.net"], extKeyUsage: [x509.ExtendedKeyUsage.serverAuth] });
        await expect400(eku.certificate, "extended key usage");
    });

    it("parseContactKey() checks an encrypt key's usage for key agreement or key encipherment instead of signatures.", async () => {
        const address = "alice@example.net";
        const agreement = await makeSignerCertificate({ sanEmails: [address], keyUsage: x509.KeyUsageFlags.keyAgreement });
        expect(parseContactKey(agreement.certificate, address, "encrypt")).toMatchObject({ useType: "encrypt", fingerprint: agreement.fingerprint });
        const encipherment = await makeSignerCertificate({
            sanEmails: [address],
            keyUsage: x509.KeyUsageFlags.keyEncipherment,
            extKeyUsage: [x509.ExtendedKeyUsage.emailProtection],
        });
        expect(parseContactKey(encipherment.certificate, address, "encrypt").fingerprint).toBe(encipherment.fingerprint);

        const signatureOnly = await makeSignerCertificate({ sanEmails: [address], keyUsage: x509.KeyUsageFlags.digitalSignature });
        expect(() => parseContactKey(signatureOnly.certificate, address, "encrypt")).toThrow("key agreement or key encipherment");
        const eku = await makeSignerCertificate({ sanEmails: [address], keyUsage: x509.KeyUsageFlags.keyAgreement, extKeyUsage: [x509.ExtendedKeyUsage.clientAuth] });
        expect(() => parseContactKey(eku.certificate, address, "encrypt")).toThrow("extended key usage");
    });
});
