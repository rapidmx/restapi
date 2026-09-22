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

/** Where an enrollment is in its life - see `EnrollmentProgress.stage` and `pki/EnrollmentStages.ts` for the sequence. */
export type EnrollmentStage = "submitted" | "awaiting-challenge" | "challenge-answered" | "validating" | "issuing" | "issued" | "failed";

/** One step of an enrollment, as a client shows it in a progress list. */
export interface EnrollmentStageStatus {
    /** The stage this step is (never `"failed"` - that is a `state`). */
    id: Exclude<EnrollmentStage, "failed">;
    /** Human-readable, truthful to what this implementation does at that step. */
    label: string;
    /** `done`, `active` (in progress now), `pending` (not reached) or `failed` (the enrollment ended here). */
    state: "done" | "active" | "pending" | "failed";
    /** When the step completed (ISO 8601), when known. */
    at?: string;
}

/**
 * An `EnrollmentResult` plus how far along the enrollment is - what `GET .../sign-enrollment/:enrollmentId` (and the
 * `.../check` and current-enrollment endpoints) answer with. Every field beyond `EnrollmentResult` is additive: a client that
 * only reads `status`/`certificate`/`error` keeps working.
 */
export interface EnrollmentProgress extends EnrollmentResult {
    /** The stage in progress; `"issued"` or `"failed"` once it ended. */
    stage: EnrollmentStage;
    /** Every stage of this implementation's flow, in order. */
    stages: EnrollmentStageStatus[];
    /** 0..100 - for a progress bar. A failed enrollment keeps the value of the stage it failed in (never 100). */
    progress: number;
    /** When the request was submitted (ISO 8601). */
    requestedAt: string;
    /** When the record last changed (ISO 8601). */
    updatedAt: string;
    /** When the CA (or the state of the request) was last checked - by the background job or a check-now (ISO 8601). */
    lastCheckedAt?: string;
    /** When the background job is next expected to check a pending enrollment (ISO 8601); a time already past means it is due. */
    nextCheckAt?: string;
    /** A stable machine-readable code for a failure, or for what is holding up a pending enrollment (see `errorCode` values in
     * `pki/EnrollmentStages.ts`): `order-expired`, `challenge-failed`, `rejected`, `ca-error`, `order-invalid`, `cancelled`
     * (final); `ca-unreachable`, `reply-not-sent`, `rate-limited`, `ca-error` (a pending enrollment's last attempt failed and is retried). */
    errorCode?: string;
    /** For a failed enrollment: whether starting a new request could succeed (`false`: the CA refused the request itself). For a
     * pending one whose last attempt failed: `true`, the next check tries again. */
    retryable?: boolean;
    /** A note about this response - e.g. that a check-now returned before the CA answered - or the last transient error's message. */
    note?: string;
    /** When the certificate was issued (ISO 8601). */
    issuedAt?: string;
    /** When the issued certificate was installed into the mailbox's key vault (ISO 8601); it is installed by the background job. */
    installedAt?: string;
    /** The issued certificate's expiry (ISO 8601). */
    notAfter?: string;
    /** The issued certificate's serial number (hex). */
    serialNumber?: string;
    /** The issued certificate's issuer distinguished name. */
    issuer?: string;
    /** The issued certificate's subject distinguished name. */
    subject?: string;
}

/** What `listEnrollments()` reports about each enrollment (never the CSR, key or certificate). */
export interface EnrollmentSummary extends EnrollmentBinding {
    enrollmentId: string;
    status: EnrollmentResult["status"];
    /** When it was requested (ISO 8601). */
    createdAt: string;
    /** Set once an issued certificate was installed. */
    installedAt?: string;
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

    /**
     * The enrollment's status and how far along it is (`EnrollmentProgress`) - a pure read, like `checkStatus()`.
     * `BaseKeyVaultRoute` answers the status endpoints with this when present, with `checkStatus()` otherwise.
     *
     * @throws If `enrollmentId` is not recognized.
     */
    describeProgress?(enrollmentId: string): Promise<EnrollmentProgress>;

    /**
     * Forces an immediate re-check of one enrollment - the step a background job would take on its next tick - and answers
     * with the resulting progress. Never blocks past `options.timeoutMs`: a CA that answers slower leaves the check running and
     * the answer carries the current state and a `note`. Refuses (429, `retryAfterSeconds` on the error) when the enrollment
     * was force-checked within the last `options.minIntervalMs`.
     *
     * @throws If `enrollmentId` is not recognized.
     */
    checkNow?(enrollmentId: string, options?: { timeoutMs?: number; minIntervalMs?: number }): Promise<EnrollmentProgress>;

    /** Every enrollment this implementation knows of (metadata only), so the endpoint that finds a mailbox's current one can pick
     * among them. */
    listEnrollments?(): Promise<EnrollmentSummary[]>;
}

/** What `describeEnrollment()` reports about the mailbox an enrollment belongs to. */
export interface EnrollmentBinding {
    /** The mailbox address the enrollment was started for. */
    identity: string;
    /** The uid of the mailbox that started it, when recorded. */
    mailboxUid?: string;
}
