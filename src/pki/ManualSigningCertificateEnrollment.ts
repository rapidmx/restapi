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
import { readFileIfExists, updateJsonFile } from "./FileStoreUtils.js";
import { computeManualStages } from "./EnrollmentStages.js";
import { EnrollmentBinding, EnrollmentProgress, EnrollmentResult, EnrollmentSummary, SigningCertificateEnrollment } from "./SigningCertificateEnrollment.js";
const { Config, Logger } = ObjectDecorators;

x509.cryptoProvider.set(crypto);

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
}

/**
 * The real, CA-agnostic `SigningCertificateEnrollment` default - works with any publicly-trusted CA an admin
 * chooses, since it never talks to a CA over the network itself. `startEnrollment()` records a pending
 * enrollment (surfacing the CSR for an admin to paste into that CA's own portal by hand); once the CA issues
 * a certificate, `uploadCertificate()` - a method specific to this class, not part of the shared interface,
 * since no other implementation needs a human-upload step - records it, after which `checkStatus()` reflects
 * it as `"issued"`.
 *
 * State is persisted as a small local JSON file, the same "own a small piece of local state on disk" shape
 * `LocalX509CertificateAuthority`'s CA key and `OpenBaoPkiCertificateAuthority`'s serial-number map already
 * use in this codebase - signing-cert enrollment is a low-volume, admin-mediated operation (one per mailbox,
 * rarely repeated), not the kind of collection this codebase otherwise models as a full dual-backend
 * database entity.
 *
 * A REST admin route for the upload step is intentionally not part of this pass - `startEnrollment()` has no
 * caller yet (the eventual key-vault enrollment endpoint, Group D, hasn't been built), so a route with
 * nothing driving traffic to it would be premature infrastructure, the same reasoning already applied to this
 * roadmap's `I4` item. It is added once Group D wires up a real trigger.
 *
 * @author Jean-Philippe Steinmetz
 */
export class ManualSigningCertificateEnrollment implements SigningCertificateEnrollment {
    public readonly name: string = "manual";

    @Config("mail:pki:manual_enrollment:store_path", "/var/lib/rapidmx/pki/manual-enrollments.json")
    private storePath: string = "/var/lib/rapidmx/pki/manual-enrollments.json";

    @Logger
    private logger: any;

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
            throw new ApiError(ApiErrors.NOT_FOUND, 404, `No enrollment found with id '${enrollmentId}'.`);
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

    /** See `SigningCertificateEnrollment.describeEnrollment()` - this store keeps only the identity. */
    public async describeEnrollment(enrollmentId: string): Promise<EnrollmentBinding> {
        const enrollment: PendingEnrollment = await this.requireEnrollment(await this.loadStore(), enrollmentId);
        return { identity: enrollment.identity };
    }

    /**
     * A manual enrollment has one thing to wait for - an administrator obtaining the certificate from a CA by hand and uploading it
     * (`uploadCertificate()`) - so it reports a single stage (`submitted`, active) until then, then `issued` or `failed`. There is no
     * CA to poll, hence no `checkNow()` (the endpoint that would call it answers with this instead), no `nextCheckAt`, no `lastCheckedAt`.
     */
    public async describeProgress(enrollmentId: string): Promise<EnrollmentProgress> {
        const enrollment: PendingEnrollment = await this.requireEnrollment(await this.loadStore(), enrollmentId);
        const { stage, stages, progress } = computeManualStages(enrollment);
        return {
            status: enrollment.status,
            certificate: enrollment.certificate,
            error: enrollment.error,
            stage,
            stages,
            progress,
            requestedAt: enrollment.createdAt,
            updatedAt: enrollment.updatedAt ?? enrollment.createdAt,
            ...(enrollment.issuedAt ? { issuedAt: enrollment.issuedAt } : {}),
            ...(enrollment.status === "failed" ? { errorCode: "failed", retryable: true } : {}),
        };
    }

    /** See `SigningCertificateEnrollment.listEnrollments()`. */
    public async listEnrollments(): Promise<EnrollmentSummary[]> {
        return Object.entries(await this.loadStore()).map(([enrollmentId, enrollment]) => ({
            enrollmentId,
            identity: enrollment.identity,
            status: enrollment.status,
            createdAt: enrollment.createdAt,
        }));
    }

    /** See `SigningCertificateEnrollment.cancelEnrollment()` - only a still-pending enrollment changes. */
    public async cancelEnrollment(enrollmentId: string, reason: string): Promise<void> {
        await this.updateStore(async (store) => {
            const enrollment: PendingEnrollment = await this.requireEnrollment(store, enrollmentId);
            if (enrollment.status === "pending") {
                enrollment.status = "failed";
                enrollment.error = reason;
                enrollment.failedAt = enrollment.updatedAt = new Date().toISOString();
            }
        });
    }

    /**
     * Records the certificate a CA issued for `enrollmentId`'s CSR, once an admin has it in hand. Verifies
     * the uploaded certificate's public key actually matches the CSR's own public key - a real check, not
     * ceremony: it catches an admin pasting in the wrong file (e.g. a different mailbox's certificate) before
     * that mistake becomes a mailbox unable to sign with the key it thinks it has a certificate for.
     *
     * @param enrollmentId An identifier previously returned by `startEnrollment()`.
     * @param certificatePem The PEM-encoded certificate the CA issued.
     * @throws If `enrollmentId` is not recognized, the certificate cannot be parsed, or its public key does
     * not match the original CSR's.
     */
    public async uploadCertificate(enrollmentId: string, certificatePem: string): Promise<void> {
        await this.updateStore(async (store) => {
            const enrollment: PendingEnrollment = await this.requireEnrollment(store, enrollmentId);

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
            enrollment.failedAt = enrollment.updatedAt = new Date().toISOString();
        });
    }
}
