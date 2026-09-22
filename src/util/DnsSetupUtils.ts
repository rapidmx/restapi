///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { DnsMxRecord, DnsResolver, DnsSrvRecord } from "../dns/DnsResolver.js";
import type { Domain } from "../models/types.js";
import { buildVerificationTxtValue, checkDomainVerification } from "./DomainVerificationUtils.js";

/** One of the mail-related DNS record types a domain's setup is checked against. The two `autodiscover_*`
 * types are only ever included in `checkDnsSetup()`'s result while `@rapidmx/autodiscover-plugin` is
 * active for this deployment - see that function's own doc comment. */
export type DnsRecordType = "ownership" | "mx" | "spf" | "dkim" | "dmarc" | "autodiscover_cname" | "autodiscover_srv";

/** The live-checked status of one DNS record this server recommends for a `Domain` - see
 * `checkDnsSetup()`. Always computed fresh, never persisted (unlike `Domain.verified`). */
export interface DnsRecordCheck {
    type: DnsRecordType;
    recordKind: "TXT" | "MX" | "CNAME" | "SRV";
    /** The exact hostname a lookup for this record type is performed against. */
    recordName: string;
    /** `false` when this app doesn't have enough information yet to know what to recommend (no
     * `mail:dns:mx_hostname` configured for `mx`, no `dkimSelector`/`dkimPublicKey` set for `dkim`, or no
     * valid `mail:autodiscover:public_url` configured for `autodiscover_cname`/`autodiscover_srv`) -
     * `recommendedValue`/`found`/`matches` are meaningless in that state. */
    configured: boolean;
    /** The value this server recommends adding, in a human-readable form suitable for direct display. */
    recommendedValue?: string;
    /** Whether a live record of the right kind/format exists at all. */
    found: boolean;
    /** Whether the live record satisfies the recommendation. */
    matches: boolean;
    /** The raw live value(s) found, for display/debugging. */
    actualValue?: string;
}

function normalizeHost(host: string): string {
    return host.trim().toLowerCase().replace(/\.$/, "");
}

async function checkOwnership(dnsResolver: DnsResolver, domain: Domain): Promise<DnsRecordCheck> {
    const matches: boolean = await checkDomainVerification(dnsResolver, domain);
    return {
        type: "ownership",
        recordKind: "TXT",
        recordName: domain.name,
        configured: true,
        recommendedValue: buildVerificationTxtValue(domain.verificationToken),
        found: matches,
        matches,
    };
}

async function checkMx(dnsResolver: DnsResolver, domain: Domain, mxHostname: string): Promise<DnsRecordCheck> {
    const base: DnsRecordCheck = {
        type: "mx",
        recordKind: "MX",
        recordName: domain.name,
        configured: !!mxHostname,
        found: false,
        matches: false,
    };
    if (!mxHostname) {
        return base;
    }
    base.recommendedValue = `10 ${mxHostname}`;
    try {
        const records: DnsMxRecord[] = await dnsResolver.resolveMx(domain.name);
        base.found = records.length > 0;
        base.matches = records.some((r) => normalizeHost(r.exchange) === normalizeHost(mxHostname));
        base.actualValue = records.map((r) => `${r.priority} ${r.exchange}`).join(", ");
    } catch {
        // found/matches already false - NXDOMAIN/no MX records/network error all just mean "not set up yet".
    }
    return base;
}

async function checkSpf(dnsResolver: DnsResolver, domain: Domain): Promise<DnsRecordCheck> {
    const base: DnsRecordCheck = {
        type: "spf",
        recordKind: "TXT",
        recordName: domain.name,
        configured: true,
        recommendedValue: "v=spf1 mx ~all",
        found: false,
        matches: false,
    };
    try {
        const records: string[][] = await dnsResolver.resolveTxt(domain.name);
        const spfRecord: string | undefined = records.map((chunks) => chunks.join("")).find((v) => /^v=spf1\b/i.test(v));
        base.found = spfRecord !== undefined;
        base.matches = spfRecord !== undefined && /\bmx\b/i.test(spfRecord);
        base.actualValue = spfRecord;
    } catch {
        // found/matches already false.
    }
    return base;
}

async function checkDkim(dnsResolver: DnsResolver, domain: Domain): Promise<DnsRecordCheck> {
    const configured: boolean = !!(domain.dkimSelector && domain.dkimPublicKey);
    const base: DnsRecordCheck = {
        type: "dkim",
        recordKind: "TXT",
        recordName: configured ? `${domain.dkimSelector}._domainkey.${domain.name}` : "",
        configured,
        found: false,
        matches: false,
    };
    if (!configured) {
        return base;
    }
    base.recommendedValue = `v=DKIM1; k=rsa; p=${domain.dkimPublicKey}`;
    try {
        const records: string[][] = await dnsResolver.resolveTxt(base.recordName);
        const joined: string[] = records.map((chunks) => chunks.join(""));
        base.found = joined.length > 0;
        base.matches = joined.some((v) => v.includes(`p=${domain.dkimPublicKey}`));
        base.actualValue = joined.join(" | ");
    } catch {
        // found/matches already false.
    }
    return base;
}

async function checkDmarc(dnsResolver: DnsResolver, domain: Domain): Promise<DnsRecordCheck> {
    const policy: "none" | "quarantine" | "reject" = domain.dmarcPolicy ?? "none";
    const recordName = `_dmarc.${domain.name}`;
    const recommendedValue: string =
        `v=DMARC1; p=${policy};` + (domain.dmarcReportEmail ? ` rua=mailto:${domain.dmarcReportEmail};` : "");
    const base: DnsRecordCheck = {
        type: "dmarc",
        recordKind: "TXT",
        recordName,
        configured: true,
        recommendedValue,
        found: false,
        matches: false,
    };
    try {
        const records: string[][] = await dnsResolver.resolveTxt(recordName);
        const dmarcRecord: string | undefined = records.map((chunks) => chunks.join("")).find((v) => /^v=dmarc1\b/i.test(v));
        base.found = dmarcRecord !== undefined;
        base.matches = dmarcRecord !== undefined;
        base.actualValue = dmarcRecord;
    } catch {
        // found/matches already false.
    }
    return base;
}

/** The recommended SRV record's priority/weight/port for `_autodiscover._tcp.<domain>` - only the target
 * hostname is meaningful for this record's purpose, so these are fixed at the conventional "no
 * preference, standard HTTPS port" values. */
const AUTODISCOVER_SRV_PRIORITY = 0;
const AUTODISCOVER_SRV_WEIGHT = 0;
const AUTODISCOVER_SRV_PORT = 443;

/**
 * Checks the `autodiscover.<domain>` CNAME (or A/AAAA - only a CNAME is recommended/checked here) that
 * lets a real mail client's MS-OXDISCO discovery sequence find this deployment's Autodiscover endpoint at
 * its conventional subdomain, without an admin having to remember a non-standard hostname. Requires the
 * `autodiscover.<domain>` hostname to also be covered by this deployment's TLS certificate (a SAN, or its
 * own certificate) - an operational note, not something this check can verify.
 */
async function checkAutodiscoverCname(dnsResolver: DnsResolver, domain: Domain, publicHostname: string): Promise<DnsRecordCheck> {
    const recordName = `autodiscover.${domain.name}`;
    const base: DnsRecordCheck = {
        type: "autodiscover_cname",
        recordKind: "CNAME",
        recordName,
        configured: !!publicHostname,
        found: false,
        matches: false,
    };
    if (!publicHostname) {
        return base;
    }
    base.recommendedValue = publicHostname;
    try {
        const records: string[] = await dnsResolver.resolveCname(recordName);
        base.found = records.length > 0;
        base.matches = records.some((r) => normalizeHost(r) === normalizeHost(publicHostname));
        base.actualValue = records.join(", ");
    } catch {
        // found/matches already false - NXDOMAIN/no CNAME records/network error all just mean "not set up yet".
    }
    return base;
}

/**
 * Checks the `_autodiscover._tcp.<domain>` SRV record that lets a real mail client's MS-OXDISCO discovery
 * sequence find this deployment's Autodiscover endpoint without a separate `autodiscover.` subdomain -
 * the preferred recommendation over `autodiscover_cname` wherever obtaining a second TLS certificate is
 * constrained, since the SRV target is this deployment's own already-certed public hostname.
 */
async function checkAutodiscoverSrv(dnsResolver: DnsResolver, domain: Domain, publicHostname: string): Promise<DnsRecordCheck> {
    const recordName = `_autodiscover._tcp.${domain.name}`;
    const base: DnsRecordCheck = {
        type: "autodiscover_srv",
        recordKind: "SRV",
        recordName,
        configured: !!publicHostname,
        found: false,
        matches: false,
    };
    if (!publicHostname) {
        return base;
    }
    base.recommendedValue = `${AUTODISCOVER_SRV_PRIORITY} ${AUTODISCOVER_SRV_WEIGHT} ${AUTODISCOVER_SRV_PORT} ${publicHostname}`;
    try {
        const records: DnsSrvRecord[] = await dnsResolver.resolveSrv(recordName);
        base.found = records.length > 0;
        base.matches = records.some((r) => r.port === AUTODISCOVER_SRV_PORT && normalizeHost(r.target) === normalizeHost(publicHostname));
        base.actualValue = records.map((r) => `${r.priority} ${r.weight} ${r.port} ${r.target}`).join(", ");
    } catch {
        // found/matches already false.
    }
    return base;
}

/**
 * Computes and live-checks every mail-related DNS record this server recommends for `domain`: the
 * existing ownership TXT record (`util/DomainVerificationUtils.ts`), MX, SPF, DKIM (only once an admin
 * has entered a selector/public key), DMARC (always has a safe "none" default), and, only while
 * `@rapidmx/autodiscover-plugin` is active for this deployment, the `autodiscover.<domain>` CNAME and
 * `_autodiscover._tcp.<domain>` SRV records a real mail client's MS-OXDISCO discovery sequence looks for.
 * Each record type is checked independently - a failed lookup for one never blanks out the others.
 *
 * `autodiscoverHostname` distinguishes three states for the two Autodiscover record types. `undefined`
 * means the plugin isn't active here, so both checks are left out of the result entirely - a deployment
 * without it shouldn't get a checklist item for a protocol it doesn't serve. `""` (empty) means the plugin
 * is active but `mail:autodiscover:public_url` isn't set to a valid host yet, so both checks are included
 * with `configured: false`. A real hostname means both checks are included and live-checked against it.
 */
export async function checkDnsSetup(
    dnsResolver: DnsResolver,
    domain: Domain,
    mxHostname: string,
    autodiscoverHostname?: string,
): Promise<DnsRecordCheck[]> {
    const checks: Promise<DnsRecordCheck>[] = [
        checkOwnership(dnsResolver, domain),
        checkMx(dnsResolver, domain, mxHostname),
        checkSpf(dnsResolver, domain),
        checkDkim(dnsResolver, domain),
        checkDmarc(dnsResolver, domain),
    ];
    if (autodiscoverHostname !== undefined) {
        checks.push(checkAutodiscoverCname(dnsResolver, domain, autodiscoverHostname), checkAutodiscoverSrv(dnsResolver, domain, autodiscoverHostname));
    }
    return await Promise.all(checks);
}
