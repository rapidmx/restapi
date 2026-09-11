///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { EncryptionCertificateAuthority, IssuedCertificate } from "./EncryptionCertificateAuthority.js";

/**
 * The default `EncryptionCertificateAuthority` - throws rather than silently doing nothing. Unlike
 * `NullDkimKeyProvider` (whose quiet `undefined` preserves a legitimate admin-fills-it-in-by-hand fallback),
 * there is no such fallback here: a mailbox simply cannot participate in end-to-end encryption without a
 * real certificate authority issuing its encryption certificate, so silence would be the wrong default and
 * would only surface as a confusing failure much later in the flow.
 *
 * `@Inject("EncryptionCertificateAuthority")` has no notion of an optional/unregistered dependency - some
 * class must always be registered under the token - so a deployment that hasn't yet decided on a real CA
 * backend registers this one explicitly, making the gap visible and diagnosable rather than accidental.
 *
 * @author Jean-Philippe Steinmetz
 */
export class NullEncryptionCertificateAuthority implements EncryptionCertificateAuthority {
    public readonly name: string = "null";

    public async issue(_identity: string, _csr: string): Promise<IssuedCertificate> {
        throw new ApiError(
            ApiErrors.INTERNAL_ERROR,
            500,
            "No encryption certificate authority is configured for this deployment.",
        );
    }

    public async revoke(_fingerprint: string): Promise<void> {
        throw new ApiError(
            ApiErrors.INTERNAL_ERROR,
            500,
            "No encryption certificate authority is configured for this deployment.",
        );
    }
}
