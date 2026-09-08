///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** One MX record - the priority-ordered hostname a domain accepts inbound mail on. */
export interface DnsMxRecord {
    priority: number;
    exchange: string;
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
}
