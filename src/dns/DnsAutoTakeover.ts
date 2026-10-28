///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// What the server takes over by itself (spec 9, decided by JP 2026-10-28): when a record RapidMX publishes is in conflict (a live record of the same type is at
// the name and its registry record doesn't name this deployment) and its provider config has `allowTakeover`, a takeover operation is queued without waiting for
// the administrator. Pure planning over what the caller has read; the caller (`BaseDnsDesiredStateRoute`, on the controller's status report) queues, audits and
// announces what is planned.
//
// - For the domains' records AND the deployment's hosts (the hosts' endpoint set, `hosts-<provider uid>`).
// - Never the apex TXT set (SPF and the values kept next to it): only the domain's own opt-in (`PUT mail/domains/:id/apex-txt`, 9.4) takes that over.
// - Never a record whose live counterpart is of another type that can't stand next to it (`type_mismatch`): RapidMX deletes nothing, so there is nothing a
// takeover could do; the admin deletes it at their DNS host.
// - At most once per record name, type and desired values: not again after a takeover of them was queued, whatever became of it (a manual one that failed does
// not count: it may have failed for another record). A changed desired value is a
// different record, and may be queued again.
// - Never while a takeover or restore of the same endpoint set is queued or running.
// - Only after external-dns has observed the endpoint: until then nothing has tried to publish the record, and a registry record just written may not be
// visible yet.
import type { DnsOperation, DnsProvider, Domain } from "../models/types.js";
import { nameBasedUuid } from "../util/UuidUtils.js";
import { checkDnsSetup, type DnsRecordCheck } from "../util/DnsSetupUtils.js";
import { domainDnsRecordsV1, domainEndpointSetId, domainProvider, type DesiredDnsPublishContext, type PublishHost } from "./DnsDesiredState.js";
import type { DnsRecordV1, EndpointSetV1 } from "./DnsDesiredStateApiV1.js";
import { checkHostPublication, hostEndpointSets } from "./DnsHostPublication.js";
import type { DnsResolver } from "./DnsResolver.js";

/** How many domains are looked up at once. */
const DOMAIN_CONCURRENCY = 5;

/** What the plan is made from. */
export interface AutoTakeoverInput {
    providers: readonly DnsProvider[];
    domains: readonly Domain[];
    /** Every operation: the history that keeps a takeover from repeating, and the ones under way that hold a set back. */
    operations: readonly DnsOperation[];
    hosts: readonly PublishHost[];
    addresses: readonly string[];
    /** The mail host and Autodiscover host the domains' records point at, and the TTL. */
    context: DesiredDnsPublishContext;
    resolver: DnsResolver;
    /** This deployment's external-dns owner id (`rapidmx-<installationId>`). */
    ownerId: string;
    /** Whether external-dns has observed the endpoint set `id` at its current generation, as the controller last reported it. */
    observed: (endpointSetId: string) => boolean;
    acceptLegacyApex?: boolean;
}

/** One takeover to queue. */
export interface PlannedTakeover {
    /** A name-based uid of the set and the records: two servers planning the same takeover at once can only create it once. */
    uid: string;
    provider: DnsProvider;
    /** The domain whose records they are; none for the hosts' set. */
    domain?: Domain;
    endpointSetId: string;
    records: DnsRecordV1[];
}

/** What identifies a record's desired state: name, type and values, in any order. */
function recordKey(record: Pick<DnsRecordV1, "dnsName" | "recordType" | "targets">): string {
    return [record.recordType, record.dnsName.toLowerCase(), ...[...record.targets].sort()].join("|");
}

/** The uid of the operation for these records: the same records always give the same uid. */
function takeoverUid(providerUid: string, endpointSetId: string, records: readonly DnsRecordV1[]): string {
    return nameBasedUuid(`dns-takeover:${providerUid}:${endpointSetId}:${records.map(recordKey).sort().join("\n")}`);
}

/** Runs `work` for each of `items`, `DOMAIN_CONCURRENCY` at a time, and returns the results in the order of `items`. */
async function inChunks<I, R>(items: readonly I[], work: (item: I) => Promise<R>): Promise<R[]> {
    const results: R[] = [];
    for (let at = 0; at < items.length; at += DOMAIN_CONCURRENCY) {
        results.push(...(await Promise.all(items.slice(at, at + DOMAIN_CONCURRENCY).map(work))));
    }
    return results;
}

/**
 * The takeovers to queue now (see this file's header for the rules). Looks up the live records of every domain published through a provider config that
 * allows takeover and is enabled, and of that config's hosts, so a caller that has none skips the call.
 */
export async function planAutomaticTakeovers(input: AutoTakeoverInput): Promise<PlannedTakeover[]> {
    const candidates: DnsProvider[] = input.providers.filter((provider) => provider.allowTakeover && provider.enabled);
    if (candidates.length === 0) {
        return [];
    }
    const underway: Set<string> = new Set();
    const taken: Map<string, Set<string>> = new Map();
    for (const operation of input.operations) {
        if (!operation.endpointSetId) {
            continue;
        }
        if ((operation.type === "takeover" || operation.type === "restore") && (operation.state === "queued" || operation.state === "running")) {
            underway.add(operation.endpointSetId);
        }
        // A manual takeover that failed (maybe for the sake of another record of its set) doesn't use up the automatic one for the set's other records.
        if (operation.type === "takeover" && !(operation.state === "failed" && operation.requestedBy)) {
            const key = `${operation.providerUid}/${operation.endpointSetId}`;
            const keys: Set<string> = taken.get(key) ?? new Set();
            for (const record of operation.records ?? []) {
                keys.add(recordKey(record));
            }
            taken.set(key, keys);
        }
    }
    const fresh = (provider: DnsProvider, endpointSetId: string, records: DnsRecordV1[]): DnsRecordV1[] =>
        records.filter((record) => !taken.get(`${provider.uid}/${endpointSetId}`)?.has(recordKey(record)));
    const plan = (provider: DnsProvider, domain: Domain | undefined, endpointSetId: string, records: DnsRecordV1[]): PlannedTakeover[] =>
        records.length === 0 ? [] : [{ uid: takeoverUid(provider.uid, endpointSetId, records), provider, domain, endpointSetId, records }];

    const planned: PlannedTakeover[][] = await inChunks(input.domains, async (domain): Promise<PlannedTakeover[]> => {
        const provider: DnsProvider | undefined = domainProvider(domain, candidates);
        const endpointSetId: string = domainEndpointSetId(domain.uid);
        if (!provider || underway.has(endpointSetId) || !input.observed(endpointSetId)) {
            return [];
        }
        const checks: DnsRecordCheck[] = await checkDnsSetup(input.resolver, domain, input.context.mxHostname, input.context.autodiscoverHostname, {
            acceptLegacyApex: input.acceptLegacyApex,
            publication: { provider, observed: true, ownerId: input.ownerId },
        });
        // Never the apex TXT set (SPF and what is kept next to it), and never a record whose live counterpart is of another type: nothing a takeover can write.
        const types: string[] = checks.filter((check) => check.publication === "conflict" && check.conflictReason === "not_owned" && check.type !== "spf").map((check) => check.type);
        if (types.length === 0) {
            return [];
        }
        return plan(provider, domain, endpointSetId, fresh(provider, endpointSetId, domainDnsRecordsV1(domain, provider, input.context, types)));
    });

    const candidateUids: Set<string> = new Set(candidates.map((provider) => provider.uid));
    const sets: EndpointSetV1[] = hostEndpointSets(input).endpointSets.filter((set) => candidateUids.has(set.providerUid) && !underway.has(set.id) && input.observed(set.id));
    const hostPlans: PlannedTakeover[] = [];
    if (sets.length > 0) {
        const publications = await checkHostPublication({ ...input, onlyProviders: new Set(sets.map((set) => set.providerUid)) });
        for (const set of sets) {
            const provider = candidates.find((candidate) => candidate.uid === set.providerUid) as DnsProvider;
            const inConflict = publications.filter((entry) => entry.state === "conflict" && entry.conflictReason === "not_owned" && entry.providerUid === set.providerUid);
            const records: DnsRecordV1[] = set.records.filter((record) => inConflict.some((entry) => entry.recordName === record.dnsName && entry.recordKind === record.recordType));
            hostPlans.push(...plan(provider, undefined, set.id, fresh(provider, set.id, records)));
        }
    }
    return [...planned.flat(), ...hostPlans];
}
