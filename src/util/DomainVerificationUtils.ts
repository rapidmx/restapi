///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { DnsResolver } from "../dns/DnsResolver.js";
import type { Domain } from "../models/types.js";

/** The prefix an admin's TXT record must start with, followed by the domain's own `verificationToken` -
 * see `buildVerificationTxtValue()`. */
export const DOMAIN_VERIFICATION_TXT_PREFIX = "rapidmx-domain-verification=";

/** The label the ownership TXT record lives under: `_rapidmx-verify.<domain>`. A name of its own, never the apex, so verifying a domain never puts its
 * apex TXT set (SPF, other services' site verifications) under RapidMX's control when the record is published automatically: external-dns owns a
 * name's whole set. Starting with `_`, it can never collide with a host name. */
export const DOMAIN_VERIFICATION_RECORD_LABEL = "_rapidmx-verify";

/** Whether a token found at the apex, where it lived before `_rapidmx-verify`, still verifies a domain: the default of
 * `mail:domain_verification:accept_legacy_apex`, which flips to false in a later minor release to end the transition. */
export const DEFAULT_ACCEPT_LEGACY_APEX = true;

/** Whether `value`, the configured `mail:domain_verification:accept_legacy_apex`, accepts the legacy apex: off for `false`, `0` and the text `"false"`,
 * `"0"`, `"no"` or `"off"` (a value set through the environment arrives as text, and `"false"` is truthy), on for anything else, the default when unset. */
export function acceptsLegacyApex(value: unknown): boolean {
    if (value === undefined || value === null) {
        return DEFAULT_ACCEPT_LEGACY_APEX;
    }
    if (typeof value === "string") {
        return !["false", "0", "no", "off"].includes(value.trim().toLowerCase());
    }
    return value !== false && value !== 0;
}

/** The exact TXT record value an admin must add to prove ownership. */
export function buildVerificationTxtValue(token: string): string {
    return `${DOMAIN_VERIFICATION_TXT_PREFIX}${token}`;
}

/** The name the ownership TXT record goes at: `_rapidmx-verify.<domain name>`. */
export function buildVerificationRecordName(domainName: string): string {
    return `${DOMAIN_VERIFICATION_RECORD_LABEL}.${domainName}`;
}

/** Where a domain's ownership token was found: at `_rapidmx-verify.<domain>` (`"record"`), or only at the domain's apex, its old location
 * (`"legacy_apex"`). */
export type DomainVerificationLocation = "record" | "legacy_apex";

/** What `findDomainVerification()` saw. */
export interface DomainVerificationResult {
    /** Whether the token proves ownership: found at the record, or at the apex while the legacy location is accepted. */
    verified: boolean;
    /** Where the token that verified the domain was found; unset when it isn't verified. */
    location?: DomainVerificationLocation;
    /** Whether the token is at `_rapidmx-verify.<domain>`. */
    atRecord: boolean;
    /** Whether the token is (still) at the apex, accepted there or not: what the console's "the root value can then be removed" hint is shown for. */
    atLegacyApex: boolean;
}

/** Whether any TXT record at `hostname` is exactly `expected`, after rejoining the chunks one record was split into. Never throws: NXDOMAIN, no TXT
 * records and network errors all mean "not there". */
async function hasTxtValue(dnsResolver: Pick<DnsResolver, "resolveTxt">, hostname: string, expected: string): Promise<boolean> {
    try {
        const records: string[][] = await dnsResolver.resolveTxt(hostname);
        return records.some((chunks) => chunks.join("").trim() === expected);
    } catch {
        return false;
    }
}

/**
 * Looks for `domain`'s ownership token at `_rapidmx-verify.<domain>` and at the apex, its old location, at once. The token verifies the domain at the
 * record, or at the apex while `acceptLegacyApex` is on (`mail:domain_verification:accept_legacy_apex`, the transition; as `acceptsLegacyApex()` reads
 * it, so the text "false" from the environment turns it off). A single TXT record can be
 * split into several strings (RFC 1035's 255-byte limit); `DnsResolver.resolveTxt()` returns each record as `string[]`, so chunks are rejoined before
 * comparing. Never throws.
 */
export async function findDomainVerification(
    dnsResolver: Pick<DnsResolver, "resolveTxt">,
    domain: Pick<Domain, "name" | "verificationToken">,
    acceptLegacyApex: boolean = DEFAULT_ACCEPT_LEGACY_APEX,
): Promise<DomainVerificationResult> {
    const expected: string = buildVerificationTxtValue(domain.verificationToken);
    const [atRecord, atLegacyApex] = await Promise.all([
        hasTxtValue(dnsResolver, buildVerificationRecordName(domain.name), expected),
        hasTxtValue(dnsResolver, domain.name, expected),
    ]);
    if (atRecord) {
        return { verified: true, location: "record", atRecord, atLegacyApex };
    }
    if (atLegacyApex && acceptsLegacyApex(acceptLegacyApex)) {
        return { verified: true, location: "legacy_apex", atRecord, atLegacyApex };
    }
    return { verified: false, atRecord, atLegacyApex };
}

/** Whether `domain`'s ownership token verifies it: `findDomainVerification()`'s `verified`. Never throws. */
export async function checkDomainVerification(
    dnsResolver: Pick<DnsResolver, "resolveTxt">,
    domain: Pick<Domain, "name" | "verificationToken">,
    acceptLegacyApex: boolean = DEFAULT_ACCEPT_LEGACY_APEX,
): Promise<boolean> {
    return (await findDomainVerification(dnsResolver, domain, acceptLegacyApex)).verified;
}
