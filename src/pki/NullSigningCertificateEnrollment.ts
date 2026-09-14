///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { EnrollmentBinding, EnrollmentResult, SigningCertificateEnrollment } from "./SigningCertificateEnrollment.js";

/**
 * The default `SigningCertificateEnrollment` - throws rather than silently doing nothing.
 *
 * Unlike `NullEncryptionCertificateAuthority` (where the identical-looking throw signals a broken/incomplete
 * deployment - E2E simply cannot work without an encryption CA), throwing here may equally reflect a
 * deliberate choice: `specs/end-to-end_encryption.md` explicitly allows a closed deployment to disable
 * digital signatures entirely, and this is what "disabled" looks like - a caller offering signing-cert
 * enrollment should catch and surface this distinctly from an unexpected failure, rather than assuming it
 * always means misconfiguration.
 *
 * `@Inject("SigningCertificateEnrollment")` has no notion of an optional/unregistered dependency - some
 * class must always be registered under the token - so both "intentionally disabled" and "not configured
 * yet" deployments register this one explicitly; `ManualSigningCertificateEnrollment` (or a future
 * automated implementation) is registered instead once a deployment wants real signing certificates.
 *
 * @author Jean-Philippe Steinmetz
 */
export class NullSigningCertificateEnrollment implements SigningCertificateEnrollment {
    public readonly name: string = "null";

    public async startEnrollment(_identity: string, _csr: string): Promise<{ enrollmentId: string }> {
        throw new ApiError(
            ApiErrors.INTERNAL_ERROR,
            500,
            "Signing certificate enrollment is not available for this deployment.",
        );
    }

    public async checkStatus(_enrollmentId: string): Promise<EnrollmentResult> {
        throw new ApiError(
            ApiErrors.INTERNAL_ERROR,
            500,
            "Signing certificate enrollment is not available for this deployment.",
        );
    }

    /** Throws, like every other method - there are no enrollments to describe. */
    public async describeEnrollment(_enrollmentId: string): Promise<EnrollmentBinding> {
        throw new ApiError(
            ApiErrors.INTERNAL_ERROR,
            500,
            "Signing certificate enrollment is not available for this deployment.",
        );
    }
}
