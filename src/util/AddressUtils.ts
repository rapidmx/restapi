///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * Normalizes an email address for use as both a lookup key and (for `Mailbox`/`DistributionList`) an entity's
 * own `uid` - trims surrounding whitespace and lowercases the whole address, matching the normalization already
 * applied to an inbound `RCPT TO` value in `BaseMailIngestRoute`.
 */
export function normalizeAddress(address: string): string {
    return address.trim().toLowerCase();
}

/**
 * The lowercased domain of `address` - the part after its one `@` - or `undefined` for an address with no `@`, nothing after
 * it, or more than one (`a@internal.com@evil.com` has no single domain: a parser that reads the first `@` and one that reads
 * the last would name different ones). The one place that reads the domain for a same-organisation, federation or external
 * decision, so they all read the same one.
 */
export function addressDomainOf(address: string): string | undefined {
    const parts: string[] = address.split("@");
    return parts.length === 2 && parts[1].length > 0 ? parts[1].toLowerCase() : undefined;
}

/**
 * Strips a Gmail-style "+tag" from an address's local part - `"user+tag@domain.com"` becomes
 * `"user@domain.com"`. Only the first `+` in the local part is significant (matching Gmail/Exchange
 * convention), so `"user+tag+more@domain.com"` also becomes `"user@domain.com"`. The domain is never touched.
 * Returns `address` unchanged if its local part has no `+` at all, or if it has no `@` at all (not a real
 * address - let the caller's own validation handle that).
 *
 * Used only for inbound delivery-routing resolution (`BaseMailIngestRoute.findMailboxByAddress()`) - a
 * mailbox's real address, as it appears everywhere else (login, `Message.recipients`, etc.), is never
 * plus-stripped.
 */
export function stripPlusTag(address: string): string {
    const atIndex: number = address.indexOf("@");
    if (atIndex < 0) {
        return address;
    }
    const localPart: string = address.slice(0, atIndex);
    const plusIndex: number = localPart.indexOf("+");
    if (plusIndex < 0) {
        return address;
    }
    return localPart.slice(0, plusIndex) + address.slice(atIndex);
}
