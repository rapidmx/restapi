///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { normalizeAddress } from "./AddressUtils.js";
import { PublicKey } from "../models/types.js";

/** The result of successfully parsing and validating an inbound `RapidMX-Key` header - the header's own
 * `addr` attribute (already confirmed to match the message's `From` address) plus the encryption `PublicKey`
 * it carries. Callers still owe the DKIM-verification gate (`util/AuthenticationResultsUtils.ts`'s
 * `hasAlignedPassingDkim()`) before treating this as trustworthy - this function only handles the header's
 * own syntax/semantics, never authentication. */
export interface ParsedRapidMxKeyHeader {
    addr: string;
    preferEncrypt: "mutual" | "nopreference";
    publicKey: PublicKey;
}

const KNOWN_ATTRIBUTES: ReadonlySet<string> = new Set(["addr", "prefer-encrypt", "type", "keydata"]);

/** Splits one `RapidMX-Key` header value into its `key=value` attributes. Returns `undefined` for anything
 * that doesn't parse as a semicolon-separated attribute list (e.g. a bare token with no `=` at all). */
function parseAttributes(value: string): Record<string, string> | undefined {
    const attrs: Record<string, string> = {};
    for (const part of value.split(";")) {
        const trimmed: string = part.trim();
        if (!trimmed) {
            continue;
        }
        const eq: number = trimmed.indexOf("=");
        if (eq < 0) {
            return undefined;
        }
        attrs[trimmed.slice(0, eq).trim().toLowerCase()] = trimmed.slice(eq + 1).trim();
    }
    return attrs;
}

/**
 * Parses and validates an inbound `RapidMX-Key` header against `specs/end-to-end_encryption.md`'s exact
 * processing rules, following the Autocrypt pattern the spec itself cites. Returns `undefined` - meaning
 * "treat as absent", never a thrown error - whenever any rule fails, since the spec is explicit that a
 * malformed or suspicious header must be ignored outright rather than partially trusted:
 *
 * - `headerValues` must contain **exactly one** value - a message carrying more than one `RapidMX-Key` header has all of them ignored, and one with zero has nothing to parse in the first place.
 * - The header's `addr` attribute must match `fromAddress` (case-insensitive, via `normalizeAddress()`).
 * - Every attribute not in `addr`/`prefer-encrypt`/`type`/`keydata` invalidates the whole header, UNLESS its name is prefixed with `_` (forward-compatible extension attributes are silently ignored instead).
 * - `type`/`keydata` are required; `keydata` must decode as a parseable base64 DER certificate (an `EncryptionCertificateAuthority`-issued or self-signed one - this function has no opinion on which, only that it parses at all).
 *
 * The returned `PublicKey.useType` is always `"encrypt"` - per the spec, "the signing certificate is not
 * carried in this header" at all, only the encryption certificate.
 *
 * **Does not check DKIM** - that is `util/AuthenticationResultsUtils.ts`'s `hasAlignedPassingDkim()`'s job,
 * called separately by this function's own caller (`ScanQueueJob`), since DKIM verification needs the
 * message's `Authentication-Results` header(s), not anything this header itself carries.
 */
/**
 * Builds the outbound `RapidMX-Key` header value announcing `address`'s current encryption key, for
 * `BaseMessageRoute.send()` to attach alongside `Disposition-Notification-To` - the inverse of
 * `parseRapidMxKeyHeader()`, emitting only the four attributes that function understands (never a signing
 * key - per the spec, this header never carries one).
 */
export function buildRapidMxKeyHeader(address: string, preferEncrypt: "mutual" | "nopreference", key: PublicKey): string {
    return `addr=${address}; prefer-encrypt=${preferEncrypt}; type=${key.type}; keydata=${key.publicKey}`;
}

export function parseRapidMxKeyHeader(headerValues: string[], fromAddress: string): ParsedRapidMxKeyHeader | undefined {
    if (headerValues.length !== 1) {
        return undefined;
    }
    const attrs: Record<string, string> | undefined = parseAttributes(headerValues[0]);
    if (!attrs) {
        return undefined;
    }
    for (const key of Object.keys(attrs)) {
        if (!KNOWN_ATTRIBUTES.has(key) && !key.startsWith("_")) {
            return undefined;
        }
    }
    if (!attrs.addr || normalizeAddress(attrs.addr) !== normalizeAddress(fromAddress)) {
        return undefined;
    }
    if (!attrs.type || !attrs.keydata) {
        return undefined;
    }
    // `Buffer.from(str, "base64")` silently skips any character outside the base64 alphabet rather than
    // rejecting the input, so two different `keydata` strings (e.g. one with trailing garbage appended) could
    // otherwise decode to the same certificate while still both appearing "valid" as opaque header text.
    // Validated as real base64 first, and capped well above any real certificate's encoded size (a P-256 cert
    // is a few hundred base64 characters; a few KB of headroom covers RSA-4096 with a large extension set)
    // before ever handing it to the X.509 parser.
    if (attrs.keydata.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(attrs.keydata)) {
        return undefined;
    }

    let cert: crypto.X509Certificate;
    try {
        cert = new crypto.X509Certificate(Buffer.from(attrs.keydata, "base64"));
    } catch {
        return undefined;
    }
    const fingerprint: string = cert.fingerprint256.replace(/:/g, "").toLowerCase();

    return {
        addr: attrs.addr,
        preferEncrypt: attrs["prefer-encrypt"] === "mutual" ? "mutual" : "nopreference",
        publicKey: {
            publicKey: attrs.keydata,
            type: attrs.type,
            useType: "encrypt",
            fingerprint,
            notBefore: new Date(cert.validFrom).getTime(),
            notAfter: new Date(cert.validTo).getTime(),
        },
    };
}
