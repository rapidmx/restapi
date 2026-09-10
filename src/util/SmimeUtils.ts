///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { ParsedMail } from "mailparser";

/**
 * `true` if `parsed`'s top-level `Content-Type` marks this message's body as S/MIME (CMS) encrypted -
 * either `application/pkcs7-mime; smime-type=enveloped-data` (the format `specs/end-to-end_encryption.md`
 * mandates for this library's own outgoing mail) or `multipart/encrypted` (the OpenPGP/MIME shape, checked
 * defensively for interop with a sender this library never itself produces). Other `smime-type` values
 * (`signed-data`, `degenerate`, `compressed-data`) are deliberately excluded - only `enveloped-data` (and its
 * authenticated variant) actually hides the plaintext body from this application; an *opaque-signed*
 * `application/pkcs7-mime; smime-type=signed-data` message still carries its real content, just encoded, and
 * this library's own signing (RFC 8551 detached `multipart/signed`) never produces this content type at all.
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
    if (contentTypeValue === "application/pkcs7-mime") {
        return params?.["smime-type"]?.toLowerCase() === "enveloped-data";
    }
    return false;
}
