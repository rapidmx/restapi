///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// See LocalX509CertificateAuthority.ts's identical note: `@peculiar/x509` requires `reflect-metadata` loaded
// before it is imported.
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { WrappedPrivateKey } from "../models/types.js";
import { readFileIfExists, updateJsonFile } from "./FileStoreUtils.js";
import { computeManualStages } from "./EnrollmentStages.js";
import { validateIssuedCertificate, ValidatedCertificate } from "./IssuedCertificateValidation.js";
import {
    AdminEnrollmentSummary,
    EnrollmentBinding,
    EnrollmentProgress,
    EnrollmentResult,
    EnrollmentSummary,
    SIGNING_ENROLLMENT_UNKNOWN,
    SigningBackendInfo,
    SigningCertificateEnrollment,
} from "./SigningCertificateEnrollment.js";
const { Config, Init, Logger } = ObjectDecorators;

x509.cryptoProvider.set(crypto);

/** Why an administrator cannot complete a request that holds no wrapped key (a record from before the key was kept with it). */
const NO_KEY_REASON =
    "This request was made before the mailbox's key was stored with it, so an uploaded certificate could not be installed. Ask the user to cancel it in Settings > Encryption and request again.";

interface PendingEnrollment {
    identity: string;
    csr: string;
    status: "pending" | "issued" | "failed";
    certificate?: string;
    error?: string;
    createdAt: string;
    /** When the record last changed / the certificate was uploaded / the enrollment failed or was cancelled (ISO 8601). */
    updatedAt?: string;
    issuedAt?: string;
    failedAt?: string;
    /** Why it failed: `rejected` (an administrator refused it) or `cancelled` (its owner abandoned it). */
    errorCode?: string;
    /** The client's own already-wrapped private key for the CSR's key pair, held so the driver job can install the issued certificate and this key
     * into the mailbox with no further client action - the same E2E boundary the RFC 8823 provider keeps (`attachWrappedKey()`). Absent on a record
     * from before this was kept: an administrator can't complete such a request (`uploadValidatedCertificate()`). */
    wrappedKey?: Omit<WrappedPrivateKey, "fingerprint" | "useType">;
    /** The mailbox that attached `wrappedKey`, and its vault's master-key generation then (see `PendingEnrollment` in the RFC 8823 provider). */
    mailboxUid?: string;
    masterKeyGeneration?: number;
    /** Set once the driver job installed the issued certificate into the mailbox's key vault. */
    installedAt?: string;
}

/**
 * The real, CA-agnostic `SigningCertificateEnrollment` for a deployment that does not (or cannot) use RFC 8823 automation - works with any
 * publicly-trusted CA an administrator chooses, since it never talks to a CA over the network itself. `startEnrollment()` records a pending
 * enrollment (surfacing the CSR for an admin to paste into that CA's own portal by hand); once the CA issues a certificate,
 * `uploadValidatedCertificate()` - a method specific to this class, not part of the shared interface, since no other implementation needs a
 * human-upload step - records it, after which `checkStatus()` reflects it as `"issued"` and `AcmeEnrollmentDriverJob` installs it (with the wrapped
 * key `attachWrappedKey()` kept) into the mailbox.
 *
 * State is persisted as a small local JSON file, the same "own a small piece of local state on disk" shape
 * `LocalX509CertificateAuthority`'s CA key and `OpenBaoPkiCertificateAuthority`'s serial-number map already
 * use in this codebase - signing-cert enrollment is a low-volume, admin-mediated operation (one per mailbox,
 * rarely repeated), not the kind of collection this codebase otherwise models as a full dual-backend
 * database entity.
 *
 * The administrator's side of the upload is `BaseSigningEnrollmentAdminRoute` (`/admin/signing-enrollments`: list, download the CSR, upload the
 * certificate, reject).
 *
 * @author Jean-Philippe Steinmetz
 */
export class ManualSigningCertificateEnrollment implements SigningCertificateEnrollment {
    public readonly name: string = "manual";
    public readonly kind = "manual" as const;

    @Config("mail:pki:manual_enrollment:store_path", "/var/lib/rapidmx/pki/manual-enrollments.json")
    private storePath: string = "/var/lib/rapidmx/pki/manual-enrollments.json";

    @Logger
    private logger: any;

    /** Logs, once at startup, that signing certificates here are completed by an administrator - so a reader of the log knows why a request stays
     * pending and where to look (the Signing Certificates admin page). */
    @Init
    public logStartup(): void {
        this.logger?.info(
            "Signing certificates are issued manually: a request waits for an administrator to upload the certificate a CA issued (Admin > Signing Certificates).",
        );
    }

    /** See `SigningCertificateEnrollment.describeBackend()`. */
    public async describeBackend(): Promise<SigningBackendInfo> {
        return { backend: "manual", automatic: false, adminUpload: true };
    }

    private async loadStore(): Promise<Record<string, PendingEnrollment>> {
        const raw: string | undefined = await readFileIfExists(this.storePath);
        return raw === undefined ? {} : JSON.parse(raw);
    }

    /** Locked re-read -> modify -> atomic write of the store (see `FileStoreUtils.updateJsonFile()`), so two
     * concurrent mutations in this process can't drop one another's update and a crash mid-write can't
     * truncate the store. Parent directory mode `0o777` (umask-filtered) matches this store's historical
     * `mkdir` behavior. */
    private async updateStore<T>(mutate: (store: Record<string, PendingEnrollment>) => Promise<T> | T): Promise<T> {
        return updateJsonFile(this.storePath, 0o600, mutate, 0o777);
    }

    private async requireEnrollment(store: Record<string, PendingEnrollment>, enrollmentId: string): Promise<PendingEnrollment> {
        const enrollment: PendingEnrollment | undefined = store[enrollmentId];
        if (!enrollment) {
            throw new ApiError(SIGNING_ENROLLMENT_UNKNOWN, 404, `No enrollment found with id '${enrollmentId}'.`);
        }
        return enrollment;
    }

    public async startEnrollment(identity: string, csr: string): Promise<{ enrollmentId: string }> {
        let parsedCsr: x509.Pkcs10CertificateRequest;
        try {
            parsedCsr = new x509.Pkcs10CertificateRequest(csr);
        } catch {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The provided CSR could not be parsed.");
        }
        if (!(await parsedCsr.verify())) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The provided CSR's self-signature does not verify.");
        }

        const enrollmentId: string = crypto.randomUUID();
        await this.updateStore((store) => {
            store[enrollmentId] = { identity, csr, status: "pending", createdAt: new Date().toISOString() };
        });

        this.logger?.info(`ManualSigningCertificateEnrollment: started enrollment '${enrollmentId}' for '${identity}'.`);
        return { enrollmentId };
    }

    public async checkStatus(enrollmentId: string): Promise<EnrollmentResult> {
        const store: Record<string, PendingEnrollment> = await this.loadStore();
        const enrollment: PendingEnrollment = await this.requireEnrollment(store, enrollmentId);
        return { status: enrollment.status, certificate: enrollment.certificate, error: enrollment.error };
    }

    /** See `SigningCertificateEnrollment.describeEnrollment()` - the identity, and the mailbox uid when `attachWrappedKey()` recorded one. */
    public async describeEnrollment(enrollmentId: string): Promise<EnrollmentBinding> {
        const enrollment: PendingEnrollment = await this.requireEnrollment(await this.loadStore(), enrollmentId);
        return { identity: enrollment.identity, ...(enrollment.mailboxUid ? { mailboxUid: enrollment.mailboxUid } : {}) };
    }

    /**
     * A manual enrollment has one thing to wait for - an administrator obtaining the certificate from a CA by hand and uploading it
     * (`uploadValidatedCertificate()`) - so it reports a single stage (`submitted`, active) until then, then `issued` or `failed`. There is no
     * CA to poll, hence no `checkNow()` (the endpoint that would call it answers with this instead), no `nextCheckAt`, no `lastCheckedAt`.
     */
    public async describeProgress(enrollmentId: string): Promise<EnrollmentProgress> {
        const enrollment: PendingEnrollment = await this.requireEnrollment(await this.loadStore(), enrollmentId);
        const { stage, stages, progress } = computeManualStages(enrollment);
        return {
            provider: "manual",
            status: enrollment.status,
            certificate: enrollment.certificate,
            error: enrollment.error,
            stage,
            stages,
            progress,
            requestedAt: enrollment.createdAt,
            updatedAt: enrollment.updatedAt ?? enrollment.createdAt,
            ...(enrollment.issuedAt ? { issuedAt: enrollment.issuedAt } : {}),
            ...(enrollment.installedAt ? { installedAt: enrollment.installedAt } : {}),
            ...(enrollment.status === "failed" ? { errorCode: enrollment.errorCode ?? "failed", retryable: true } : {}),
        };
    }

    /** See `SigningCertificateEnrollment.listEnrollments()`. */
    public async listEnrollments(): Promise<EnrollmentSummary[]> {
        return Object.entries(await this.loadStore()).map(([enrollmentId, enrollment]) => ({
            enrollmentId,
            identity: enrollment.identity,
            ...(enrollment.mailboxUid ? { mailboxUid: enrollment.mailboxUid } : {}),
            status: enrollment.status,
            createdAt: enrollment.createdAt,
            ...(enrollment.installedAt ? { installedAt: enrollment.installedAt } : {}),
        }));
    }

    /** See `SigningCertificateEnrollment.cancelEnrollment()` - a pending, or issued but not yet installed, enrollment changes. */
    public async cancelEnrollment(enrollmentId: string, reason: string): Promise<void> {
        await this.updateStore(async (store) => {
            const enrollment: PendingEnrollment = await this.requireEnrollment(store, enrollmentId);
            // An uploaded certificate that has no key to install with stays as it is: cancelling could not stop anything.
            if (enrollment.status === "pending" || (enrollment.status === "issued" && enrollment.installedAt === undefined && enrollment.wrappedKey !== undefined)) {
                enrollment.status = "failed";
                enrollment.error = reason;
                enrollment.errorCode = "cancelled";
                enrollment.failedAt = enrollment.updatedAt = new Date().toISOString();
            }
        });
    }

    /**
     * Records the client's already-wrapped private key for this enrollment's CSR (and the mailbox and master-key generation it belongs to), submitted with the
     * request by `BaseKeyVaultRoute.startSignEnrollment()`: what lets `AcmeEnrollmentDriverJob` install the certificate an administrator uploads, together with
     * this key, into the mailbox with no further client action.
     *
     * @throws If `enrollmentId` is not recognized.
     */
    public async attachWrappedKey(
        enrollmentId: string,
        wrappedKey: Omit<WrappedPrivateKey, "fingerprint" | "useType">,
        binding?: { mailboxUid: string; masterKeyGeneration: number },
    ): Promise<void> {
        await this.updateStore(async (store) => {
            const enrollment: PendingEnrollment = await this.requireEnrollment(store, enrollmentId);
            enrollment.wrappedKey = wrappedKey;
            if (binding) {
                enrollment.mailboxUid = binding.mailboxUid;
                enrollment.masterKeyGeneration = binding.masterKeyGeneration;
            }
        });
    }

    /** Every enrollment `AcmeEnrollmentDriverJob` still has work for: pending ones (nothing to do but wait for the upload) and uploaded ones not yet installed. */
    public async listPendingEnrollments(): Promise<
        Array<{ enrollmentId: string; identity: string; status: PendingEnrollment["status"]; mailboxUid?: string; hasWrappedKey: boolean }>
    > {
        return Object.entries(await this.loadStore())
            .filter(([, enrollment]) => enrollment.status === "pending" || (enrollment.status === "issued" && enrollment.installedAt === undefined))
            .map(([enrollmentId, enrollment]) => ({
                enrollmentId,
                identity: enrollment.identity,
                status: enrollment.status,
                mailboxUid: enrollment.mailboxUid,
                hasWrappedKey: !!enrollment.wrappedKey,
            }));
    }

    /** Nothing to advance: there is no CA to talk to - a pending request moves only when an administrator uploads the certificate. Never contacts anything. */
    public async advanceEnrollment(_enrollmentId: string): Promise<boolean> {
        return false;
    }

    /** The certificate and wrapped key to install for an uploaded enrollment (`undefined` until uploaded, or when no key was attached - see `PendingEnrollment.wrappedKey`). */
    public async getIssuedMaterial(
        enrollmentId: string,
    ): Promise<
        | { certificate: string; wrappedKey: Omit<WrappedPrivateKey, "fingerprint" | "useType">; mailboxUid?: string; masterKeyGeneration?: number }
        | undefined
    > {
        const enrollment: PendingEnrollment = await this.requireEnrollment(await this.loadStore(), enrollmentId);
        if (enrollment.status !== "issued" || !enrollment.certificate || !enrollment.wrappedKey) {
            return undefined;
        }
        return {
            certificate: enrollment.certificate,
            wrappedKey: enrollment.wrappedKey,
            mailboxUid: enrollment.mailboxUid,
            masterKeyGeneration: enrollment.masterKeyGeneration,
        };
    }

    /** Records that the driver job installed the uploaded certificate into the mailbox's key vault. */
    public async markInstalled(enrollmentId: string): Promise<void> {
        await this.updateStore(async (store) => {
            const enrollment: PendingEnrollment = await this.requireEnrollment(store, enrollmentId);
            enrollment.installedAt = enrollment.updatedAt = new Date().toISOString();
        });
    }

    /** See `SigningCertificateEnrollment.listAdminEnrollments()`. */
    public async listAdminEnrollments(): Promise<AdminEnrollmentSummary[]> {
        return Object.entries(await this.loadStore())
            .filter(([, enrollment]) => enrollment.status === "pending" || (enrollment.status === "issued" && enrollment.installedAt === undefined))
            .map(([enrollmentId, enrollment]) => {
                const canUpload: boolean = enrollment.status === "pending" && enrollment.wrappedKey !== undefined;
                return {
                    enrollmentId,
                    identity: enrollment.identity,
                    ...(enrollment.mailboxUid ? { mailboxUid: enrollment.mailboxUid } : {}),
                    requestedAt: enrollment.createdAt,
                    status: enrollment.status,
                    provider: "manual" as const,
                    stage: enrollment.status === "pending" ? ("submitted" as const) : ("issued" as const),
                    canUpload,
                    ...(enrollment.status === "pending" && !canUpload ? { uploadBlockedReason: NO_KEY_REASON } : {}),
                };
            })
            .sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt));
    }

    /** What an administrator needs of one request to make its certificate: the CSR (public information) and the address, mailbox and state around it. Never the wrapped key. */
    public async getRequest(
        enrollmentId: string,
    ): Promise<{ identity: string; csr: string; status: PendingEnrollment["status"]; mailboxUid?: string; hasWrappedKey: boolean }> {
        const enrollment: PendingEnrollment = await this.requireEnrollment(await this.loadStore(), enrollmentId);
        return {
            identity: enrollment.identity,
            csr: enrollment.csr,
            status: enrollment.status,
            mailboxUid: enrollment.mailboxUid,
            hasWrappedKey: enrollment.wrappedKey !== undefined,
        };
    }

    /**
     * An administrator's upload: `uploadCertificate()` after checking the certificate for everything that would make it useless to the mailbox
     * (`validateIssuedCertificate()`: it is for this request's key, for e-mail, for this address and currently valid) and that the request can still be
     * completed - it is pending, and holds the mailbox's wrapped key, which is what lets the driver job install the certificate.
     *
     * @throws `ApiError` 404 for an unknown id, 409 when the request is no longer pending or holds no key, 400 (a message a person can act on) when the
     * certificate does not validate.
     */
    public async uploadValidatedCertificate(enrollmentId: string, certificatePem: unknown): Promise<ValidatedCertificate> {
        const request = await this.getRequest(enrollmentId);
        if (request.status !== "pending") {
            throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, `This request is already ${request.status === "issued" ? "issued" : "closed"}.`);
        }
        if (!request.hasWrappedKey) {
            throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, NO_KEY_REASON);
        }
        const validated: ValidatedCertificate = await validateIssuedCertificate(request.csr, request.identity, certificatePem);
        await this.uploadCertificate(enrollmentId, certificatePem as string);
        return validated;
    }

    /**
     * An administrator refuses a pending request: it fails with `reason`, which the mailbox's owner sees, and `errorCode: "rejected"`.
     *
     * @throws `ApiError` 404 for an unknown id, 409 when it is no longer pending.
     */
    public async rejectEnrollment(enrollmentId: string, reason: string): Promise<void> {
        await this.updateStore(async (store) => {
            const enrollment: PendingEnrollment = await this.requireEnrollment(store, enrollmentId);
            if (enrollment.status !== "pending") {
                throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, `This request is already ${enrollment.status === "issued" ? "issued" : "closed"}.`);
            }
            enrollment.status = "failed";
            enrollment.error = reason;
            enrollment.errorCode = "rejected";
            enrollment.failedAt = enrollment.updatedAt = new Date().toISOString();
        });
    }

    /**
     * Records the certificate a CA issued for `enrollmentId`'s CSR, once an admin has it in hand. Verifies
     * the uploaded certificate's public key actually matches the CSR's own public key - a real check, not
     * ceremony: it catches an admin pasting in the wrong file (e.g. a different mailbox's certificate) before
     * that mistake becomes a mailbox unable to sign with the key it thinks it has a certificate for.
     * (`uploadValidatedCertificate()` adds the rest of the checks an administrator's upload needs.)
     *
     * @param enrollmentId An identifier previously returned by `startEnrollment()`.
     * @param certificatePem The PEM-encoded certificate the CA issued.
     * @throws If `enrollmentId` is not recognized, it is no longer pending (409), the certificate cannot be parsed, or its public key does
     * not match the original CSR's.
     */
    public async uploadCertificate(enrollmentId: string, certificatePem: string): Promise<void> {
        await this.updateStore(async (store) => {
            const enrollment: PendingEnrollment = await this.requireEnrollment(store, enrollmentId);
            if (enrollment.status !== "pending") {
                throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, `This enrollment is already ${enrollment.status === "issued" ? "issued" : "closed"}.`);
            }

            let certificate: x509.X509Certificate;
            try {
                certificate = new x509.X509Certificate(certificatePem);
            } catch {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The provided certificate could not be parsed.");
            }

            const csr = new x509.Pkcs10CertificateRequest(enrollment.csr);
            const [certKeyThumbprint, csrKeyThumbprint] = await Promise.all([
                certificate.publicKey.getThumbprint("SHA-256"),
                csr.publicKey.getThumbprint("SHA-256"),
            ]);
            if (Buffer.compare(Buffer.from(certKeyThumbprint), Buffer.from(csrKeyThumbprint)) !== 0) {
                throw new ApiError(
                    ApiErrors.INVALID_REQUEST,
                    400,
                    "The uploaded certificate's public key does not match the enrollment's CSR.",
                );
            }

            enrollment.status = "issued";
            enrollment.certificate = certificatePem;
            enrollment.issuedAt = enrollment.updatedAt = new Date().toISOString();
        });
    }

    /**
     * Records that the CA rejected (or the admin abandoned) `enrollmentId`, so `checkStatus()` reports
     * `"failed"` with `reason` rather than leaving the enrollment `"pending"` forever.
     *
     * @param enrollmentId An identifier previously returned by `startEnrollment()`.
     * @param reason A human-readable explanation.
     * @throws If `enrollmentId` is not recognized.
     */
    public async markFailed(enrollmentId: string, reason: string): Promise<void> {
        await this.updateStore(async (store) => {
            const enrollment: PendingEnrollment = await this.requireEnrollment(store, enrollmentId);
            enrollment.status = "failed";
            enrollment.error = reason;
            enrollment.errorCode = "rejected";
            enrollment.failedAt = enrollment.updatedAt = new Date().toISOString();
        });
    }
}
