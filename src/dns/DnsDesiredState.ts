///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// What the DNS controller is told to publish (spec 6, 7.3): the desired state, built from the provider configs, the domains assigned to them, the
// deployment's own hosts and the queued operations. Pure functions; `BaseDnsDesiredStateRoute` reads the rows and serves the result.
import * as crypto from "crypto";
import * as net from "net";
import type { DnsOperation, DnsOperationRecord, DnsProvider, DnsProviderType, Domain } from "../models/types.js";
import { buildDesiredDnsRecords, dnsManualReason, type DesiredDnsRecord, type DesiredDnsRecordContext } from "../util/DnsSetupUtils.js";
import { savedCredentialKeys } from "./DnsProviderCredentials.js";
import { isNameInZones } from "./DnsProviderTypes.js";
import {
    API_VERSION_V1,
    type DesiredStateV1,
    type DnsProviderV1,
    type DnsRecordKindV1,
    type DnsRecordV1,
    type EndpointSetV1,
    type OperationV1,
} from "./DnsDesiredStateApiV1.js";

/** The external-dns image the controller may run unless the chart pins another (`mail:dns:publish:external_dns_image`). */
export const DEFAULT_EXTERNAL_DNS_IMAGE = "registry.k8s.io/external-dns/external-dns:v0.23.0";

/** The TTL of published records unless configured (`mail:dns:publish:ttl`). */
export const DEFAULT_PUBLISH_TTL = 300;

/** Cloudflare refuses a TTL under 2 minutes (other than "automatic"). */
export const CLOUDFLARE_MIN_TTL = 120;

/** The longest endpoint set id: the controller prefixes it with the release's full name (up to 63 characters) to name a `DNSEndpoint`, whose name may
 * be 253 characters long. */
export const MAX_ENDPOINT_SET_ID_LENGTH = 180;

/** What publishing needs beyond the domain: the hosts of `DesiredDnsRecordContext` and the TTL. */
export interface DesiredDnsPublishContext extends DesiredDnsRecordContext {
    ttl: number;
}

/** One of the deployment's own hosts (`mail:dns:publish:hosts`, rendered by the chart from what it serves): an `address` host gets A/AAAA records for the
 * public addresses, a `cname` host a CNAME to `target` (the mail host when left out). */
export interface PublishHost {
    name: string;
    type: "address" | "cname";
    target?: string;
}

/** A host that stays manual, and why: no provider's zones cover it, there is no public address to point it at, or (a CNAME to the mail host) no mail
 * host is configured. A host a domain's endpoint set already publishes is neither manual nor in the hosts' sets. */
export interface ManualHost {
    name: string;
    reason: "outside_zones" | "no_addresses" | "no_target";
}

/** A host name in lowercase: dot-separated labels of letters, digits and hyphens. The same rule as a `Domain`'s name. */
const DNS_NAME_PATTERN: RegExp = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

function hostName(value: unknown): string | undefined {
    const name: string | undefined = typeof value === "string" ? value.trim().toLowerCase().replace(/\.$/, "") : undefined;
    return name && DNS_NAME_PATTERN.test(name) ? name : undefined;
}

/** A config value that is a list, or the JSON string of one (how the chart passes lists through the environment). Anything else is no list. */
function configList(value: unknown): unknown[] | undefined {
    if (Array.isArray(value)) {
        return value;
    }
    if (typeof value === "string" && value.trim()) {
        try {
            const parsed: unknown = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : undefined;
        } catch {
            return undefined;
        }
    }
    return undefined;
}

/** A short, stable hash of `value`: what tells two names apart that map to the same id. */
function shortHash(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * The id of a domain's endpoint set, from which the controller names its `DNSEndpoint`: `domain-` and the name with dots as hyphens
 * (`domain-example-com`). A name that has a hyphen of its own gets a hash of the name after it, since `a-b.example.com` and `a.b-example.com` would
 * otherwise share an id, and so does one too long for a resource name (cut first).
 */
export function domainEndpointSetId(domainUid: string): string {
    const id: string = `domain-${domainUid.replace(/\./g, "-")}`;
    if (!domainUid.includes("-") && id.length <= MAX_ENDPOINT_SET_ID_LENGTH) {
        return id;
    }
    return `${id.slice(0, MAX_ENDPOINT_SET_ID_LENGTH - 9).replace(/-+$/, "")}-${shortHash(domainUid)}`;
}

/** The id of the endpoint set holding the deployment hosts one provider config publishes. Provider uids are at most 40 characters. */
export function hostsEndpointSetId(providerUid: string): string {
    return `hosts-${providerUid}`;
}

/** A block list of `ranges` of one family. */
function blockList(ranges: readonly (readonly [string, number])[], family: "ipv4" | "ipv6"): net.BlockList {
    const list: net.BlockList = new net.BlockList();
    for (const [prefix, bits] of ranges) {
        list.addSubnet(prefix, bits, family);
    }
    return list;
}

/** IPv4 ranges that are not global unicast. One list per family: Node's `BlockList` also matches an IPv4 address against an IPv6 rule covering its
 * IPv4-mapped form, so the IPv6 list's `::ffff:0:0/96` would refuse every IPv4 address. */
const NON_GLOBAL_IPV4: net.BlockList = blockList(
    [
        ["0.0.0.0", 8], // "this network"
        ["10.0.0.0", 8], // private
        ["100.64.0.0", 10], // CGNAT
        ["127.0.0.0", 8], // loopback
        ["169.254.0.0", 16], // link-local
        ["172.16.0.0", 12], // private
        ["192.0.0.0", 24], // IETF protocol assignments
        ["192.168.0.0", 16], // private
        ["198.18.0.0", 15], // benchmarking
        ["224.0.0.0", 4], // multicast
        ["240.0.0.0", 4], // reserved, broadcast
    ],
    "ipv4",
);

/** IPv6 ranges that are not global unicast. */
const NON_GLOBAL_IPV6: net.BlockList = blockList(
    [
        ["::", 96], // unspecified, loopback, IPv4-compatible
        ["::ffff:0:0", 96], // IPv4-mapped
        ["64:ff9b:1::", 48], // local-use NAT64
        ["fc00::", 7], // unique local
        ["fe80::", 10], // link-local
        ["ff00::", 8], // multicast
    ],
    "ipv6",
);

/** Whether `ip` is an IPv4 or IPv6 literal of a global unicast address: never private, loopback, link-local, CGNAT, multicast or reserved. */
export function isGlobalUnicastAddress(ip: string): boolean {
    const family: number = net.isIP(ip);
    if (family === 4) {
        return !NON_GLOBAL_IPV4.check(ip, "ipv4");
    }
    return family === 6 && !NON_GLOBAL_IPV6.check(ip, "ipv6");
}

/** The public addresses the mail host's A/AAAA records point at (`mail:dns:publish:addresses`, a list or its JSON string): the global unicast ones,
 * each once, and the rest, which the caller logs. */
export function normalizePublicAddresses(value: unknown): { addresses: string[]; refused: string[] } {
    const entries: unknown[] | undefined = configList(value);
    if (!entries) {
        return { addresses: [], refused: typeof value === "string" && value.trim() ? [value] : [] };
    }
    const addresses: string[] = [];
    const refused: string[] = [];
    for (const entry of entries) {
        const ip: string = typeof entry === "string" ? entry.trim() : String(entry);
        if (!isGlobalUnicastAddress(ip)) {
            refused.push(ip);
        } else if (!addresses.includes(ip)) {
            addresses.push(ip);
        }
    }
    return { addresses, refused };
}

/** The deployment's hosts (`mail:dns:publish:hosts`, a list or its JSON string), normalized, and how many entries were invalid (logged by the caller). */
export function normalizePublishHosts(value: unknown): { hosts: PublishHost[]; invalid: number } {
    const entries: unknown[] = configList(value) ?? [];
    const hosts: PublishHost[] = [];
    let invalid = 0;
    for (const entry of entries) {
        const raw = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
        const name: string | undefined = hostName(raw.name);
        const target: string | undefined = raw.target === undefined ? undefined : hostName(raw.target);
        if (!name || (raw.type !== "address" && raw.type !== "cname") || (raw.target !== undefined && !target)) {
            invalid++;
            continue;
        }
        hosts.push(raw.type === "cname" && target ? { name, type: "cname", target } : { name, type: raw.type });
    }
    return { hosts, invalid };
}

/** How specifically `zones` cover `name`: the length of the longest zone that does, -1 when none does. */
export function zoneCoverage(name: string, zones: readonly string[]): number {
    return Math.max(-1, ...zones.filter((zone) => isNameInZones(name, [zone])).map((zone) => zone.length));
}

/** The config in `providers` other than `provider` whose zones cover `name` more specifically than `provider`'s do, if any: a domain may be assigned only to
 * the config that covers it most specifically, since an instance leaves out the zones other configs nest under its own (7.4). Disabled configs count. */
export function moreSpecificProvider<T extends Pick<DnsProvider, "uid" | "zones">>(name: string, provider: Pick<DnsProvider, "uid" | "zones">, providers: readonly T[]): T | undefined {
    const own: number = zoneCoverage(name, provider.zones);
    return providers.find((other) => other.uid !== provider.uid && zoneCoverage(name, other.zones) > own);
}

/** The provider config whose zones cover `name` most specifically (the longest matching zone; the first such config in `providers` on a tie). */
export function providerForName<T extends Pick<DnsProvider, "zones">>(name: string, providers: readonly T[]): T | undefined {
    let best: T | undefined;
    let bestLength = -1;
    for (const provider of providers) {
        const length: number = zoneCoverage(name, provider.zones);
        if (length > bestLength) {
            best = provider;
            bestLength = length;
        }
    }
    return best;
}

/** The TTL records are published with through a provider of `type`: the configured one, raised to Cloudflare's minimum there. */
export function publishTtl(type: DnsProviderType, ttl: number): number {
    return type === "cloudflare" ? Math.max(ttl, CLOUDFLARE_MIN_TTL) : ttl;
}

function toRecordV1(record: DesiredDnsRecord, ttl: number): DnsRecordV1 {
    return { dnsName: record.recordName, recordType: record.recordKind, targets: [...record.values], ttl };
}

/**
 * The records `domain` publishes through `provider`: every configured record `buildDesiredDnsRecords()` lists that isn't manual (`dnsManualReason()`), with
 * unquoted values. `types`, when given, keeps only those record types (a takeover of some of them).
 */
export function domainDnsRecordsV1(domain: Domain, provider: DnsProvider, ctx: DesiredDnsPublishContext, types?: readonly string[]): DnsRecordV1[] {
    const ttl: number = publishTtl(provider.type, ctx.ttl);
    return buildDesiredDnsRecords(domain, ctx)
        .filter((record) => record.configured && !dnsManualReason(record, domain, provider) && (!types || types.includes(record.type)))
        .map((record) => toRecordV1(record, ttl));
}

/** The provider config `domain` is published through: the one it is assigned to, when that still exists and covers it. */
export function domainProvider<T extends DnsProvider>(domain: Pick<Domain, "name" | "dnsProviderUid">, providers: readonly T[]): T | undefined {
    const provider: T | undefined = domain.dnsProviderUid ? providers.find((candidate) => candidate.uid === domain.dnsProviderUid) : undefined;
    return provider && isNameInZones(domain.name, provider.zones) ? provider : undefined;
}

/** Whether `record` would publish a name and type `taken` already holds: the same name and type, or a CNAME next to any record at the name (a CNAME
 * can't share its name with another record). */
function collides(record: Pick<DnsRecordV1, "dnsName" | "recordType">, taken: readonly Pick<DnsRecordV1, "dnsName" | "recordType">[]): boolean {
    return taken.some(
        (other) => other.dnsName === record.dnsName && (other.recordType === record.recordType || other.recordType === "CNAME" || record.recordType === "CNAME"),
    );
}

/**
 * The endpoint sets of the deployment's own hosts: one per provider config publishing any of them (the config whose zones cover a host most
 * specifically), A/AAAA records to `addresses` for an address host and a CNAME for the others. A host no config covers, or an address host while there
 * are no public addresses, stays manual.
 *
 * A record the domains' endpoint sets already publish (`published`: the deployment's own domain publishes `openpgpkey.<domain>` and
 * `autodiscover.<domain>` itself, and the chart lists the same names among the hosts) is left out: two sets holding one name and type would be two
 * `DNSEndpoint`s claiming one record, whose ownership record would flip between them, two external-dns instances could fight over it, and deleting the
 * domain would delete a record the hosts still want. The domain's set publishes it; once the domain stops publishing it, the hosts' set does.
 */
export function buildHostEndpointSets(
    hosts: readonly PublishHost[],
    addresses: readonly string[],
    providers: readonly DnsProvider[],
    ctx: DesiredDnsPublishContext,
    published: readonly Pick<DnsRecordV1, "dnsName" | "recordType">[] = [],
): { endpointSets: EndpointSetV1[]; manual: ManualHost[] } {
    const byProvider: Map<string, DnsRecordV1[]> = new Map();
    const manual: ManualHost[] = [];
    const ipv4: string[] = addresses.filter((ip) => net.isIPv4(ip));
    const ipv6: string[] = addresses.filter((ip) => net.isIPv6(ip));
    for (const host of hosts) {
        const provider: DnsProvider | undefined = providerForName(host.name, providers);
        if (!provider) {
            manual.push({ name: host.name, reason: "outside_zones" });
            continue;
        }
        const ttl: number = publishTtl(provider.type, ctx.ttl);
        const wanted: DnsRecordV1[] = [];
        if (host.type === "address") {
            if (addresses.length === 0) {
                manual.push({ name: host.name, reason: "no_addresses" });
                continue;
            }
            if (ipv4.length > 0) {
                wanted.push({ dnsName: host.name, recordType: "A", targets: ipv4, ttl });
            }
            if (ipv6.length > 0) {
                wanted.push({ dnsName: host.name, recordType: "AAAA", targets: ipv6, ttl });
            }
        } else {
            const target: string = host.target ?? ctx.mxHostname;
            if (!target) {
                // A CNAME to the mail host while `mail:dns:mx_hostname` isn't set: there is nothing to point it at.
                manual.push({ name: host.name, reason: "no_target" });
                continue;
            }
            wanted.push({ dnsName: host.name, recordType: "CNAME", targets: [target], ttl });
        }
        byProvider.set(provider.uid, [...(byProvider.get(provider.uid) ?? []), ...wanted.filter((record) => !collides(record, published))]);
    }
    const endpointSets: EndpointSetV1[] = [...byProvider.entries()]
        .filter(([, records]) => records.length > 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([providerUid, records]) => ({ id: hostsEndpointSetId(providerUid), providerUid, records }));
    return { endpointSets, manual };
}

/** A provider config as the controller sees it: which credentials it has saved and their generation, never a value. */
export function toDnsProviderV1(provider: DnsProvider): DnsProviderV1 {
    const v1: DnsProviderV1 = {
        uid: provider.uid,
        type: provider.type,
        zones: [...provider.zones],
        options: { ...provider.options },
        enabled: provider.enabled,
    };
    const keys: string[] = savedCredentialKeys(provider.credentials);
    if (keys.length > 0) {
        v1.credentials = { keys, generation: provider.credentialsGeneration ?? 0 };
    }
    return v1;
}

/** A queued or running operation as the controller sees it. */
export function toOperationV1(operation: DnsOperation): OperationV1 {
    const v1: OperationV1 = { id: operation.uid, type: operation.type, providerUid: operation.providerUid };
    if (operation.endpointSetId) {
        v1.endpointSetId = operation.endpointSetId;
    }
    if (operation.records && operation.records.length > 0) {
        v1.records = operation.records.map((record: DnsOperationRecord) => ({ ...record, targets: [...record.targets] }));
    }
    return v1;
}

/** Everything the desired state is built from. */
export interface DesiredStateInput {
    version: number;
    ownerId: string;
    externalDnsImage: string;
    providers: DnsProvider[];
    domains: Domain[];
    operations: DnsOperation[];
    hosts: PublishHost[];
    addresses: string[];
    context: DesiredDnsPublishContext;
}

/**
 * The desired state the controller reconciles: every provider config (disabled ones too: their instance is scaled to zero, their records stay), one
 * endpoint set per domain published through an existing config that covers it (disabled domains too: they keep their records), the hosts' endpoint
 * sets without the records a domain's set already publishes, and the operations still queued or running.
 */
export function buildDesiredState(input: DesiredStateInput): DesiredStateV1 {
    const endpointSets: EndpointSetV1[] = [];
    for (const domain of input.domains) {
        const provider: DnsProvider | undefined = domainProvider(domain, input.providers);
        if (!provider) {
            continue;
        }
        const records: DnsRecordV1[] = domainDnsRecordsV1(domain, provider, input.context);
        if (records.length > 0) {
            endpointSets.push({ id: domainEndpointSetId(domain.uid), providerUid: provider.uid, domainUid: domain.uid, records });
        }
    }
    const published: DnsRecordV1[] = endpointSets.flatMap((set) => set.records);
    endpointSets.push(...buildHostEndpointSets(input.hosts, input.addresses, input.providers, input.context, published).endpointSets);
    return {
        apiVersion: API_VERSION_V1,
        kind: "DesiredState",
        version: input.version,
        ownerId: input.ownerId,
        externalDnsImage: input.externalDnsImage,
        providers: input.providers.map(toDnsProviderV1),
        endpointSets,
        operations: input.operations.filter((op) => op.state === "queued" || op.state === "running").map(toOperationV1),
    };
}
