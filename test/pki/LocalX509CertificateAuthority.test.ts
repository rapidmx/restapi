///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real filesystem + real WebCrypto - no mocking, mirroring test/dkim/FsDkimKeyProvider.test.ts's own
// convention (this adapter *is* the filesystem/crypto boundary).
import "reflect-metadata";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as x509 from "@peculiar/x509";
import { LocalX509CertificateAuthority } from "../../src/pki/LocalX509CertificateAuthority.js";
import { IssuedCertificate } from "../../src/pki/EncryptionCertificateAuthority.js";

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

describe("LocalX509CertificateAuthority Tests", () => {
    let tmpDir: string;
    let authority: LocalX509CertificateAuthority;

    beforeAll(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "localx509ca-test-"));
    });

    afterAll(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        authority = new LocalX509CertificateAuthority();
        (authority as any).caDir = tmpDir;
        (authority as any).caSubject = "CN=Test Local CA";
        (authority as any).validityDays = 397;
    });

    it("Reports its own name.", () => {
        expect(authority.name).toBe("local-x509");
    });

    it("Issues a certificate for a valid, self-signed CSR, signed by a freshly generated local CA.", async () => {
        const csr: string = await generateCsr("alice@example.com");

        const result: IssuedCertificate = await authority.issue("alice@example.com", csr);

        expect(result.certificate).toContain("BEGIN CERTIFICATE");
        expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(result.notAfter.getTime()).toBeGreaterThan(result.notBefore.getTime());
        expect(result.serialNumber).toBeTruthy();

        const caCertPem: string = await fs.readFile(path.join(tmpDir, "ca.cert.pem"), "utf-8");
        const caCert = new x509.X509Certificate(caCertPem);
        const leafCert = new x509.X509Certificate(result.certificate);
        expect(await leafCert.verify({ publicKey: caCert.publicKey })).toBe(true);

        const san = leafCert.getExtension<x509.SubjectAlternativeNameExtension>("2.5.29.17");
        expect(san?.names.items.map((n) => n.value)).toContain("alice@example.com");
    });

    it("Persists the CA key pair to disk as 0600 and reuses it across instances (idempotent).", async () => {
        const csr1: string = await generateCsr("first@example.com");
        const first: IssuedCertificate = await authority.issue("first@example.com", csr1);

        const stat = await fs.stat(path.join(tmpDir, "ca.key.pem"));
        // Windows doesn't enforce POSIX mode bits the same way - only assert the owner-write bit survived.
        expect(stat.mode & 0o600).toBe(0o600);

        const second = new LocalX509CertificateAuthority();
        (second as any).caDir = tmpDir;
        const csr2: string = await generateCsr("second@example.com");
        const other: IssuedCertificate = await second.issue("second@example.com", csr2);

        const firstCert = new x509.X509Certificate(first.certificate);
        const otherCert = new x509.X509Certificate(other.certificate);
        expect(otherCert.issuer).toBe(firstCert.issuer);
    });

    it("Rejects a CSR that cannot be parsed.", async () => {
        await expect(authority.issue("bad@example.com", "not a csr")).rejects.toThrow(/could not be parsed/);
    });

    it("Rejects a CSR whose self-signature does not verify (tampered public key).", async () => {
        const keys: CryptoKeyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
            "sign",
            "verify",
        ]);
        const csr = await x509.Pkcs10CertificateRequestGenerator.create({
            name: "CN=tampered@example.com",
            keys,
            signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        });
        const csrDer: ArrayBuffer = x509.PemConverter.decodeFirst(csr.toString("pem"));
        const tamperedBytes = Buffer.from(csrDer);
        // Flip a byte inside the signature (the tail of the DER structure) so the self-signature no longer
        // verifies, without corrupting the ASN.1 structure enough to fail parsing outright.
        tamperedBytes[tamperedBytes.length - 5] ^= 0xff;
        const tamperedPem: string = x509.PemConverter.encode(tamperedBytes, "CERTIFICATE REQUEST");

        await expect(authority.issue("tampered@example.com", tamperedPem)).rejects.toThrow(/self-signature does not verify/);
    });

    it("revoke() is a no-op that resolves without error.", async () => {
        await expect(authority.revoke("deadbeef")).resolves.toBeUndefined();
    });

    it("Creates caDir if it doesn't exist yet.", async () => {
        const nestedDir: string = path.join(tmpDir, "nested", "pki");
        const nested = new LocalX509CertificateAuthority();
        (nested as any).caDir = nestedDir;

        await nested.issue("nested@example.com", await generateCsr("nested@example.com"));

        await expect(fs.access(path.join(nestedDir, "ca.cert.pem"))).resolves.toBeUndefined();
    });

    it("Rethrows a filesystem error other than ENOENT while reading an existing CA key.", async () => {
        const badCaDir: string = path.join(tmpDir, "bad-ca");
        await fs.mkdir(badCaDir, { recursive: true });
        // A directory where the CA key file is expected causes EISDIR, not ENOENT, on read.
        await fs.mkdir(path.join(badCaDir, "ca.key.pem"));
        await fs.writeFile(path.join(badCaDir, "ca.cert.pem"), "placeholder");

        const bad = new LocalX509CertificateAuthority();
        (bad as any).caDir = badCaDir;

        await expect(bad.issue("x@example.com", await generateCsr("x@example.com"))).rejects.toThrow();
    });
});
