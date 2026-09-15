///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** The current outcome of a signing-certificate enrollment started via `startEnrollment()`. */
export interface EnrollmentResult {
    status: "pending" | "issued" | "failed";
    /** The issued certificate, PEM-encoded - present only once `status` is `"issued"`. May be a PEM chain (leaf first,
     * then its issuer, ...): the installers (`publicKeyFromCertificatePem()`) install the first certificate and publish
     * the second as `PublicKey.issuerCertificate` when it verifiably issued the first. */
    certificate?: string;
    /** A human-readable reason - present only once `status` is `"failed"`. */
    error?: string;
}

/**
 * Enrolls a mailbox's signing public key for a certificate from a publicly-trusted CA -
 * `specs/end-to-end_encryption.md`'s Digital Signatures feature needs a certificate any external recipient's
 * mail client will already trust, which only a small set of public CAs can issue, unlike
 * `EncryptionCertificateAuthority`'s internal, single-call issuance.
 *
 * Deliberately a separate interface from `EncryptionCertificateAuthority`, not a variant of it: enrollment
 * against a public CA is inherently asynchronous/multi-step even in its simplest form (`startEnrollment()`
 * begins it, `checkStatus()` polls it - neither call blocks on the CA's own turnaround time), and
 * `specs/end-to-end_encryption.md` explicitly allows a closed deployment to disable signing certificates
 * entirely. Keeping this as its own token gives that deployment a clean "don't register a second token"
 * story rather than forcing a single interface to represent two shapes of work.
 *
 * `NullSigningCertificateEnrollment` is the mandatory default; `ManualSigningCertificateEnrollment` is the
 * real, CA-agnostic option (an admin pastes the CSR into any public CA's own portal by hand and uploads the
 * resulting certificate once issued) - see `specs/end-to-end_encryption.md`'s companion roadmap for the full
 * reasoning, including why real ACME automation against a specific CA is tracked separately rather than
 * built as a third implementation in this same pass.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface SigningCertificateEnrollment {
    /** A short, unique name for this implementation (e.g. `"manual"`, matching `SearchProvider.name`'s
     * convention). */
    readonly name: string;

    /**
     * Begins enrollment of `identity`'s signing public key, carried in `csr`, for a certificate from a
     * publicly-trusted CA. Returns immediately with an identifier to poll via `checkStatus()` - never the
     * certificate itself, since even the fastest real enrollment path (e.g. a human pasting a CSR into a CA
     * portal) cannot complete within a single call.
     *
     * Takes a PEM-encoded PKCS#10 CSR for the same proof-of-possession reason as
     * `EncryptionCertificateAuthority.issue()` - a public CA would insist on one anyway.
     *
     * @param identity The mailbox address this certificate is being enrolled for.
     * @param csr A PEM-encoded PKCS#10 certificate signing request.
     */
    startEnrollment(identity: string, csr: string): Promise<{ enrollmentId: string }>;

    /**
     * Returns the current status of a previously started enrollment.
     *
     * @param enrollmentId An identifier previously returned by `startEnrollment()`.
     * @throws If `enrollmentId` is not recognized.
     */
    checkStatus(enrollmentId: string): Promise<EnrollmentResult>;

    /**
     * Which mailbox a previously started enrollment belongs to: the `identity` it was started for, and - when the
     * implementation recorded one (`Rfc8823AcmeSigningCertificateEnrollment.attachWrappedKey()`) - the mailbox uid.
     * `BaseKeyVaultRoute` binds every enrollment-id endpoint to the path mailbox through this, and refuses (404) them all
     * on an implementation without it.
     *
     * @throws If `enrollmentId` is not recognized.
     */
    describeEnrollment?(enrollmentId: string): Promise<EnrollmentBinding>;

    /**
     * Abandons a pending (or issued but not yet installed) enrollment: it is marked `"failed"` with `reason` and nothing
     * is ever installed from it. A no-op for an enrollment that already failed or was installed.
     *
     * @throws If `enrollmentId` is not recognized.
     */
    cancelEnrollment?(enrollmentId: string, reason: string): Promise<void>;
}

/** What `describeEnrollment()` reports about the mailbox an enrollment belongs to. */
export interface EnrollmentBinding {
    /** The mailbox address the enrollment was started for. */
    identity: string;
    /** The uid of the mailbox that started it, when recorded. */
    mailboxUid?: string;
}
