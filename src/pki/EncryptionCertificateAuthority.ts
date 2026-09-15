///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** The result of a successful `EncryptionCertificateAuthority.issue()` call - shaped to assign directly onto
 * a future `PublicKey` record (`specs/end-to-end_encryption.md`'s key-vault data model, not yet built in
 * this codebase) with no field translation. */
export interface IssuedCertificate {
    /** The issued certificate, PEM-encoded. */
    certificate: string;
    /** SHA-256 fingerprint of the certificate, lowercase hex - the identifier a discovery response/revocation
     * call refers to this certificate by. */
    fingerprint: string;
    notBefore: Date;
    notAfter: Date;
    /** The certificate's serial number (implementation-defined format - e.g. Vault/OpenBao use colon-separated
     * hex), if the issuing authority has one worth keeping. Optional: a backend with no real CRL/OCSP
     * responder (`LocalX509CertificateAuthority`) has no use for it, but a backend whose `revoke()` must
     * identify a certificate by serial number rather than fingerprint (`OpenBaoPkiCertificateAuthority`)
     * needs its caller to persist this alongside `fingerprint` for that later `revoke()` call to work. */
    serialNumber?: string;
    /** The certificate that directly issued `certificate`, PEM-encoded (the same encoding as `certificate`), when the
     * authority reports one. `BaseKeyVaultRoute.enrollKey()` publishes it, as base64 DER, on
     * `PublicKey.issuerCertificate` only after verifying it signed `certificate`. */
    issuerCertificate?: string;
}

/**
 * Issues short-lived, internally-trusted X.509 certificates binding a mailbox's encryption public key to its
 * identity - the server-side half of `specs/end-to-end_encryption.md`'s encryption-key enrollment flow.
 * Deliberately synchronous/single-call (unlike `SigningCertificateEnrollment`, which is inherently
 * asynchronous) - an internal CA answerable only to this deployment never needs an external
 * validation/approval round-trip the way a publicly-trusted CA does.
 *
 * Kept behind an interface - like `SearchProvider`/`DkimKeyProvider`/`MailTransport` - so a deployment
 * chooses its own CA backend without this library ever making that choice itself. `NullEncryptionCertificateAuthority`
 * is the mandatory default (`@Inject("EncryptionCertificateAuthority")` throws at construction if nothing is
 * registered under the token at all - some class must always be registered); `LocalX509CertificateAuthority`
 * is the zero-external-infrastructure real option, and `OpenBaoPkiCertificateAuthority` is the recommended
 * production backend (a self-hosted OpenBao/Vault PKI secrets engine) - see `specs/end-to-end_encryption.md`'s
 * companion roadmap for the full reasoning.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface EncryptionCertificateAuthority {
    /** A short, unique name for this authority implementation (e.g. `"local-x509"`, matching
     * `SearchProvider.name`'s convention). */
    readonly name: string;

    /**
     * Issues a certificate binding `identity` (a mailbox's primary SMTP address) to the public key carried in
     * `csr`.
     *
     * Takes a PEM-encoded PKCS#10 CSR, not a bare public key - the CSR's own self-signature is cryptographic
     * proof the caller possesses the private key matching the public key it carries, a real security property
     * (it stops an entity from getting a certificate minted for a public key it doesn't control) that every
     * conformant CA - including a production `OpenBaoPkiCertificateAuthority` - checks before issuing. Every
     * implementation of this interface MUST verify the CSR's self-signature before issuing.
     *
     * @param identity The mailbox address this certificate is being issued for.
     * @param csr A PEM-encoded PKCS#10 certificate signing request.
     * @throws If the CSR is malformed or its self-signature does not verify.
     */
    issue(identity: string, csr: string): Promise<IssuedCertificate>;

    /**
     * Revokes the certificate identified by `fingerprint`. Implementations with no real CRL/OCSP responder
     * (e.g. `LocalX509CertificateAuthority`) may treat this as a no-op - the caller remains responsible for
     * recording the revocation on the corresponding `PublicKey` record, which is what a discovery response
     * actually consults.
     *
     * @param fingerprint The SHA-256 fingerprint (lowercase hex) of the certificate to revoke, as returned by
     * `issue()`.
     */
    revoke(fingerprint: string): Promise<void>;
}
