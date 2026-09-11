///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real filesystem + real WebCrypto - no mocking, mirroring test/pki/LocalX509CertificateAuthority.test.ts's
// own convention (this adapter *is* the filesystem/crypto boundary).
import "reflect-metadata";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as x509 from "@peculiar/x509";
import { ManualSigningCertificateEnrollment } from "../../src/pki/ManualSigningCertificateEnrollment.js";
import { EnrollmentResult } from "../../src/pki/SigningCertificateEnrollment.js";

x509.cryptoProvider.set(crypto);

async function generateCsr(identity: string): Promise<string> {
    const keys: CryptoKeyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
    ]);
    const csr = await x509.Pkcs10CertificateRequestGenerator.create({
        name: `CN=${identity}`,
        keys,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    });
    return csr.toString("pem");
}

async function signCertForCsr(csrPem: string): Promise<string> {
    const csr = new x509.Pkcs10CertificateRequest(csrPem);
    const caKeys: CryptoKeyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
    ]);
    const cert = await x509.X509CertificateGenerator.create({
        subject: csr.subjectName,
        issuer: "CN=Test Public CA",
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        publicKey: csr.publicKey,
        signingKey: caKeys.privateKey,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    });
    return cert.toString("pem");
}

describe("ManualSigningCertificateEnrollment Tests", () => {
    let tmpDir: string;
    let enrollment: ManualSigningCertificateEnrollment;

    beforeAll(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "manualsigning-test-"));
    });

    afterAll(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        enrollment = new ManualSigningCertificateEnrollment();
        (enrollment as any).storePath = path.join(tmpDir, `store-${Math.random()}.json`);
    });

    it("Reports its own name.", () => {
        expect(enrollment.name).toBe("manual");
    });

    it("startEnrollment() persists a pending enrollment for a valid CSR and returns an id.", async () => {
        const csr: string = await generateCsr("alice@example.com");

        const { enrollmentId } = await enrollment.startEnrollment("alice@example.com", csr);

        expect(enrollmentId).toBeTruthy();
        const status: EnrollmentResult = await enrollment.checkStatus(enrollmentId);
        expect(status).toEqual({ status: "pending", certificate: undefined, error: undefined });
    });

    it("Rejects a CSR that cannot be parsed.", async () => {
        await expect(enrollment.startEnrollment("bad@example.com", "not a csr")).rejects.toThrow(/could not be parsed/);
    });

    it("Rejects a CSR whose self-signature does not verify.", async () => {
        const csrPem: string = await generateCsr("tampered@example.com");
        const tamperedBytes = Buffer.from(x509.PemConverter.decodeFirst(csrPem));
        tamperedBytes[tamperedBytes.length - 5] ^= 0xff;
        const tamperedPem: string = x509.PemConverter.encode(tamperedBytes, "CERTIFICATE REQUEST");

        await expect(enrollment.startEnrollment("tampered@example.com", tamperedPem)).rejects.toThrow(
            /self-signature does not verify/,
        );
    });

    it("checkStatus() throws 404 for an unknown enrollment id.", async () => {
        await expect(enrollment.checkStatus("does-not-exist")).rejects.toThrow(/No enrollment found/);
    });

    it("uploadCertificate() records the certificate and checkStatus() reflects it as issued.", async () => {
        const csr: string = await generateCsr("bob@example.com");
        const { enrollmentId } = await enrollment.startEnrollment("bob@example.com", csr);
        const certPem: string = await signCertForCsr(csr);

        await enrollment.uploadCertificate(enrollmentId, certPem);

        const status: EnrollmentResult = await enrollment.checkStatus(enrollmentId);
        expect(status.status).toBe("issued");
        expect(status.certificate).toBe(certPem);
    });

    it("uploadCertificate() throws 404 for an unknown enrollment id.", async () => {
        await expect(enrollment.uploadCertificate("does-not-exist", "pem")).rejects.toThrow(/No enrollment found/);
    });

    it("uploadCertificate() rejects a certificate PEM that cannot be parsed.", async () => {
        const csr: string = await generateCsr("carol@example.com");
        const { enrollmentId } = await enrollment.startEnrollment("carol@example.com", csr);

        await expect(enrollment.uploadCertificate(enrollmentId, "not a cert")).rejects.toThrow(/could not be parsed/);
    });

    it("uploadCertificate() rejects a certificate whose public key doesn't match the enrollment's CSR.", async () => {
        const csr: string = await generateCsr("dave@example.com");
        const { enrollmentId } = await enrollment.startEnrollment("dave@example.com", csr);

        const otherCsr: string = await generateCsr("someone-else@example.com");
        const wrongCertPem: string = await signCertForCsr(otherCsr);

        await expect(enrollment.uploadCertificate(enrollmentId, wrongCertPem)).rejects.toThrow(
            /does not match the enrollment's CSR/,
        );
    });

    it("markFailed() records a failure reason and checkStatus() reflects it.", async () => {
        const csr: string = await generateCsr("erin@example.com");
        const { enrollmentId } = await enrollment.startEnrollment("erin@example.com", csr);

        await enrollment.markFailed(enrollmentId, "CA rejected the request.");

        const status: EnrollmentResult = await enrollment.checkStatus(enrollmentId);
        expect(status).toEqual({ status: "failed", certificate: undefined, error: "CA rejected the request." });
    });

    it("markFailed() throws 404 for an unknown enrollment id.", async () => {
        await expect(enrollment.markFailed("does-not-exist", "reason")).rejects.toThrow(/No enrollment found/);
    });

    it("Persists across instances pointed at the same store path.", async () => {
        const csr: string = await generateCsr("frank@example.com");
        const { enrollmentId } = await enrollment.startEnrollment("frank@example.com", csr);

        const other = new ManualSigningCertificateEnrollment();
        (other as any).storePath = (enrollment as any).storePath;

        const status: EnrollmentResult = await other.checkStatus(enrollmentId);
        expect(status.status).toBe("pending");
    });

    it("Creates the store directory if it doesn't exist yet.", async () => {
        const nestedPath: string = path.join(tmpDir, "nested", "dir", "store.json");
        const nested = new ManualSigningCertificateEnrollment();
        (nested as any).storePath = nestedPath;

        await nested.startEnrollment("nested@example.com", await generateCsr("nested@example.com"));

        await expect(fs.access(nestedPath)).resolves.toBeUndefined();
    });

    it("Rethrows a filesystem error other than ENOENT while reading the store.", async () => {
        const dirAsFile: string = path.join(tmpDir, "a-directory-not-a-file.json");
        await fs.mkdir(dirAsFile, { recursive: true });
        (enrollment as any).storePath = dirAsFile;

        await expect(enrollment.checkStatus("anything")).rejects.toThrow();
    });
});
