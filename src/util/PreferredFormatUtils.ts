///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Which end-to-end format a recipient would rather receive (`specs/end-to-end_encryption.md` *Choosing the format*), for a
 * recipient a sender can reach in both. In order, the first that says anything wins:
 *
 * 1. the user's own choice for the contact (`Contact.preferredFormat`);
 * 2. what the address advertises (`EncryptionPreference.preferFormat`, from discovery or the `RapidMX-Key` header);
 * 3. what the address was last seen using (`Contact.observedFormat`, from authenticated inbound mail).
 *
 * With none, the sender's own rule applies: S/MIME whenever the recipient has a usable certificate.
 */
import type { Contact, EndToEndFormat, ObservedFormat } from "../models/types.js";

/** Whether `value` is one of the two formats. */
export function isEndToEndFormat(value: unknown): value is EndToEndFormat {
    return value === "smime" || value === "openpgp";
}

/** Where a resolved preference came from. */
export type PreferredFormatSource = "contact" | "advertised" | "observed";

/** The format `contact` prefers and why, or `undefined` when nothing says. */
export function resolvePreferredFormat(
    contact: Pick<Contact, "preferredFormat" | "encryptPreference" | "observedFormat">,
): { format: EndToEndFormat; source: PreferredFormatSource } | undefined {
    if (isEndToEndFormat(contact.preferredFormat)) {
        return { format: contact.preferredFormat, source: "contact" };
    }
    if (isEndToEndFormat(contact.encryptPreference?.preferFormat)) {
        return { format: contact.encryptPreference.preferFormat, source: "advertised" };
    }
    if (contact.observedFormat && isEndToEndFormat(contact.observedFormat.format)) {
        return { format: contact.observedFormat.format, source: "observed" };
    }
    return undefined;
}

/** A header value's `name=value` parameters, lowercased names, unquoted values. */
function headerParams(value: string): Record<string, string> {
    const params: Record<string, string> = {};
    for (const part of value.split(";").slice(1)) {
        const eq: number = part.indexOf("=");
        if (eq > 0) {
            params[part.slice(0, eq).trim().toLowerCase()] = part
                .slice(eq + 1)
                .trim()
                .replace(/^"(.*)"$/, "$1")
                .toLowerCase();
        }
    }
    return params;
}

/**
 * The end-to-end format a message is in, by its top-level `Content-Type` (unfolded): S/MIME signed or enveloped
 * (`multipart/signed` with a PKCS#7 signature, `application/pkcs7-mime`), or PGP/MIME signed or encrypted. `undefined` for
 * anything else, including inline PGP, which is too easy to produce by accident to say much about the sender.
 */
export function messageEndToEndFormat(contentType: string | undefined): EndToEndFormat | undefined {
    if (!contentType) {
        return undefined;
    }
    const type: string = contentType.split(";")[0].trim().toLowerCase();
    const protocol: string | undefined = headerParams(contentType)["protocol"];
    if (type === "application/pkcs7-mime" || type === "application/x-pkcs7-mime") {
        return "smime";
    }
    if (type === "multipart/signed") {
        if (protocol === "application/pkcs7-signature" || protocol === "application/x-pkcs7-signature") {
            return "smime";
        }
        return protocol === "application/pgp-signature" ? "openpgp" : undefined;
    }
    return type === "multipart/encrypted" && protocol === "application/pgp-encrypted" ? "openpgp" : undefined;
}

/** How far ahead of the clock a stored effective date may be and still be taken as one: a message's effective date is never later
 * than its receipt, so one further ahead than replicas' clocks can disagree was stored before that rule and is no evidence at all. */
export const MAX_EFFECTIVE_DATE_SKEW_MS = 60 * 60 * 1000;

/** `next` when it is newer than `existing` (the anti-downgrade rule for preferences: an older message never overrides what a
 * newer one showed), else `undefined`. An `existing` dated more than `MAX_EFFECTIVE_DATE_SKEW_MS` after `now` counts as none, so a
 * future-dated observation recorded once doesn't keep every later message from counting. */
export function newerObservation(existing: ObservedFormat | undefined, next: ObservedFormat | undefined, now: number = Date.now()): ObservedFormat | undefined {
    const current: ObservedFormat | undefined = existing && existing.at <= now + MAX_EFFECTIVE_DATE_SKEW_MS ? existing : undefined;
    return next && (!current || next.at > current.at) ? next : undefined;
}
