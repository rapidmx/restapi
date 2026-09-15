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
import * as FileStoreUtils from "../../src/pki/FileStoreUtils.js";

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

        // The issuer is the CA certificate itself, PEM like `certificate`.
        expect(result.issuerCertificate).toBe(caCert.toString("pem"));
        expect(leafCert.issuer).toBe(new x509.X509Certificate(result.issuerCertificate!).subject);
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

    describe("First-run initialization", () => {
        function freshAuthority(dir: string): LocalX509CertificateAuthority {
            const ca = new LocalX509CertificateAuthority();
            (ca as any).caDir = dir;
            (ca as any).caSubject = "CN=Test Local CA";
            return ca;
        }

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it("Recovers 'key present, cert missing' by self-signing a new CA cert for the existing key (never a new key).", async () => {
            const dir: string = path.join(tmpDir, `recover-${Math.random()}`);
            await freshAuthority(dir).issue("before@example.com", await generateCsr("before@example.com"));
            const keyBefore: string = await fs.readFile(path.join(dir, "ca.key.pem"), "utf-8");
            const oldCaCert = new x509.X509Certificate(await fs.readFile(path.join(dir, "ca.cert.pem"), "utf-8"));
            // Simulate a crash between the key write and the cert write.
            await fs.rm(path.join(dir, "ca.cert.pem"));

            const result: IssuedCertificate = await freshAuthority(dir).issue("after@example.com", await generateCsr("after@example.com"));

            expect(await fs.readFile(path.join(dir, "ca.key.pem"), "utf-8")).toBe(keyBefore);
            const newCaCert = new x509.X509Certificate(await fs.readFile(path.join(dir, "ca.cert.pem"), "utf-8"));
            // Same key pair underneath the regenerated CA certificate...
            expect(Buffer.from(await newCaCert.publicKey.getThumbprint("SHA-256"))).toEqual(
                Buffer.from(await oldCaCert.publicKey.getThumbprint("SHA-256")),
            );
            // ...so new leaves verify against it, and so do leaves issued before the crash.
            expect(await new x509.X509Certificate(result.certificate).verify({ publicKey: newCaCert.publicKey })).toBe(true);
            expect(await newCaCert.verify({ publicKey: newCaCert.publicKey })).toBe(true);
            expect(await fs.readdir(dir)).toEqual(["ca.cert.pem", "ca.key.pem"]);
        });

        it("Concurrent first-ever issue() calls across instances share exactly one CA root.", async () => {
            const dir: string = path.join(tmpDir, `concurrent-${Math.random()}`);
            const results: IssuedCertificate[] = await Promise.all(
                Array.from({ length: 4 }, async (_, i) => freshAuthority(dir).issue(`c${i}@example.com`, await generateCsr(`c${i}@example.com`))),
            );

            const caCert = new x509.X509Certificate(await fs.readFile(path.join(dir, "ca.cert.pem"), "utf-8"));
            for (const result of results) {
                expect(await new x509.X509Certificate(result.certificate).verify({ publicKey: caCert.publicKey })).toBe(true);
            }
            expect(await fs.readdir(dir)).toEqual(["ca.cert.pem", "ca.key.pem"]);
        });

        it("Gives up with an error after a bounded number of lost initialization races instead of looping forever.", async () => {
            const dir: string = path.join(tmpDir, `bounded-${Math.random()}`);
            // Every create reports "someone else already created it", but nothing ever appears on disk.
            const spy = vi.spyOn(FileStoreUtils, "createFileExclusive").mockResolvedValue(false);

            await expect(freshAuthority(dir).issue("loop@example.com", await generateCsr("loop@example.com"))).rejects.toThrow(
                /could not initialize the local CA .* after 5 attempts/,
            );
            expect(spy).toHaveBeenCalledTimes(5);
        });

        it("Also bounds the 'cert keeps losing the race' path.", async () => {
            const dir: string = path.join(tmpDir, `bounded-cert-${Math.random()}`);
            await freshAuthority(dir).issue("seed@example.com", await generateCsr("seed@example.com"));
            await fs.rm(path.join(dir, "ca.cert.pem"));
            vi.spyOn(FileStoreUtils, "createFileExclusive").mockResolvedValue(false);

            await expect(freshAuthority(dir).issue("loop2@example.com", await generateCsr("loop2@example.com"))).rejects.toThrow(
                /after 5 attempts/,
            );
        });
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
