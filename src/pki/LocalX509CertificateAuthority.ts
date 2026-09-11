///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `@peculiar/x509` requires a `reflect-metadata` polyfill loaded before it is imported (it uses `tsyringe`
// internally) - already a transitive dependency of `@rapidrest/core`, which every route in this codebase
// already pulls in, but this module doesn't rely on import order elsewhere providing it.
import "reflect-metadata";
import * as fs from "fs/promises";
import * as path from "path";
import * as x509 from "@peculiar/x509";
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { EncryptionCertificateAuthority, IssuedCertificate } from "./EncryptionCertificateAuthority.js";
const { Config, Logger } = ObjectDecorators;

// The global `crypto` (WebCrypto, available with no import since Node 19) is typed against `lib.dom`'s
// `Crypto`/`CryptoKey`, matching what `@peculiar/x509` expects - importing `webcrypto` from the `node:crypto`
// module instead pulls in `@types/node`'s own, subtly incompatible `CryptoKey`/`KeyUsage` types and fails to
// compile against this package's declarations.
x509.cryptoProvider.set(crypto);

const SIGNING_ALGORITHM = { name: "ECDSA", hash: "SHA-256" };
const CA_KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" };
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The zero-external-infrastructure `EncryptionCertificateAuthority` - a self-signed, single-tier CA whose
 * root key pair is generated once and persisted to local disk, built on `@peculiar/x509` (WebCrypto-based,
 * covered by Node's global `crypto.subtle` with no extra polyfill). Suitable for evaluation,
 * tests, and small self-contained deployments; a deployment wanting a real CA hierarchy, HSM-backed root key
 * custody, or a real CRL/OCSP responder registers `OpenBaoPkiCertificateAuthority` instead - both implement
 * the same interface, so this is purely a deployment-time choice.
 *
 * The CA's own private key is stored as 0600 PEM - tighter than `FsDkimKeyProvider`'s 0644, because that file
 * is deliberately readable by an external MTA process while this one is read only by this process itself,
 * and a compromised CA key's blast radius (forge encryption certs for any mailbox) is much larger than a
 * compromised DKIM key's.
 *
 * @author Jean-Philippe Steinmetz
 */
export class LocalX509CertificateAuthority implements EncryptionCertificateAuthority {
    public readonly name: string = "local-x509";

    @Config("mail:pki:local_ca:dir", "/var/lib/rapidmx/pki")
    private caDir: string = "/var/lib/rapidmx/pki";

    @Config("mail:pki:local_ca:subject", "CN=RapidMX Local Encryption CA")
    private caSubject: string = "CN=RapidMX Local Encryption CA";

    @Config("mail:pki:local_ca:validity_days", 397)
    private validityDays: number = 397;

    @Logger
    private logger: any;

    private caKeyPath(): string {
        return path.join(this.caDir, "ca.key.pem");
    }

    private caCertPath(): string {
        return path.join(this.caDir, "ca.cert.pem");
    }

    /** Loads the CA's key pair + self-signed certificate from disk, generating and persisting a new one on
     * first use. Idempotent and safe to call before every `issue()`/`revoke()` - the CA key, once minted, is
     * stable for the deployment's lifetime; rotation is a deliberately separate, not-yet-built operation. */
    private async ensureCa(): Promise<{ certificate: x509.X509Certificate; privateKey: CryptoKey }> {
        try {
            const [keyPem, certPem] = await Promise.all([
                fs.readFile(this.caKeyPath(), "utf-8"),
                fs.readFile(this.caCertPath(), "utf-8"),
            ]);
            const privateKey: CryptoKey = await crypto.subtle.importKey(
                "pkcs8",
                x509.PemConverter.decodeFirst(keyPem),
                CA_KEY_ALGORITHM,
                false,
                ["sign"],
            );
            return { certificate: new x509.X509Certificate(certPem), privateKey };
        } catch (err: any) {
            if (err.code !== "ENOENT") {
                throw err;
            }
        }

        const keys: CryptoKeyPair = await crypto.subtle.generateKey(CA_KEY_ALGORITHM, true, ["sign", "verify"]);
        const certificate: x509.X509Certificate = await x509.X509CertificateGenerator.createSelfSigned({
            name: this.caSubject,
            notBefore: new Date(),
            notAfter: new Date(Date.now() + 10 * 365 * MS_PER_DAY),
            keys,
            signingAlgorithm: SIGNING_ALGORITHM,
            extensions: [
                new x509.BasicConstraintsExtension(true, undefined, true),
                new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
            ],
        });

        const keyPem: string = x509.PemConverter.encode(
            await crypto.subtle.exportKey("pkcs8", keys.privateKey),
            "PRIVATE KEY",
        );
        await fs.mkdir(this.caDir, { recursive: true });
        await fs.writeFile(this.caKeyPath(), keyPem, { mode: 0o600 });
        await fs.writeFile(this.caCertPath(), certificate.toString("pem"), { mode: 0o644 });
        this.logger?.info(`LocalX509CertificateAuthority: generated new local CA root at '${this.caDir}'.`);

        return { certificate, privateKey: keys.privateKey };
    }

    public async issue(identity: string, csr: string): Promise<IssuedCertificate> {
        let parsedCsr: x509.Pkcs10CertificateRequest;
        try {
            parsedCsr = new x509.Pkcs10CertificateRequest(csr);
        } catch {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The provided CSR could not be parsed.");
        }
        if (!(await parsedCsr.verify())) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The provided CSR's self-signature does not verify.");
        }

        const ca = await this.ensureCa();
        const notBefore = new Date();
        const notAfter = new Date(notBefore.getTime() + this.validityDays * MS_PER_DAY);

        const certificate: x509.X509Certificate = await x509.X509CertificateGenerator.create({
            subject: `CN=${identity}`,
            issuer: ca.certificate.subjectName,
            notBefore,
            notAfter,
            publicKey: parsedCsr.publicKey,
            signingKey: ca.privateKey,
            signingAlgorithm: SIGNING_ALGORITHM,
            extensions: [
                new x509.SubjectAlternativeNameExtension([{ type: "email", value: identity }]),
                new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.emailProtection], false),
            ],
        });

        const fingerprint: string = Buffer.from(await certificate.getThumbprint("SHA-256")).toString("hex");
        return { certificate: certificate.toString("pem"), fingerprint, notBefore, notAfter };
    }

    /** No-op - see this class's own doc comment and `EncryptionCertificateAuthority.revoke()`'s: there is no
     * real CRL/OCSP responder here, so there is nothing local for this method to update. The caller remains
     * responsible for recording the revocation on the corresponding `PublicKey` record, which is what a
     * discovery response actually consults. */
    public async revoke(_fingerprint: string): Promise<void> {
        // Intentionally empty.
    }
}
