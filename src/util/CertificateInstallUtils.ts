///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { PublicKey } from "../models/types.js";

/** Normalizes a `crypto.X509Certificate`'s colon-separated-hex fingerprint to the same lowercase,
 * no-separator hex format `EncryptionCertificateAuthority.issue()` already produces (see
 * `LocalX509CertificateAuthority`/`OpenBaoPkiCertificateAuthority`'s own `getThumbprint()`-derived
 * fingerprints), so a `PublicKey.fingerprint` looks the same regardless of which code path derived it. */
export function normalizeFingerprint(fingerprint256: string): string {
    return fingerprint256.replace(/:/g, "").toLowerCase();
}

/**
 * Parses and validates a client- or CA-supplied certificate PEM into a `PublicKey` ready to append to
 * `Mailbox.keys` - shared by `BaseKeyVaultRoute.enrollKey()`'s `useType: "sign"` install path (a human
 * pastes/uploads an already-issued certificate) and `AcmeEnrollmentDriverJob`'s automatic install once an
 * RFC 8823 enrollment reaches `"issued"` (no human involved at all) - both need the exact same
 * parse/validate/normalize logic, only how they obtain `certificatePem` differs.
 *
 * @throws `ApiError` (400) if the PEM can't be parsed, or if it doesn't identify `mailboxAddress` at all -
 * see the inline comment on why the latter check exists.
 */
export function publicKeyFromCertificatePem(
    certificatePem: string,
    useType: "sign" | "encrypt",
    mailboxAddress: string,
): { publicKey: PublicKey; fingerprint: string } {
    let cert: crypto.X509Certificate;
    try {
        cert = new crypto.X509Certificate(certificatePem);
    } catch {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The provided certificate could not be parsed.");
    }
    // Identity binding: "matches the mailbox identity is left to the CA that issued it" is true for
    // chain-of-trust validity, but was previously also true for whether the certificate names this
    // mailbox at all - nothing checked that, so any mailbox owner could publish any third party's
    // genuinely-valid signing certificate (e.g. lifted from any signed email they received) as their own.
    // `checkEmail()` is Node's own RFC 5280 `rfc822Name` SAN matcher (falls back to a CN-based comparison
    // per its documented legacy behavior) - this does not re-litigate the issuing CA's trust decision,
    // only that the certificate the CA vouched for actually names *this* mailbox.
    if (!cert.checkEmail(mailboxAddress)) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The provided certificate does not identify this mailbox's address.");
    }
    const fingerprint: string = normalizeFingerprint(cert.fingerprint256);
    return {
        fingerprint,
        publicKey: {
            publicKey: cert.raw.toString("base64"),
            type: "x509",
            useType,
            fingerprint,
            notBefore: new Date(cert.validFrom).getTime(),
            notAfter: new Date(cert.validTo).getTime(),
        },
    };
}
