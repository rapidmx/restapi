///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** One MX record - the priority-ordered hostname a domain accepts inbound mail on. */
export interface DnsMxRecord {
    priority: number;
    exchange: string;
}

/** One SRV record (RFC 2782) - the priority/weight-ordered target host and port a service is advertised on. */
export interface DnsSrvRecord {
    priority: number;
    weight: number;
    port: number;
    target: string;
}

/** Resolver error codes that authoritatively mean "no such record": NXDOMAIN (`ENOTFOUND`) and an existing name without records of the type asked
 * for (`ENODATA`) - Node's `dns` module codes, which `DnsResolver` implementations use too. */
export const DNS_NO_RECORDS_CODES: ReadonlySet<string> = new Set(["ENOTFOUND", "ENODATA"]);

/** Whether a `DnsResolver` lookup failed because the name has no such records (NXDOMAIN, NODATA), as opposed to a lookup that could not be answered
 * (SERVFAIL, a timeout, a refused or unvalidated answer), after which nothing is known about the records. */
export function isDnsNoRecordsError(err: unknown): boolean {
    const code: unknown = (err as { code?: unknown } | null | undefined)?.code;
    return typeof code === "string" && DNS_NO_RECORDS_CODES.has(code);
}

/**
 * A pluggable DNS lookup, used by `Domain` ownership verification (`util/DomainVerificationUtils.ts`)
 * and DNS setup checks (`util/DnsSetupUtils.ts`). Kept behind an interface - like
 * `BlobStore`/`MailTransport` - so tests never touch real DNS.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface DnsResolver {
    /**
     * Resolves the TXT records for `hostname`. Each entry is one TXT record, itself an array of the
     * string chunks that record was split across (RFC 1035 limits a single TXT string to 255 bytes -
     * a resolver may return one record as multiple chunks that must be rejoined to read the full value).
     *
     * @throws if the lookup fails (NXDOMAIN, no TXT records, network error, etc.)
     */
    resolveTxt(hostname: string): Promise<string[][]>;

    /**
     * Resolves the MX records for `hostname`.
     *
     * @throws if the lookup fails (NXDOMAIN, no MX records, network error, etc.)
     */
    resolveMx(hostname: string): Promise<DnsMxRecord[]>;

    /**
     * Resolves the CNAME records for `hostname` - used to check the `autodiscover.<domain>` alias
     * recommended for MS-OXDISCO client discovery (see `util/DnsSetupUtils.ts`'s
     * `checkAutodiscoverCname()`).
     *
     * @throws if the lookup fails (NXDOMAIN, no CNAME records, network error, etc.)
     */
    resolveCname(hostname: string): Promise<string[]>;

    /**
     * Resolves the SRV records for `hostname` - used to check the `_autodiscover._tcp.<domain>` record
     * recommended for MS-OXDISCO client discovery (see `util/DnsSetupUtils.ts`'s
     * `checkAutodiscoverSrv()`).
     *
     * @throws if the lookup fails (NXDOMAIN, no SRV records, network error, etc.)
     */
    resolveSrv(hostname: string): Promise<DnsSrvRecord[]>;
}
