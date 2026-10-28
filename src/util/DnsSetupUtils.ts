///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { randomBytes } from "crypto";
import * as net from "net";
import { getDnsProviderType, isDnsProviderType, isNameInZones } from "../dns/DnsProviderTypes.js";
import type { DnsMxRecord, DnsResolver, DnsSrvRecord } from "../dns/DnsResolver.js";
import type { DnsConflictReason, DnsExistingRecord, DnsManualReason, DnsProvider, DnsRecordPublication, DnsRecordType, Domain } from "../models/types.js";
import { buildVerificationRecordName, buildVerificationTxtValue, DEFAULT_ACCEPT_LEGACY_APEX, findDomainVerification } from "./DomainVerificationUtils.js";

// Defined next to `Domain.dnsPublication`, which records publication per record type; re-exported here, where it always lived.
export type { DnsManualReason, DnsRecordType };

/** The kinds of record a domain needs. */
export type DnsRecordKind = "TXT" | "MX" | "CNAME" | "SRV";

/** The SPF record this server recommends: mail for the domain comes from its MX hosts. */
export const DEFAULT_SPF_VALUE = "v=spf1 mx ~all";

/** The live-checked status of one DNS record this server recommends for a `Domain` - see
 * `checkDnsSetup()`. Always computed fresh, never persisted (unlike `Domain.verified`). */
export interface DnsRecordCheck {
    type: DnsRecordType;
    recordKind: DnsRecordKind;
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
    /** Only when asked for (`DnsSetupOptions.publication`), and only for a configured record: whether the record is published automatically -
     * `"published"` (observed by external-dns and live with exactly the desired values), `"pending"`, `"conflict"` (a record this deployment doesn't
     * own is there) - or by hand (`"manual"`, with `manualReason`). The live check (`found`/`matches`) stays the source of truth for "is it working". */
    publication?: DnsRecordPublication["state"];
    manualReason?: DnsManualReason;
    /** With `publication: "conflict"`: `"not_owned"` (a record of the right type this deployment doesn't own: a takeover can overwrite it) or
     * `"type_mismatch"` (a record of another type that can't stand next to this one, in `existing`: the admin deletes it at their DNS host). */
    conflictReason?: DnsConflictReason;
    /** With `conflictReason: "type_mismatch"`: the live records in the way. */
    existing?: DnsExistingRecord[];
    /** `ownership` only: the token is (still) at the domain's root, where it lived before `_rapidmx-verify`. The console says it can be moved, or
     * removed from there once it is at the new name. */
    legacyApex?: boolean;
}

/** What `buildDesiredDnsRecords()` needs beyond the domain: the deployment's mail host, and the Autodiscover host while that plugin is active. */
export interface DesiredDnsRecordContext {
    /** `mail:dns:mx_hostname`; empty when not configured. */
    mxHostname: string;
    /** `undefined` while `@rapidmx/autodiscover-plugin` isn't active (no Autodiscover records at all); `""` while it is but has no valid public URL
     * (the records are listed, not configured); else the host. */
    autodiscoverHostname?: string;
}

/** One record a domain needs: what the checklist recommends and what the DNS controller publishes. */
export interface DesiredDnsRecord {
    type: DnsRecordType;
    recordKind: DnsRecordKind;
    recordName: string;
    /** `false` while there isn't enough information to know the value (see `DnsRecordCheck.configured`); such a record is never published. */
    configured: boolean;
    /** The value as the checklist shows it. */
    recommendedValue?: string;
    /** The values as they are published: one per value of the record set, unquoted (an SRV target ends with a dot). Empty when not configured. */
    values: string[];
}

/** The recommended SRV record's priority/weight/port for `_autodiscover._tcp.<domain>` - only the target
 * hostname is meaningful for this record's purpose, so these are fixed at the conventional "no
 * preference, standard HTTPS port" values. */
const AUTODISCOVER_SRV_PRIORITY = 0;
const AUTODISCOVER_SRV_WEIGHT = 0;
const AUTODISCOVER_SRV_PORT = 443;

function normalizeHost(host: string): string {
    return host.trim().toLowerCase().replace(/\.$/, "");
}

function dkimValue(publicKey: string): string {
    return `v=DKIM1; k=rsa; p=${publicKey}`;
}

/** A record whose values are known: the checklist shows the first. */
function record(type: DnsRecordType, recordKind: DnsRecordKind, recordName: string, values: string[], recommendedValue: string = values[0]): DesiredDnsRecord {
    return { type, recordKind, recordName, configured: true, recommendedValue, values };
}

/** A record there isn't enough information for yet. */
function unconfigured(type: DnsRecordType, recordKind: DnsRecordKind, recordName: string): DesiredDnsRecord {
    return { type, recordKind, recordName, configured: false, values: [] };
}

/**
 * Every mail-related DNS record `domain` needs, in the checklist's order: the one source of both the DNS checklist (`checkDnsSetup()`) and the records the
 * DNS controller publishes, so the two can never drift.
 *
 * - `ownership`: the verification token at `_rapidmx-verify.<domain>` (never the apex).
 * - `mx`, `openpgpkey_cname`: once `mail:dns:mx_hostname` is set.
 * - `spf`: `v=spf1 mx ~all` at the apex. While the admin has opted the apex TXT set into RapidMX's management (`apexTxt.managed`) it is published as one
 * set: the chosen SPF value first, then every kept value.
 * - `dkim`: once the domain has a selector and key; `dkim_next` and `dkim_previous` while a rotation holds them.
 * - `dmarc`: always (a safe `p=none` by default).
 * - `autodiscover_cname`, `autodiscover_srv`: only while the Autodiscover plugin is active (see `DesiredDnsRecordContext.autodiscoverHostname`).
 */
export function buildDesiredDnsRecords(domain: Domain, ctx: DesiredDnsRecordContext): DesiredDnsRecord[] {
    const name: string = domain.name;
    const records: DesiredDnsRecord[] = [record("ownership", "TXT", buildVerificationRecordName(name), [buildVerificationTxtValue(domain.verificationToken)])];

    records.push(ctx.mxHostname ? record("mx", "MX", name, [`10 ${ctx.mxHostname}`]) : unconfigured("mx", "MX", name));

    if (domain.apexTxt?.managed) {
        const spf: string = domain.apexTxt.spf || DEFAULT_SPF_VALUE;
        records.push(record("spf", "TXT", name, [spf, ...(domain.apexTxt.keep ?? [])], spf));
    } else {
        records.push(record("spf", "TXT", name, [DEFAULT_SPF_VALUE]));
    }

    if (domain.dkimSelector && domain.dkimPublicKey) {
        records.push(record("dkim", "TXT", `${domain.dkimSelector}._domainkey.${name}`, [dkimValue(domain.dkimPublicKey)]));
    } else {
        records.push(unconfigured("dkim", "TXT", ""));
    }
    const next = domain.dkimRotation?.next;
    if (next?.selector && next.publicKey) {
        records.push(record("dkim_next", "TXT", `${next.selector}._domainkey.${name}`, [dkimValue(next.publicKey)]));
    }
    const previous = domain.dkimRotation?.previous;
    if (previous?.selector && previous.publicKey) {
        records.push(record("dkim_previous", "TXT", `${previous.selector}._domainkey.${name}`, [dkimValue(previous.publicKey)]));
    }

    const policy: "none" | "quarantine" | "reject" = domain.dmarcPolicy ?? "none";
    records.push(record("dmarc", "TXT", `_dmarc.${name}`, [`v=DMARC1; p=${policy};` + (domain.dmarcReportEmail ? ` rua=mailto:${domain.dmarcReportEmail};` : "")]));

    const openpgpkey: string = `openpgpkey.${name}`;
    records.push(ctx.mxHostname ? record("openpgpkey_cname", "CNAME", openpgpkey, [ctx.mxHostname]) : unconfigured("openpgpkey_cname", "CNAME", openpgpkey));

    if (ctx.autodiscoverHostname !== undefined) {
        const host: string = ctx.autodiscoverHostname;
        const cname: string = `autodiscover.${name}`;
        const srv: string = `_autodiscover._tcp.${name}`;
        if (host) {
            const srvValue: string = `${AUTODISCOVER_SRV_PRIORITY} ${AUTODISCOVER_SRV_WEIGHT} ${AUTODISCOVER_SRV_PORT} ${host}`;
            records.push(record("autodiscover_cname", "CNAME", cname, [host]));
            // external-dns needs an SRV target to end with a dot; the checklist shows it the way an admin types it.
            records.push(record("autodiscover_srv", "SRV", srv, [`${srvValue}.`], srvValue));
        } else {
            records.push(unconfigured("autodiscover_cname", "CNAME", cname), unconfigured("autodiscover_srv", "SRV", srv));
        }
    }
    return records;
}

/** A value rfc2136 reads back exactly as written when it is passed unquoted: one character-string (255 bytes at most, all printable ASCII) with nothing that
 * zone-file text treats specially. The same rule as the DNS controller's, which leaves out what fails it (4.2). */
const RFC2136_PLAIN_TXT: RegExp = /^(?:(?!["\\;()$@])[\x21-\x7e]){1,255}$/;

/**
 * Whether `provider`'s external-dns v0.23.0 provider can keep a TXT record of `values` (4.2). Azure writes and reads only the first target of a name, so a name
 * with several values can't be kept. rfc2136 reads back bare character-strings and removes an old value by parsing it as zone-file text, so a value that
 * isn't one plain character-string (a space, `;`, a quote, a backslash, a bracket, `$`, `@`, non-ASCII, or over 255 bytes: SPF, DKIM and DMARC) could never
 * be updated or deleted, and one such value makes the whole record manual. The others keep any TXT value.
 */
export function providerKeepsTxt(type: string, values: readonly string[]): boolean {
    switch (type) {
        case "azure":
            return values.length <= 1;
        case "rfc2136":
            return values.every((value) => RFC2136_PLAIN_TXT.test(value));
        default:
            return true;
    }
}

/**
 * Why `record` is not published automatically for `domain` through `provider` (the provider config the domain is assigned to, `null`/`undefined` when it
 * has none or it no longer exists), or `undefined` when it is published. In order: no provider; the name outside the provider's zones (an assignment the
 * provider no longer covers); a kind the provider can't manage (rfc2136: MX, SRV) or a TXT value it can't keep (`providerKeepsTxt()`); SPF while the apex TXT
 * set isn't managed.
 */
export function dnsManualReason(
    record: Pick<DesiredDnsRecord, "type" | "recordKind" | "recordName" | "values">,
    domain: Pick<Domain, "apexTxt">,
    provider: Pick<DnsProvider, "type" | "zones"> | null | undefined,
): DnsManualReason | undefined {
    if (!provider) {
        return "no_provider";
    }
    if (!isNameInZones(record.recordName, provider.zones)) {
        return "outside_zones";
    }
    const unsupported: readonly string[] = isDnsProviderType(provider.type) ? getDnsProviderType(provider.type).unsupportedRecordKinds : [];
    if (unsupported.includes(record.recordKind) || (record.recordKind === "TXT" && !providerKeepsTxt(provider.type, record.values))) {
        return "kind_unsupported";
    }
    if (record.type === "spf" && !domain.apexTxt?.managed) {
        return "apex_txt_unmanaged";
    }
    return undefined;
}

/** What the checklist's publication state is judged from. */
export interface DnsSetupPublication {
    /** The provider config the domain is assigned to; `null`/`undefined` when manual (or the assignment names one that is gone). */
    provider?: Pick<DnsProvider, "type" | "zones"> | null;
    /** Whether external-dns has observed the domain's current endpoint (`observedGeneration` caught up with `generation`). */
    observed?: boolean;
    /** This deployment's external-dns owner id (`rapidmx-<installationId>`): a live record without its ownership record is a conflict. Unknown, none is
     * reported. */
    ownerId?: string;
}

/** Options of `checkDnsSetup()`. */
export interface DnsSetupOptions {
    /** Whether the ownership token at the apex still counts (`mail:domain_verification:accept_legacy_apex`). Only the hint depends on it. */
    acceptLegacyApex?: boolean;
    /** When set, each configured record also says whether it is published automatically. */
    publication?: DnsSetupPublication;
}

/** Whether external-dns's TXT registry record for the `recordKind` record(s) at `recordName` (`rmx-<kind>.<name>`, the prefix
 * `--txt-prefix=rmx-%{record_type}.` gives it) names `ownerId` as the owner. A failed lookup is "not owned". */
export async function isRecordOwned(dnsResolver: DnsResolver, recordKind: string, recordName: string, ownerId: string): Promise<boolean> {
    try {
        const records: string[][] = await dnsResolver.resolveTxt(`rmx-${recordKind.toLowerCase()}.${recordName}`);
        const owner: RegExp = new RegExp(`(^|,)external-dns/owner=${ownerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(,|$)`);
        return records.some((chunks) => owner.test(chunks.join("").replace(/^"|"$/g, "")));
    } catch {
        return false;
    }
}

/** A live check and, where the lookup answered, every value at the name in the form it is published in (`DesiredDnsRecord.values`): what "published"
 * compares with the desired values. */
interface LiveCheck {
    check: DnsRecordCheck;
    live?: string[];
}

/** `value` as compared with a published one: a TXT value as it is (trimmed); otherwise the host it ends with in lowercase without its final dot. */
function comparable(kind: DnsRecordKind | "A" | "AAAA", value: string): string {
    if (kind === "TXT") {
        return value.trim();
    }
    const parts: string[] = value.trim().split(/\s+/);
    parts[parts.length - 1] = normalizeHost(parts[parts.length - 1]);
    return parts.join(" ");
}

/** Whether the live values at the name are exactly the desired ones, each value once, in any order. */
export function sameValues(kind: DnsRecordKind | "A" | "AAAA", live: readonly string[], desired: readonly string[]): boolean {
    const a: Set<string> = new Set(live.map((value) => comparable(kind, value)));
    const b: Set<string> = new Set(desired.map((value) => comparable(kind, value)));
    return a.size === b.size && [...a].every((value) => b.has(value));
}

/** What `judgeConflict()` found in the way of a record: `replacing` when what stands there is this deployment's own record of another type, which
 * external-dns replaces on its next sync (nothing for the admin to do, and not yet published), or the conflict. */
export type ConflictJudgement = { replacing: true } | { conflictReason: DnsConflictReason; existing?: DnsExistingRecord[] };

/** The record(s) of one live lookup as `DnsExistingRecord`s; a lookup that fails or answers nothing is none. */
async function existingOf(lookup: () => Promise<DnsExistingRecord[]>): Promise<DnsExistingRecord[]> {
    try {
        return await lookup();
    } catch {
        return [];
    }
}

/** The records of types other than CNAME at `name`: its addresses (when the resolver can look them up), MX and TXT records. What a CNAME can't stand next to. */
async function recordsNextTo(dnsResolver: DnsResolver, name: string): Promise<DnsExistingRecord[]> {
    const groups: DnsExistingRecord[][] = await Promise.all([
        existingOf(async () => ((await dnsResolver.resolveAddresses?.(name)) ?? []).map((value) => ({ type: net.isIPv6(value) ? "AAAA" : "A", value }))),
        existingOf(async () => (await dnsResolver.resolveMx(name)).map((r) => ({ type: "MX", value: `${r.priority} ${r.exchange}` }))),
        existingOf(async () => (await dnsResolver.resolveTxt(name)).map((chunks) => ({ type: "TXT", value: chunks.join("") }))),
    ]);
    return groups.flat();
}

/** A name that exists nowhere, one label deeper than `name`'s parent, to see what a wildcard record of the zone answers for it. `undefined` at a root. */
function wildcardProbe(name: string): string | undefined {
    const dot: number = name.indexOf(".");
    return dot > 0 && name.indexOf(".", dot + 1) > 0 ? `rmx-probe-${randomBytes(6).toString("hex")}.${name.slice(dot + 1)}` : undefined;
}

/** `records` without the ones a wildcard of the zone answers as well: they are not at `name`, so the admin can't delete them there and they don't conflict. */
async function withoutWildcard(records: DnsExistingRecord[], name: string, lookup: (probe: string) => Promise<DnsExistingRecord[]>): Promise<DnsExistingRecord[]> {
    const probe: string | undefined = records.length > 0 ? wildcardProbe(name) : undefined;
    if (!probe) {
        return records;
    }
    const wild: DnsExistingRecord[] = await existingOf(() => lookup(probe));
    return records.filter((record) => !wild.some((other) => other.type === record.type && other.value === record.value));
}

/**
 * Judges what is live at a record's name against the record this deployment publishes there, for `ownerId` (nothing is judged while it is unknown):
 *
 * - `type_mismatch`: a CNAME is published and records of other types are there that this deployment doesn't own (they can't stand next to it), or any other
 * type is published and a CNAME is there that it doesn't own. The records are returned for the admin to delete at their DNS host; RapidMX never deletes one
 * and never takes it over. A record this deployment owns is being replaced by the next sync (`replacing`), not in the way. A CNAME is not looked for at
 * the root of a domain (`checkCname: false`), where none can be.
 * - `not_owned`: a record of the type published is there (`found`) and the registry record for it doesn't name `ownerId`.
 *
 * What a wildcard record of the zone answers for the name is not at the name (`withoutWildcard()`) and is left out.
 *
 * The CNAME comes first for every other type because a lookup of the record's own type follows a CNAME to its target: it would find the target's records.
 */
export async function judgeConflict(
    dnsResolver: DnsResolver,
    subject: { recordKind: DnsRecordPublication["recordKind"]; recordName: string; found: boolean; ownerId?: string; checkCname?: boolean },
): Promise<ConflictJudgement | undefined> {
    const { recordKind, recordName, ownerId } = subject;
    if (!ownerId) {
        return undefined;
    }
    if (recordKind !== "CNAME" && subject.checkCname !== false) {
        const lookupCnames = async (name: string): Promise<DnsExistingRecord[]> => (await dnsResolver.resolveCname(name)).map((value) => ({ type: "CNAME", value }));
        const cnames: DnsExistingRecord[] = await withoutWildcard(await existingOf(() => lookupCnames(recordName)), recordName, lookupCnames);
        if (cnames.length > 0) {
            return (await isRecordOwned(dnsResolver, "CNAME", recordName, ownerId)) ? { replacing: true } : { conflictReason: "type_mismatch", existing: cnames };
        }
    }
    if (recordKind === "CNAME" && !subject.found) {
        const next: DnsExistingRecord[] = await withoutWildcard(await recordsNextTo(dnsResolver, recordName), recordName, (probe) => recordsNextTo(dnsResolver, probe));
        const owned: Map<string, boolean> = new Map();
        for (const type of new Set(next.map((record) => record.type))) {
            owned.set(type, await isRecordOwned(dnsResolver, type, recordName, ownerId));
        }
        const foreign: DnsExistingRecord[] = next.filter((record) => !owned.get(record.type));
        if (foreign.length > 0) {
            return { conflictReason: "type_mismatch", existing: foreign };
        }
    }
    if (subject.found && !(await isRecordOwned(dnsResolver, recordKind, recordName, ownerId))) {
        return { conflictReason: "not_owned" };
    }
    return undefined;
}

/** `check` with the conflict `judgement` found, or just pending when it only says the record is being replaced. Returns whether it settled the state. */
function applyJudgement(check: DnsRecordCheck, judgement: ConflictJudgement | undefined): boolean {
    if (!judgement) {
        return false;
    }
    if ("replacing" in judgement) {
        check.publication = "pending";
        return true;
    }
    check.publication = "conflict";
    check.conflictReason = judgement.conflictReason;
    if (judgement.existing) {
        check.existing = judgement.existing;
    }
    return true;
}

/**
 * The publication state of one configured check: manual with its reason, a conflict when a record this deployment doesn't own is there, published once
 * observed and live with exactly the desired values, else pending. The live check's own `matches` is looser ("is it working": any DMARC record, an SPF
 * with `mx`), and the generation external-dns observed may be the one from before the latest change, so a changed value (a stricter DMARC policy, a kept
 * value added to the apex set) stays pending until it is live.
 */
async function publicationOf(dnsResolver: DnsResolver, domain: Domain, desired: DesiredDnsRecord, live: LiveCheck, publication: DnsSetupPublication): Promise<void> {
    const check: DnsRecordCheck = live.check;
    const reason: DnsManualReason | undefined = dnsManualReason(desired, domain, publication.provider);
    if (reason) {
        check.publication = "manual";
        check.manualReason = reason;
        return;
    }
    const judgement: ConflictJudgement | undefined = await judgeConflict(dnsResolver, {
        recordKind: desired.recordKind,
        recordName: desired.recordName,
        found: check.found,
        ownerId: publication.ownerId,
        checkCname: desired.recordName !== domain.name,
    });
    if (applyJudgement(check, judgement)) {
        return;
    }
    const current: boolean = live.live === undefined || sameValues(desired.recordKind, live.live, desired.values);
    check.publication = check.matches && current && publication.observed ? "published" : "pending";
}

/** The ownership check: its token never changes, so the exact match `findDomainVerification()` looks for is what "published" needs too. */
async function checkOwnership(dnsResolver: DnsResolver, domain: Domain, desired: DesiredDnsRecord, acceptLegacyApex: boolean): Promise<LiveCheck> {
    const result = await findDomainVerification(dnsResolver, domain, acceptLegacyApex);
    const check: DnsRecordCheck = { ...base(desired), found: result.atRecord, matches: result.atRecord };
    if (result.atLegacyApex) {
        check.legacyApex = true;
    }
    return { check };
}

/** The check of `desired` before its lookup: not found. */
function base(desired: DesiredDnsRecord): DnsRecordCheck {
    const check: DnsRecordCheck = { type: desired.type, recordKind: desired.recordKind, recordName: desired.recordName, configured: desired.configured, found: false, matches: false };
    if (desired.recommendedValue !== undefined) {
        check.recommendedValue = desired.recommendedValue;
    }
    return check;
}

async function checkMx(dnsResolver: DnsResolver, desired: DesiredDnsRecord, mxHostname: string): Promise<LiveCheck> {
    const check: DnsRecordCheck = base(desired);
    if (!desired.configured) {
        return { check };
    }
    try {
        const records: DnsMxRecord[] = await dnsResolver.resolveMx(desired.recordName);
        check.found = records.length > 0;
        check.matches = records.some((r) => normalizeHost(r.exchange) === normalizeHost(mxHostname));
        check.actualValue = records.map((r) => `${r.priority} ${r.exchange}`).join(", ");
        return { check, live: records.map((r) => `${r.priority} ${r.exchange}`) };
    } catch {
        // found/matches already false - NXDOMAIN/no MX records/network error all just mean "not set up yet".
        return { check };
    }
}

/** A TXT check of an always-configured record (SPF, DMARC): `pick` finds the relevant record among the values at the name, `matches` judges it. */
async function checkTxt(
    dnsResolver: DnsResolver,
    desired: DesiredDnsRecord,
    pick: (values: string[]) => string | undefined,
    matches: (value: string) => boolean,
): Promise<LiveCheck> {
    const check: DnsRecordCheck = base(desired);
    try {
        const values: string[] = (await dnsResolver.resolveTxt(desired.recordName)).map((chunks) => chunks.join(""));
        const value: string | undefined = pick(values);
        check.found = value !== undefined;
        check.matches = value !== undefined && matches(value);
        check.actualValue = value;
        return { check, live: values };
    } catch {
        // found/matches already false.
        return { check };
    }
}

/** A DKIM key check: any record at the selector's name counts as found, the one carrying the key as matching. */
async function checkDkim(dnsResolver: DnsResolver, desired: DesiredDnsRecord): Promise<LiveCheck> {
    const check: DnsRecordCheck = base(desired);
    if (!desired.configured) {
        return { check };
    }
    const key: string = desired.values[0].slice(desired.values[0].indexOf("p=") + 2);
    try {
        const joined: string[] = (await dnsResolver.resolveTxt(desired.recordName)).map((chunks) => chunks.join(""));
        check.found = joined.length > 0;
        check.matches = joined.some((v) => v.includes(`p=${key}`));
        check.actualValue = joined.join(" | ");
        return { check, live: joined };
    } catch {
        // found/matches already false.
        return { check };
    }
}

/**
 * Checks a CNAME this server recommends (`openpgpkey.<domain>` for the OpenPGP Web Key Directory, `autodiscover.<domain>` for MS-OXDISCO discovery) against
 * the host it should point at. The deployment's TLS certificate must also cover the name - an operational note, not something this check can verify.
 */
async function checkCname(dnsResolver: DnsResolver, desired: DesiredDnsRecord): Promise<LiveCheck> {
    const check: DnsRecordCheck = base(desired);
    if (!desired.configured) {
        return { check };
    }
    try {
        const records: string[] = await dnsResolver.resolveCname(desired.recordName);
        check.found = records.length > 0;
        check.matches = records.some((r) => normalizeHost(r) === normalizeHost(desired.values[0]));
        check.actualValue = records.join(", ");
        return { check, live: records };
    } catch {
        // found/matches already false - NXDOMAIN/no CNAME records/network error all just mean "not set up yet".
        return { check };
    }
}

/**
 * Checks the `_autodiscover._tcp.<domain>` SRV record that lets a mail client's MS-OXDISCO discovery find this deployment's Autodiscover endpoint without
 * a separate `autodiscover.` subdomain: the right target on port 443.
 */
async function checkSrv(dnsResolver: DnsResolver, desired: DesiredDnsRecord, host: string): Promise<LiveCheck> {
    const check: DnsRecordCheck = base(desired);
    if (!desired.configured) {
        return { check };
    }
    try {
        const records: DnsSrvRecord[] = await dnsResolver.resolveSrv(desired.recordName);
        check.found = records.length > 0;
        check.matches = records.some((r) => r.port === AUTODISCOVER_SRV_PORT && normalizeHost(r.target) === normalizeHost(host));
        const values: string[] = records.map((r) => `${r.priority} ${r.weight} ${r.port} ${r.target}`);
        check.actualValue = values.join(", ");
        return { check, live: values };
    } catch {
        // found/matches already false.
        return { check };
    }
}

/** The live check of one desired record. */
async function checkRecord(dnsResolver: DnsResolver, domain: Domain, desired: DesiredDnsRecord, ctx: DesiredDnsRecordContext, acceptLegacyApex: boolean): Promise<LiveCheck> {
    switch (desired.type) {
        case "ownership":
            return await checkOwnership(dnsResolver, domain, desired, acceptLegacyApex);
        case "mx":
            return await checkMx(dnsResolver, desired, ctx.mxHostname);
        case "spf":
            return await checkTxt(
                dnsResolver,
                desired,
                (values) => values.find((v) => /^v=spf1\b/i.test(v)),
                (v) => /\bmx\b/i.test(v),
            );
        case "dmarc":
            return await checkTxt(
                dnsResolver,
                desired,
                (values) => values.find((v) => /^v=dmarc1\b/i.test(v)),
                () => true,
            );
        case "dkim":
        case "dkim_next":
        case "dkim_previous":
            return await checkDkim(dnsResolver, desired);
        case "autodiscover_srv":
            return await checkSrv(dnsResolver, desired, ctx.autodiscoverHostname ?? "");
        default:
            return await checkCname(dnsResolver, desired);
    }
}

/**
 * Computes and live-checks every mail-related DNS record this server recommends for `domain` - exactly the records `buildDesiredDnsRecords()` lists:
 * ownership at `_rapidmx-verify.<domain>`, MX, SPF, DKIM (with the next and previous selectors during a rotation), DMARC, the `openpgpkey.` CNAME, and,
 * only while `@rapidmx/autodiscover-plugin` is active, the `autodiscover.<domain>` CNAME and `_autodiscover._tcp.<domain>` SRV records. Each record is
 * checked independently - a failed lookup for one never blanks out the others.
 *
 * `autodiscoverHostname` distinguishes three states for the two Autodiscover record types. `undefined`
 * means the plugin isn't active here, so both checks are left out of the result entirely - a deployment
 * without it shouldn't get a checklist item for a protocol it doesn't serve. `""` (empty) means the plugin
 * is active but `mail:autodiscover:public_url` isn't set to a valid host yet, so both checks are included
 * with `configured: false`. A real hostname means both checks are included and live-checked against it.
 *
 * With `options.publication`, each configured record also says whether it is published automatically, and why not (`dnsManualReason()`).
 */
export async function checkDnsSetup(
    dnsResolver: DnsResolver,
    domain: Domain,
    mxHostname: string,
    autodiscoverHostname?: string,
    options: DnsSetupOptions = {},
): Promise<DnsRecordCheck[]> {
    const ctx: DesiredDnsRecordContext = { mxHostname, autodiscoverHostname };
    const acceptLegacyApex: boolean = options.acceptLegacyApex ?? DEFAULT_ACCEPT_LEGACY_APEX;
    return await Promise.all(
        buildDesiredDnsRecords(domain, ctx).map(async (desired) => {
            const live: LiveCheck = await checkRecord(dnsResolver, domain, desired, ctx, acceptLegacyApex);
            if (options.publication && desired.configured) {
                await publicationOf(dnsResolver, domain, desired, live, options.publication);
            }
            return live.check;
        }),
    );
}
