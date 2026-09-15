///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `@peculiar/x509` requires a `reflect-metadata` polyfill loaded before it is imported (see
// `pki/LocalX509CertificateAuthority.ts`).
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { PublicKey } from "../models/types.js";
import { sanitizeDiscoveredKey } from "./KeyringUtils.js";

/** The longest base64 `certificate` `POST /:id/keys/trust` accepts (a leaf S/MIME certificate is a few KB). */
export const MAX_TRUSTED_CERTIFICATE_LENGTH = 64 * 1024;

/** PKCS #9 `emailAddress` attribute of a certificate subject. */
const EMAIL_ADDRESS_OID = "1.2.840.113549.1.9.1";

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function invalid(message: string): ApiError {
    return new ApiError(ApiErrors.INVALID_REQUEST, 400, message);
}

/**
 * The email identities a certificate names: its subjectAltName `rfc822Name` entries or, when it has none, its subject
 * `emailAddress` attributes. The same fallback Node's `X509Certificate.checkEmail()` applies, which
 * `util/CertificateInstallUtils.ts` uses to bind a mailbox's own signing certificate to its address.
 */
export function certificateEmailIdentities(cert: x509.X509Certificate): string[] {
    const san: x509.SubjectAlternativeNameExtension | null = cert.getExtension(x509.SubjectAlternativeNameExtension);
    const sanEmails: string[] = (san?.names.items ?? []).filter((name) => name.type === "email").map((name) => name.value);
    return sanEmails.length > 0 ? sanEmails : cert.subjectName.getField(EMAIL_ADDRESS_OID);
}

/**
 * Validates a client-supplied base64 DER X.509 certificate for `POST /:id/keys/trust` and returns the signing
 * `PublicKey` to pin for `address`. Every stored field comes from the parsed certificate
 * (`KeyringUtils.sanitizeDiscoveredKey()`), with `publicKey` re-encoded from the DER.
 *
 * @throws `ApiError` 400 when the certificate isn't base64 DER that parses, isn't valid at `now`, doesn't name `address`
 * (case-insensitively, `certificateEmailIdentities()`), or isn't usable for signing mail: a keyUsage extension without
 * `digitalSignature`, or an extKeyUsage extension without `emailProtection`.
 */
export function parseTrustedSignerKey(certificate: unknown, address: string, now: number = Date.now()): PublicKey {
    if (typeof certificate !== "string" || certificate.length > MAX_TRUSTED_CERTIFICATE_LENGTH || !BASE64_PATTERN.test(certificate)) {
        throw invalid("'certificate' must be a base64 encoded DER X.509 certificate.");
    }
    const der: Buffer = Buffer.from(certificate, "base64");
    const key: PublicKey | undefined = sanitizeDiscoveredKey({
        publicKey: der.toString("base64"),
        type: "x509",
        useType: "sign",
        fingerprint: "",
        notBefore: 0,
        notAfter: 0,
    });
    if (!key) {
        throw invalid("The provided certificate could not be parsed.");
    }
    let identities: string[];
    let keyUsage: x509.KeyUsagesExtension | null;
    let extKeyUsage: x509.ExtendedKeyUsageExtension | null;
    try {
        // Extensions are decoded here, not by Node's parser above, so a malformed one is refused here.
        const cert: x509.X509Certificate = new x509.X509Certificate(new Uint8Array(der));
        identities = certificateEmailIdentities(cert);
        keyUsage = cert.getExtension(x509.KeyUsagesExtension);
        extKeyUsage = cert.getExtension(x509.ExtendedKeyUsageExtension);
    } catch {
        throw invalid("The provided certificate could not be parsed.");
    }
    if (now < key.notBefore || now > key.notAfter) {
        throw invalid("The provided certificate is not currently valid.");
    }
    const wanted: string = address.toLowerCase();
    if (!identities.some((identity) => identity.toLowerCase() === wanted)) {
        throw invalid("The provided certificate does not identify this address.");
    }
    if (keyUsage && (keyUsage.usages & x509.KeyUsageFlags.digitalSignature) === 0) {
        throw invalid("The provided certificate's key usage does not allow digital signatures.");
    }
    if (extKeyUsage && !extKeyUsage.usages.includes(x509.ExtendedKeyUsage.emailProtection)) {
        throw invalid("The provided certificate's extended key usage does not include email protection.");
    }
    return key;
}
