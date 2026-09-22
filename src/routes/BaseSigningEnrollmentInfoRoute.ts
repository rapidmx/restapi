///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The consuming application must apply `@Route("system/signing-enrollment")` to its own concrete subclass (see `BaseKeyVaultRoute`'s identical note)
// - the one `@Get()` here is defined relative to that.
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, RouteDecorators } from "@rapidrest/service-core";
import { sanitizeErrorText } from "../pki/SigningEnrollmentHealth.js";
import { SigningBackendInfo, SigningCertificateEnrollment } from "../pki/SigningCertificateEnrollment.js";
const { Inject, Logger } = ObjectDecorators;
const { Get, User: AuthUser } = RouteDecorators;

/** The wire shape of `GET /system/signing-enrollment` - see `SigningBackendInfo` for every field. */
export type SigningEnrollmentInfo = SigningBackendInfo;

/**
 * What a signed-in user may know about how signing certificates are issued in this deployment: which backend (`manual`, `rfc8823` or `none`), whether
 * it is automatic, which certificate authority a request goes to (its host only), how long a request typically takes, whether an administrator can upload
 * a certificate by hand, and how the background job's last contacts with the CA went (sanitized) - what a client needs to word the status of a request
 * truthfully ("issued automatically by acme.castle.cloud, about 20 minutes" against "waiting for an administrator") and to say why one is stuck.
 *
 * Reads the active `SigningCertificateEnrollment` (`describeBackend()`); nothing about any mailbox, request or key. Any signed-in user may read it - it is
 * the same for everyone.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseSigningEnrollmentInfoRoute {
    @Inject("SigningCertificateEnrollment")
    private signingCertificateEnrollment?: SigningCertificateEnrollment;

    @Logger
    private logger: any;

    @Get()
    public async get(@AuthUser user?: JWTUser): Promise<SigningEnrollmentInfo> {
        if (!user) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        const enrollment: SigningCertificateEnrollment | undefined = this.signingCertificateEnrollment;
        try {
            if (typeof enrollment?.describeBackend === "function") {
                return await enrollment.describeBackend();
            }
        } catch (err: any) {
            // Never fail the page over the backend's own report: say what is known, and that the rest is not.
            this.logger?.warn(`BaseSigningEnrollmentInfoRoute: could not describe the signing certificate backend: ${sanitizeErrorText(err)}`);
        }
        return { backend: enrollment?.kind ?? "none", automatic: enrollment?.kind === "rfc8823", adminUpload: false };
    }
}
