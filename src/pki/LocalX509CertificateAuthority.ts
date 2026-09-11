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
        // `mode: 0o700`: only matters on first creation (like the file `mode`s below) - `mkdir`/`writeFile`
        // never tighten permissions on a directory/file that already exists.
        await fs.mkdir(this.caDir, { recursive: true, mode: 0o700 });
        try {
            // Atomic create-or-fail (`flag: "wx"`), not a plain `writeFile`: two concurrent first-ever
            // `issue()` calls can both reach this point having both observed `ENOENT` above. Without this,
            // the loser's `writeFile` would silently overwrite the winner's already-generated CA key - and
            // any certificate issued against the winner's CA in between (already returned to a caller,
            // already persisted onto a `Mailbox`) would no longer chain to the CA now on disk, permanently
            // and silently unverifiable. On `EEXIST`, some other call already won - re-run this method to
            // read and return *its* result instead of generating a second, orphaned root.
            await fs.writeFile(this.caKeyPath(), keyPem, { mode: 0o600, flag: "wx" });
        } catch (err: any) {
            if (err.code === "EEXIST") {
                return this.ensureCa();
            }
            throw err;
        }
        await fs.writeFile(this.caCertPath(), certificate.toString("pem"), { mode: 0o644, flag: "wx" });
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
            // A structured `JsonName` (one RDN, `CN` only), not a hand-interpolated `` `CN=${identity}` ``
            // string: `identity` is `Mailbox.primarySmtpAddress`, whose local part is not syntax-validated
            // anywhere in mailbox creation, so a crafted address (an embedded `,`/`=`/`+`) would otherwise be
            // parsed as RFC 4514 DN syntax and let a self-service mailbox owner inject extra attributes (e.g.
            // an `O=` claiming a false organization) into a certificate this deployment's own trust anchor
            // signs. Passing structured data instead of a string to be parsed closes this regardless of what
            // characters `identity` contains - `@peculiar/x509` stores it as a single literal attribute value.
            subject: [{ CN: [identity] }],
            issuer: ca.certificate.subjectName,
            notBefore,
            notAfter,
            publicKey: parsedCsr.publicKey,
            signingKey: ca.privateKey,
            signingAlgorithm: SIGNING_ALGORITHM,
            extensions: [
                new x509.SubjectAlternativeNameExtension([{ type: "email", value: identity }]),
                new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.emailProtection], false),
                // Previously absent on every issued leaf (only the CA's own self-signed root set these).
                // `basicConstraints` absent is *supposed* to mean non-CA per RFC 5280 §4.2.1.9, but lenient/
                // legacy path-builders treat an absent extension permissively - since this CA is the sole
                // trust anchor for encryption within a deployment, an unconstrained leaf is a real path to a
                // leaf holder minting further certificates a lenient validator would accept. `keyAgreement`
                // (ECDH, the default P-256 case) and `keyEncipherment` (RSA, if a deployment's CSR uses it)
                // cover both key algorithms this CA can be asked to sign; deliberately no `digitalSignature`
                // bit - this is `EncryptionCertificateAuthority`, and the spec keeps encryption/signing keys
                // strictly separate.
                new x509.BasicConstraintsExtension(false, undefined, true),
                new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyAgreement | x509.KeyUsageFlags.keyEncipherment, true),
            ],
        });

        const fingerprint: string = Buffer.from(await certificate.getThumbprint("SHA-256")).toString("hex");
        return { certificate: certificate.toString("pem"), fingerprint, notBefore, notAfter, serialNumber: certificate.serialNumber };
    }

    /** No-op - see this class's own doc comment and `EncryptionCertificateAuthority.revoke()`'s: there is no
     * real CRL/OCSP responder here, so there is nothing local for this method to update. The caller remains
     * responsible for recording the revocation on the corresponding `PublicKey` record, which is what a
     * discovery response actually consults. */
    public async revoke(_fingerprint: string): Promise<void> {
        // Intentionally empty.
    }
}
