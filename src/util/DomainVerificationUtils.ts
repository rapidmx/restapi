///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { DnsResolver } from "../dns/DnsResolver.js";
import type { Domain } from "../models/types.js";

/** The prefix an admin's TXT record must start with, followed by the domain's own `verificationToken` -
 * see `buildVerificationTxtValue()`. */
export const DOMAIN_VERIFICATION_TXT_PREFIX = "rapidmx-domain-verification=";

/** The exact TXT record value an admin must add to `domain.name` to prove ownership. */
export function buildVerificationTxtValue(token: string): string {
    return `${DOMAIN_VERIFICATION_TXT_PREFIX}${token}`;
}

/**
 * Looks up `domain.name`'s TXT records and returns whether one matches its `verificationToken` exactly.
 * A single TXT record can be split into multiple string chunks (RFC 1035's 255-byte-per-string limit) -
 * `DnsResolver.resolveTxt()` already returns each record as `string[]`, so chunks are rejoined before
 * comparing. Never throws - NXDOMAIN, no TXT records, and network errors all just mean "not verified yet".
 */
export async function checkDomainVerification(dnsResolver: DnsResolver, domain: Domain): Promise<boolean> {
    const expected: string = buildVerificationTxtValue(domain.verificationToken);
    try {
        const records: string[][] = await dnsResolver.resolveTxt(domain.name);
        return records.some((chunks) => chunks.join("").trim() === expected);
    } catch {
        return false;
    }
}
