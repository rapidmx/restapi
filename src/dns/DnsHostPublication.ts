///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Whether the deployment's own hosts (`mail:dns:publish:hosts`, spec 6.3) are published: the same states as a domain's records (`DnsRecordPublication`), judged
// the same way (`judgeConflict()`), for the hosts' endpoint sets `buildHostEndpointSets()` builds. Read by `GET system/dns-providers/hosts` and by the
// automatic takeover (`planAutomaticTakeovers()`).
import * as net from "net";
import type { DnsHostManualReason, DnsProvider, DnsRecordPublication, Domain } from "../models/types.js";
import { judgeConflict, sameValues, type ConflictJudgement } from "../util/DnsSetupUtils.js";
import {
    buildDomainEndpointSets,
    buildHostEndpointSets,
    providerForName,
    type DesiredDnsPublishContext,
    type ManualHost,
    type PublishHost,
} from "./DnsDesiredState.js";
import type { EndpointSetV1 } from "./DnsDesiredStateApiV1.js";
import type { DnsResolver } from "./DnsResolver.js";

/** What the hosts' publication is judged from. */
export interface HostPublicationInput {
    hosts: readonly PublishHost[];
    /** The public addresses, global unicast only (`normalizePublicAddresses()`). */
    addresses: readonly string[];
    providers: readonly DnsProvider[];
    /** Every domain: a host record a domain's endpoint set already publishes is the domain's to report, and is left out here. */
    domains: readonly Domain[];
    context: DesiredDnsPublishContext;
    resolver: DnsResolver;
    /** This deployment's external-dns owner id; unknown, no conflict is reported. */
    ownerId?: string;
    /** Whether external-dns has observed the endpoint set `id` at its current generation, as the controller last reported it. */
    observed: (endpointSetId: string) => boolean;
    /** When given, only the records of the sets of these provider configs are looked up (the other sets are left out of the answer); the hosts that stay manual
     * are listed either way. */
    onlyProviders?: ReadonlySet<string>;
}

/** The kinds of record a host has. */
type HostRecordKind = "A" | "AAAA" | "CNAME";

const HOST_TYPES: Record<HostRecordKind, DnsRecordPublication["type"]> = { A: "host_a", AAAA: "host_aaaa", CNAME: "host_cname" };

/** The hosts' endpoint sets and the hosts that stay manual, exactly as the desired state computes them. */
export function hostEndpointSets(input: Pick<HostPublicationInput, "hosts" | "addresses" | "providers" | "domains" | "context">): {
    endpointSets: EndpointSetV1[];
    manual: ManualHost[];
} {
    const published = buildDomainEndpointSets(input.domains, input.providers, input.context).flatMap((set) => set.records);
    return buildHostEndpointSets(input.hosts, input.addresses, input.providers, input.context, published);
}

/** The live values of a host record of `kind` at `name`, and whether the lookup could be made at all (an address needs a resolver that looks addresses up). */
async function liveValues(dnsResolver: DnsResolver, kind: HostRecordKind, name: string): Promise<string[]> {
    try {
        if (kind === "CNAME") {
            return await dnsResolver.resolveCname(name);
        }
        const addresses: string[] = (await dnsResolver.resolveAddresses?.(name)) ?? [];
        return addresses.filter((address) => (kind === "A" ? net.isIPv4(address) : net.isIPv6(address)));
    } catch {
        return [];
    }
}

/** The record kinds a manual host would have had: A (and AAAA with an IPv6 address) for an address host, a CNAME otherwise. */
function manualKinds(host: PublishHost, addresses: readonly string[]): HostRecordKind[] {
    if (host.type === "cname") {
        return ["CNAME"];
    }
    return addresses.some((address) => net.isIPv6(address)) ? ["A", "AAAA"] : ["A"];
}

/** The publication of one record of a hosts' set. */
async function recordPublication(input: HostPublicationInput, set: EndpointSetV1, record: EndpointSetV1["records"][number]): Promise<DnsRecordPublication> {
    const kind = record.recordType as HostRecordKind;
    const live: string[] = await liveValues(input.resolver, kind, record.dnsName);
    const entry: DnsRecordPublication = { type: HOST_TYPES[kind], recordName: record.dnsName, recordKind: kind, state: "pending", providerUid: set.providerUid };
    const judgement: ConflictJudgement | undefined = await judgeConflict(input.resolver, {
        recordKind: kind,
        recordName: record.dnsName,
        found: live.length > 0,
        ownerId: input.ownerId,
    });
    if (judgement && "conflictReason" in judgement) {
        entry.state = "conflict";
        entry.conflictReason = judgement.conflictReason;
        if (judgement.existing) {
            entry.existing = judgement.existing;
        }
    } else if (!judgement && live.length > 0 && sameValues(kind, live, record.targets) && input.observed(set.id)) {
        entry.state = "published";
    }
    return entry;
}

/**
 * The publication of each of the deployment's hosts, in the order of `hosts` (an address host's A record before its AAAA record):
 *
 * - **manual**, with the reason (`DnsHostManualReason`): no config's zones cover the host (`outside_zones`), no public address (`no_addresses`) or no mail host
 * to point at (`no_target`).
 * - **conflict**: `not_owned` for a record of the right type this deployment doesn't own, `type_mismatch` (with `existing`) for records of another type that
 * can't stand next to it (`judgeConflict()`).
 * - **published**: the hosts' endpoint is observed, the live values are exactly the desired ones and nothing is in conflict. Without a resolver that looks
 * addresses up, an address is never live, so never published.
 * - **pending**: anything else.
 *
 * A host record a domain's endpoint set already publishes is not listed: that domain reports it.
 */
export async function checkHostPublication(input: HostPublicationInput): Promise<DnsRecordPublication[]> {
    const { endpointSets, manual } = hostEndpointSets(input);
    const results: Promise<DnsRecordPublication>[] = [];
    for (const host of input.hosts) {
        const reason: ManualHost["reason"] | undefined = manual.find((m) => m.name === host.name)?.reason;
        if (reason) {
            const providerUid: string | undefined = reason === "outside_zones" ? undefined : providerForName(host.name, input.providers)?.uid;
            for (const kind of manualKinds(host, input.addresses)) {
                const entry: DnsRecordPublication = {
                    type: HOST_TYPES[kind],
                    recordName: host.name,
                    recordKind: kind,
                    state: "manual",
                    manualReason: reason,
                };
                if (providerUid) {
                    entry.providerUid = providerUid;
                }
                results.push(Promise.resolve(entry));
            }
            continue;
        }
        for (const set of endpointSets.filter((candidate) => !input.onlyProviders || input.onlyProviders.has(candidate.providerUid))) {
            for (const record of set.records.filter((candidate) => candidate.dnsName === host.name)) {
                results.push(recordPublication(input, set, record));
            }
        }
    }
    return await Promise.all(results);
}
