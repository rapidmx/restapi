///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { MAX_UPLOADED_CERTIFICATE_LENGTH, validateIssuedCertificate } from "../../src/pki/IssuedCertificateValidation.js";
import { createTestCa, generateCsrWithKeys, type TestCa } from "./signingCertTestUtils.js";

describe("validateIssuedCertificate() Tests", () => {
    const identity = "alice@example.com";
    let ca: TestCa;
    let csr: string;

    beforeAll(async () => {
        ca = await createTestCa();
    });
    beforeEach(async () => {
        csr = (await generateCsrWithKeys(identity)).csr;
    });

    const refusal = (certificate: unknown, id: string = identity, now?: number) =>
        validateIssuedCertificate(csr, id, certificate, now).then(
            () => undefined,
            (err) => err,
        );

    it("accepts a certificate for the request's key, for e-mail, for the address, and reports what it says about itself", async () => {
        const pem = await ca.issue(csr);

        const result = await validateIssuedCertificate(csr, identity, pem);

        expect(result).toEqual(
            expect.objectContaining({ chainLength: 1, subject: `CN=${identity}`, issuer: "CN=Test Public CA", notAfter: expect.any(String), notBefore: expect.any(String), serialNumber: expect.any(String) }),
        );
    });

    it("accepts the chain a CA hands out (leaf first) and counts it", async () => {
        const pem = await ca.issue(csr);

        expect((await validateIssuedCertificate(csr, identity, `${pem}\n${ca.pem}`)).chainLength).toBe(2);
    });

    it("matches the address case-insensitively, and by the subject's emailAddress when there is no subjectAltName", async () => {
        await expect(validateIssuedCertificate(csr, "ALICE@Example.COM", await ca.issue(csr))).resolves.toBeTruthy();
        await expect(validateIssuedCertificate(csr, identity, await ca.issue(csr, { email: null, subjectEmail: identity }))).resolves.toBeTruthy();
    });

    it.each([
        ["nothing", undefined, /Paste or upload/],
        ["an empty string", "   ", /Paste or upload/],
        ["a number", 5, /Paste or upload/],
        ["text that is not PEM", "hello", /No PEM certificate was found/],
    ])("refuses %s with a message to act on", async (_name, value, message) => {
        const err = await refusal(value);
        expect(err.status).toBe(400);
        expect(err.message).toMatch(message);
    });

    it("refuses text over the size limit, a chain of too many certificates and a block that does not parse", async () => {
        expect((await refusal("x".repeat(MAX_UPLOADED_CERTIFICATE_LENGTH + 1))).message).toMatch(/too large/);
        const pem = await ca.issue(csr);
        expect((await refusal(Array(9).fill(pem).join("\n"))).message).toMatch(/at most 8/);
        const broken = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----";
        expect((await refusal(broken)).message).toBe("The certificate could not be parsed.");
        expect((await refusal(`${pem}\n${broken}`)).message).toBe("Certificate 2 of the chain could not be parsed.");
    });

    it("refuses a certificate issued for another key, and says when the chain was pasted the wrong way round", async () => {
        const other = await generateCsrWithKeys(identity);
        const foreign = await ca.issue(other.csr);
        expect((await refusal(foreign)).message).toMatch(/does not match this request's CSR/);

        const own = await ca.issue(csr);
        expect((await refusal(`${ca.pem}\n${own}`)).message).toMatch(/Put the end-entity certificate first/);
        // Another key's certificate first, with no certificate for this key anywhere: still the plain message.
        expect((await refusal(`${foreign}\n${ca.pem}`)).message).toMatch(/does not match this request's CSR/);
    });

    it("refuses a certificate that is not for e-mail: no extended key usage, another usage, or a key usage without digitalSignature", async () => {
        expect((await refusal(await ca.issue(csr, { eku: false }))).message).toMatch(/emailProtection/);
        expect((await refusal(await ca.issue(csr, { eku: "other" }))).message).toMatch(/emailProtection/);
        expect((await refusal(await ca.issue(csr, { keyUsage: x509.KeyUsageFlags.keyEncipherment }))).message).toMatch(/digital signatures/);
        await expect(validateIssuedCertificate(csr, identity, await ca.issue(csr, { keyUsage: false }))).resolves.toBeTruthy();
    });

    it("refuses a certificate for another address, and one that names none", async () => {
        expect((await refusal(await ca.issue(csr, { email: "bob@example.com" }))).message).toBe("The certificate is for bob@example.com, not for alice@example.com.");
        expect((await refusal(await ca.issue(csr, { email: null }))).message).toMatch(/names no e-mail address/);
    });

    it("refuses an expired certificate and one that is not yet valid, allowing a few minutes of clock skew", async () => {
        const expired = await ca.issue(csr, { notBefore: new Date(Date.now() - 2 * 86_400_000), notAfter: new Date(Date.now() - 86_400_000) });
        expect((await refusal(expired)).message).toMatch(/expired on /);
        const future = await ca.issue(csr, { notBefore: new Date(Date.now() + 86_400_000), notAfter: new Date(Date.now() + 2 * 86_400_000) });
        expect((await refusal(future)).message).toMatch(/not valid until /);
        const skewed = await ca.issue(csr, { notBefore: new Date(Date.now() + 60_000) });
        await expect(validateIssuedCertificate(csr, identity, skewed)).resolves.toBeTruthy();
    });
});
