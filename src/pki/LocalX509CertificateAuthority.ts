///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `@peculiar/x509` requires a `reflect-metadata` polyfill loaded before it is imported (it uses `tsyringe`
// internally) - already a transitive dependency of `@rapidrest/core`, which every route in this codebase
// already pulls in, but this module doesn't rely on import order elsewhere providing it.
import "reflect-metadata";
import * as path from "path";
import * as x509 from "@peculiar/x509";
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { EncryptionCertificateAuthority, IssuedCertificate } from "./EncryptionCertificateAuthority.js";
import { createFileExclusive, lockKeyForPath, readFileIfExists, withLock } from "./FileStoreUtils.js";
const { Config, Logger } = ObjectDecorators;

// The global `crypto` (WebCrypto, available with no import since Node 19) is typed against `lib.dom`'s
// `Crypto`/`CryptoKey`, matching what `@peculiar/x509` expects - importing `webcrypto` from the `node:crypto`
// module instead pulls in `@types/node`'s own, subtly incompatible `CryptoKey`/`KeyUsage` types and fails to
// compile against this package's declarations.
x509.cryptoProvider.set(crypto);

const SIGNING_ALGORITHM = { name: "ECDSA", hash: "SHA-256" };
const CA_KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" };
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Upper bound on `ensureCa()`'s lost-race re-read loop - see its doc comment. */
const MAX_INIT_ATTEMPTS = 5;

/** Derives the (extractable) public half of a PKCS#8 ECDSA P-256 private key - needed to self-sign a CA
 * certificate for an already-persisted key without ever re-generating that key. */
async function derivePublicKey(privateKeyPem: string): Promise<CryptoKey> {
    const extractable: CryptoKey = await crypto.subtle.importKey(
        "pkcs8",
        x509.PemConverter.decodeFirst(privateKeyPem),
        CA_KEY_ALGORITHM,
        true,
        ["sign"],
    );
    const { d: _d, key_ops: _keyOps, ...publicJwk } = await crypto.subtle.exportKey("jwk", extractable);
    return crypto.subtle.importKey("jwk", publicJwk, CA_KEY_ALGORITHM, true, ["verify"]);
}

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
     * stable for the deployment's lifetime; rotation is a deliberately separate, not-yet-built operation.
     *
     * First-run initialization is crash- and race-safe:
     * - Serialized within this process (`withLock()` on the key path), so concurrent first-ever `issue()` calls
     * never generate competing roots.
     * - The key and the certificate are each written crash-atomically *and* create-only
     * (`createFileExclusive()`: temp file + `link()`), so a crash mid-write never leaves a torn PEM behind, and
     * a concurrent writer in another process never has its already-minted key/cert overwritten - on losing that
     * race this method simply re-reads the winner's file.
     * - The two files are independent steps: a crash (or failure) after the key is persisted but before the
     * certificate is leaves "key present, cert missing", which the next call recovers from by self-signing a
     * new CA certificate for the *existing* key - it never mints a replacement key, so certificates already
     * issued under that key keep chaining to the CA's key.
     * - Bounded: gives up with an error after `MAX_INIT_ATTEMPTS` lost races rather than looping forever. */
    private async ensureCa(): Promise<{ certificate: x509.X509Certificate; privateKey: CryptoKey }> {
        return withLock(lockKeyForPath(this.caKeyPath()), async () => {
            for (let attempt = 0; attempt < MAX_INIT_ATTEMPTS; attempt++) {
                const keyPem: string | undefined = await readFileIfExists(this.caKeyPath());
                if (keyPem === undefined) {
                    const keys: CryptoKeyPair = await crypto.subtle.generateKey(CA_KEY_ALGORITHM, true, ["sign", "verify"]);
                    const newKeyPem: string = x509.PemConverter.encode(await crypto.subtle.exportKey("pkcs8", keys.privateKey), "PRIVATE KEY");
                    // 0o700 directory mode: only matters on first creation - `mkdir` never tightens an existing one.
                    if (await createFileExclusive(this.caKeyPath(), newKeyPem, 0o600, 0o700)) {
                        this.logger?.info(`LocalX509CertificateAuthority: generated new local CA key at '${this.caDir}'.`);
                    }
                    // Either way, loop back and read whichever key is now on disk (ours, or a concurrent winner's).
                    continue;
                }

                const privateKey: CryptoKey = await crypto.subtle.importKey(
                    "pkcs8",
                    x509.PemConverter.decodeFirst(keyPem),
                    CA_KEY_ALGORITHM,
                    false,
                    ["sign"],
                );
                const certPem: string | undefined = await readFileIfExists(this.caCertPath());
                if (certPem !== undefined) {
                    return { certificate: new x509.X509Certificate(certPem), privateKey };
                }

                // Key present, certificate missing (first run, or a crash between the two writes): self-sign a
                // CA certificate for the existing key.
                const certificate: x509.X509Certificate = await x509.X509CertificateGenerator.createSelfSigned({
                    name: this.caSubject,
                    notBefore: new Date(),
                    notAfter: new Date(Date.now() + 10 * 365 * MS_PER_DAY),
                    keys: { privateKey, publicKey: await derivePublicKey(keyPem) },
                    signingAlgorithm: SIGNING_ALGORITHM,
                    extensions: [
                        new x509.BasicConstraintsExtension(true, undefined, true),
                        new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
                    ],
                });
                if (await createFileExclusive(this.caCertPath(), certificate.toString("pem"), 0o644, 0o700)) {
                    this.logger?.info(`LocalX509CertificateAuthority: generated new local CA certificate at '${this.caDir}'.`);
                    return { certificate, privateKey };
                }
                // Another process persisted a certificate first - loop back and use theirs.
            }
            throw new Error(
                `LocalX509CertificateAuthority: could not initialize the local CA at '${this.caDir}' after ${MAX_INIT_ATTEMPTS} attempts.`,
            );
        });
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
