///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { normalizeAddress } from "./AddressUtils.js";
import { OPENPGP_KEY_TYPE } from "./OpenPgpKeyUtils.js";
import type { PublicKey } from "../models/types.js";

/** The header name (Autocrypt Level 1). */
export const AUTOCRYPT_HEADER = "Autocrypt";

/** What an `Autocrypt` header says, before its key is checked. */
export interface ParsedAutocryptHeader {
    addr: string;
    preferEncrypt: "mutual" | "nopreference";
    /** The certificate as a `PublicKey` whose every field but `publicKey` is a placeholder: `KeyringUtils.applyDiscoveredKeys()`
     * takes them from the certificate itself (`sanitizeKey()`) and checks that it names `addr`. */
    publicKey: PublicKey;
}

const KNOWN_ATTRIBUTES: ReadonlySet<string> = new Set(["addr", "prefer-encrypt", "keydata"]);
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** The longest `keydata` accepted, in base64 characters (`KeyDiscoveryClient`'s cap for a discovered key). */
const MAX_KEYDATA_LENGTH = 8192;

/** Width of the whitespace-separated runs `keydata` is written in (whitespace in it is ignored by every reader). */
const FOLD_WIDTH = 76;

/**
 * The outbound `Autocrypt` header value (Autocrypt Level 1) announcing `address`'s OpenPGP certificate `key` - the OpenPGP
 * counterpart of `RapidMX-Key`, which only ever carries the S/MIME certificate. `prefer-encrypt=mutual` is sent only for a
 * mailbox whose preference is mutual. `keydata` is written in space-separated runs: `MimeHeaderUtils.prependHeaders()` writes a
 * header on one line, and a v6 certificate keeps it well under the 998-character line limit.
 */
export function buildAutocryptHeader(address: string, preferEncrypt: "mutual" | "nopreference", key: PublicKey): string {
    const lines: string[] = [];
    for (let i = 0; i < key.publicKey.length; i += FOLD_WIDTH) {
        lines.push(key.publicKey.slice(i, i + FOLD_WIDTH));
    }
    return `addr=${address};${preferEncrypt === "mutual" ? " prefer-encrypt=mutual;" : ""} keydata= ${lines.join(" ")}`;
}

/** `value`'s `name=value` attributes, or `undefined` when it isn't an attribute list. */
function parseAttributes(value: string): Record<string, string> | undefined {
    const attrs: Record<string, string> = {};
    for (const part of value.split(";")) {
        const trimmed: string = part.trim();
        if (!trimmed) {
            continue;
        }
        const eq: number = trimmed.indexOf("=");
        if (eq <= 0) {
            return undefined;
        }
        attrs[trimmed.slice(0, eq).trim().toLowerCase()] = trimmed.slice(eq + 1).trim();
    }
    return attrs;
}

/**
 * Parses an inbound message's `Autocrypt` header(s) for `fromAddress` (Autocrypt Level 1 §2.1), or `undefined` - meaning
 * "treat as absent" - when the rules aren't met: exactly one header (several are all ignored), an `addr` equal to the `From`
 * address, a `keydata` that is base64 (whitespace allowed), and no attribute this parser doesn't know unless its name starts
 * with `_`. Only the syntax: the caller owes the DKIM alignment and oversigning gates, as for `RapidMX-Key`, and the key itself
 * is checked when it is merged.
 */
export function parseAutocryptHeader(headerValues: string[], fromAddress: string): ParsedAutocryptHeader | undefined {
    if (headerValues.length !== 1) {
        return undefined;
    }
    const attrs: Record<string, string> | undefined = parseAttributes(headerValues[0]);
    if (!attrs || !attrs.addr || !attrs.keydata) {
        return undefined;
    }
    if (Object.keys(attrs).some((name) => !KNOWN_ATTRIBUTES.has(name) && !name.startsWith("_"))) {
        return undefined;
    }
    if (normalizeAddress(attrs.addr) !== normalizeAddress(fromAddress)) {
        return undefined;
    }
    const keydata: string = attrs.keydata.replace(/\s+/g, "");
    if (keydata.length === 0 || keydata.length > MAX_KEYDATA_LENGTH || !BASE64_PATTERN.test(keydata)) {
        return undefined;
    }
    return {
        addr: normalizeAddress(attrs.addr),
        preferEncrypt: attrs["prefer-encrypt"]?.toLowerCase() === "mutual" ? "mutual" : "nopreference",
        publicKey: { publicKey: keydata, type: OPENPGP_KEY_TYPE, useType: "encrypt", fingerprint: "", notBefore: 0, notAfter: 0 },
    };
}
