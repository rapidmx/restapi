///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { ParsedMail } from "mailparser";

/** `smime-type` parameter values (case-insensitive) that mark an `application/pkcs7-mime`/`application/
 * x-pkcs7-mime` body as actually hiding the plaintext from this application. `signed-data`, `degenerate` and
 * `compressed-data` are deliberately excluded - an *opaque-signed* message still carries its real content,
 * just encoded, and this library's own signing (RFC 8551 detached `multipart/signed`) never produces this
 * content type at all. Includes `authEnveloped-data` (RFC 5083/8551 `AuthEnvelopedData`, used with AES-GCM) -
 * the AEAD form a modern sender actually produces, which the equality-only check this replaced did not match. */
const ENCRYPTED_SMIME_TYPES = new Set(["enveloped-data", "authenveloped-data"]);

/** `Content-Type` values (case-insensitive) that carry S/MIME (CMS) data via an `smime-type` parameter,
 * checked against `ENCRYPTED_SMIME_TYPES` above. Includes the legacy `application/x-pkcs7-mime` alias, which
 * Outlook and older Exchange still emit and this application's own "encrypted mail MUST remain readable by
 * existing clients" premise (`specs/end-to-end_encryption.md`) makes a first-class case, not a curiosity. */
const PKCS7_MIME_CONTENT_TYPES = new Set(["application/pkcs7-mime", "application/x-pkcs7-mime"]);

/**
 * `true` if `parsed`'s top-level `Content-Type` marks this message's body as S/MIME (CMS) encrypted - either
 * an `enveloped-data`/`authEnveloped-data` `application/pkcs7-mime` (or legacy `application/x-pkcs7-mime`)
 * part, or `multipart/encrypted` (the OpenPGP/MIME shape, checked defensively for interop with a sender this
 * library never itself produces).
 *
 * A `false` result says nothing about whether the message is *signed* - a detached `multipart/signed`
 * message carries its plaintext body in the clear as one of its parts, which mailparser already parses into
 * `parsed.text`/`parsed.html` normally, same as any other message.
 *
 * mailparser folds `Content-Type` into a `{ value, params }` structured header (see `@types/mailparser`'s
 * `StructuredHeader`) rather than a plain string - the same shape `ScanPipeline`'s own private
 * `getHeaderAddress()`/`getRawHeaderLine()` already work around for other structured headers, reused here via
 * `parsed` (already parsed once by `ScanPipeline.run()`) rather than re-parsing the raw header text.
 */
export function isEncryptedBody(parsed: ParsedMail): boolean {
    const contentType = parsed.headers.get("content-type");
    if (
        !contentType ||
        typeof contentType !== "object" ||
        Array.isArray(contentType) ||
        typeof (contentType as { value: unknown }).value !== "string"
    ) {
        return false;
    }
    const { value, params } = contentType as { value: string; params?: Record<string, string> };
    const contentTypeValue: string = value.toLowerCase();
    if (contentTypeValue === "multipart/encrypted") {
        return true;
    }
    if (PKCS7_MIME_CONTENT_TYPES.has(contentTypeValue)) {
        const smimeType: string | undefined = params?.["smime-type"]?.toLowerCase();
        return !!smimeType && ENCRYPTED_SMIME_TYPES.has(smimeType);
    }
    return false;
}
