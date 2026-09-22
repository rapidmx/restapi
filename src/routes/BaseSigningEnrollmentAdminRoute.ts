///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The consuming application must apply `@Route("admin/signing-enrollments")` to its own concrete subclass (see `BaseKeyVaultRoute`'s identical note) -
// every method here is defined relative to that.
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ApiErrors, HttpRequest, HttpResponse, ObjectFactory, RouteDecorators } from "@rapidrest/service-core";
import { ValidatedCertificate } from "../pki/IssuedCertificateValidation.js";
import { AdminEnrollmentSummary, SigningCertificateEnrollment } from "../pki/SigningCertificateEnrollment.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { assertAdminScope } from "../util/MailAccessUtils.js";
import { AuditAction } from "../models/types.js";
const { Config, Inject, Logger } = ObjectDecorators;
const { Get, Param, Post, Request, Response, User: AuthUser } = RouteDecorators;

/** The longest rejection reason accepted (characters) - it is shown to the mailbox's owner. */
const MAX_REASON_LENGTH = 500;

/** What the manual provider offers an administrator (`ManualSigningCertificateEnrollment`); an automatic provider has none of it. */
interface ManualAdminProvider {
    getRequest(enrollmentId: string): Promise<{ identity: string; csr: string; status: string; mailboxUid?: string; hasWrappedKey: boolean }>;
    uploadValidatedCertificate(enrollmentId: string, certificatePem: unknown): Promise<ValidatedCertificate>;
    rejectEnrollment(enrollmentId: string, reason: string): Promise<void>;
}

/** The answer to a certificate upload. */
export interface CertificateUploadResult extends ValidatedCertificate {
    enrollmentId: string;
    identity: string;
    status: "issued";
    /** What happens next, in a sentence. */
    message: string;
}

/**
 * The administrator's side of signing certificates - for a deployment that issues them by hand (`ManualSigningCertificateEnrollment`) and as a way to see what
 * an automatic one has pending:
 *
 * - `GET /` the pending requests (address, mailbox, when, state, provider): metadata only, never a CSR, key or certificate. For the RFC 8823 provider the same
 * list, read-only (`canUpload: false`).
 * - `GET /:id/csr` the request's CSR as a PEM file - what an administrator pastes into a CA's portal (manual provider).
 * - `POST /:id/certificate` `{ certificate }` the certificate (or chain) the CA issued, checked (`validateIssuedCertificate()`: it is for this request's key, for
 * e-mail, for this address and not expired) and stored; `AcmeEnrollmentDriverJob` installs it, with the mailbox's own wrapped key, on its next run.
 * - `POST /:id/reject` `{ reason }` refuses the request; the reason is what the mailbox's owner sees.
 *
 * **Access: a trusted role AND an elevated token** (`assertAdminScope()`, the same gate as the mailbox admin scope), and nothing more - none of this reads
 * a mailbox, and a trusted role grants nothing else here. Every call is audited.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseSigningEnrollmentAdminRoute {
    /** Supplied by the Mongo/SQL concrete subclasses so this route can persist an `AuditLogEntry` without depending on either backend directly. */
    protected abstract auditLogClass: any;

    @Config("trusted_roles", ["admin"])
    protected trustedRoles: string[] = ["admin"];

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    @Inject("SigningCertificateEnrollment")
    private signingCertificateEnrollment?: SigningCertificateEnrollment;

    /** The whole application config, needed only to pass through to `recordAuditLog()` (`caller.config`). */
    @Config()
    private config: any;

    @Logger
    private logger: any;

    private async audit(req: HttpRequest | undefined, user: JWTUser | undefined, action: AuditAction, enrollmentId: string, mailboxUid: string | undefined, details: Record<string, unknown>): Promise<void> {
        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, req, user, logger: this.logger },
            { action, targetType: "SigningEnrollment", targetUid: enrollmentId, ...(mailboxUid ? { mailboxUid } : {}), details },
        );
    }

    /** The provider's administrator methods, or a 409 that says why they are not there (the deployment issues certificates automatically, or has none). */
    private manualProvider(): ManualAdminProvider {
        const provider: Partial<ManualAdminProvider> | undefined = this.signingCertificateEnrollment as unknown as Partial<ManualAdminProvider> | undefined;
        if (typeof provider?.getRequest !== "function" || typeof provider.uploadValidatedCertificate !== "function" || typeof provider.rejectEnrollment !== "function") {
            throw new ApiError(
                ApiErrors.IDENTIFIER_EXISTS,
                409,
                this.signingCertificateEnrollment?.kind === "rfc8823"
                    ? "Signing certificates are issued automatically by the certificate authority in this deployment; a request can't be uploaded to, downloaded or rejected here."
                    : "Signing certificates are not enabled in this deployment.",
            );
        }
        return provider as ManualAdminProvider;
    }

    @Get()
    public async list(@Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<AdminEnrollmentSummary[]> {
        assertAdminScope(user, this.trustedRoles);
        const list: AdminEnrollmentSummary[] = (await this.signingCertificateEnrollment!.listAdminEnrollments?.()) ?? [];
        await this.audit(req, user, AuditAction.SIGNING_ENROLLMENT_ADMIN_LIST, "signing-enrollments", undefined, { count: list.length, provider: this.signingCertificateEnrollment!.kind });
        return list;
    }

    @Get("/:id/csr")
    public async csr(@Param("id") id: string, @Request req: HttpRequest, @Response res: HttpResponse, @AuthUser user?: JWTUser): Promise<void> {
        assertAdminScope(user, this.trustedRoles);
        const request = await this.manualProvider().getRequest(id);
        await this.audit(req, user, AuditAction.SIGNING_ENROLLMENT_ADMIN_CSR, id, request.mailboxUid, { address: request.identity });
        res.setHeader("content-type", "application/x-pem-file");
        res.setHeader("content-disposition", `attachment; filename="signing-request-${id}.csr"`);
        res.send(request.csr);
    }

    @Post("/:id/certificate")
    public async uploadCertificate(
        @Param("id") id: string,
        body: { certificate?: unknown } | undefined,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<CertificateUploadResult> {
        assertAdminScope(user, this.trustedRoles);
        const provider: ManualAdminProvider = this.manualProvider();
        const request = await provider.getRequest(id);
        const validated: ValidatedCertificate = await provider.uploadValidatedCertificate(id, body?.certificate);
        await this.audit(req, user, AuditAction.SIGNING_ENROLLMENT_ADMIN_UPLOAD, id, request.mailboxUid, {
            address: request.identity,
            serialNumber: validated.serialNumber,
            notAfter: validated.notAfter,
            chainLength: validated.chainLength,
        });
        return {
            enrollmentId: id,
            identity: request.identity,
            status: "issued",
            message: "The certificate was accepted. It is installed into the mailbox by the background job within a few minutes; the owner's status page shows it as issued now.",
            ...validated,
        };
    }

    @Post("/:id/reject")
    public async reject(@Param("id") id: string, body: { reason?: unknown } | undefined, @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<{ enrollmentId: string; status: "failed"; error: string }> {
        assertAdminScope(user, this.trustedRoles);
        const provider: ManualAdminProvider = this.manualProvider();
        // eslint-disable-next-line no-control-regex -- deliberately strips control characters from an admin-supplied reason before it is shown to the mailbox's owner.
        const reason: string = typeof body?.reason === "string" ? body.reason.replace(/[\u0000-\u001f\u007f]+/g, " ").trim() : "";
        if (reason === "") {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "reason is required - it is what the mailbox's owner is told.");
        }
        if (reason.length > MAX_REASON_LENGTH) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `reason is too long (at most ${MAX_REASON_LENGTH} characters).`);
        }
        const request = await provider.getRequest(id);
        const error: string = `Rejected by an administrator: ${reason}`;
        await provider.rejectEnrollment(id, error);
        await this.audit(req, user, AuditAction.SIGNING_ENROLLMENT_ADMIN_REJECT, id, request.mailboxUid, { address: request.identity, reason });
        return { enrollmentId: id, status: "failed", error };
    }
}
