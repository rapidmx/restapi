///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { readFileSync } from "node:fs";
import {
    buildDesiredState,
    buildHostEndpointSets,
    domainDnsRecordsV1,
    domainEndpointSetId,
    hostsEndpointSetId,
    isGlobalUnicastAddress,
    normalizePublicAddresses,
    normalizePublishHosts,
    providerForName,
    publishTtl,
    type DesiredStateInput,
} from "../../src/dns/DnsDesiredState.js";
import type { DnsOperation, DnsProvider, Domain } from "../../src/models/types.js";

function fixture(name: string): any {
    return JSON.parse(readFileSync(new URL(`../fixtures/dns-api/v1/${name}.json`, import.meta.url), "utf8"));
}

function provider(fields: Partial<DnsProvider> = {}): DnsProvider {
    return {
        uid: "cloudflare-main",
        name: "Cloudflare",
        nameKey: "cloudflare",
        type: "cloudflare",
        zones: ["example.com"],
        options: { zoneIds: ["0123456789abcdef0123456789abcdef"] },
        secretRef: { backend: "openbao", path: "dns/cloudflare-main", keys: ["apiToken"], generation: 1 },
        enabled: true,
        allowTakeover: false,
        ...fields,
    } as DnsProvider;
}

function domain(fields: Partial<Domain> = {}): Domain {
    return { uid: "example.com", name: "example.com", enabled: true, verified: false, verificationToken: "3f9c1d", dnsProviderUid: "cloudflare-main", ...fields } as Domain;
}

const ctx = { mxHostname: "mail.example.com", ttl: 300 };

describe("DNS desired state", () => {
    describe("endpoint set ids", () => {
        it("names a domain's set after its name with dots as hyphens, as the shared fixture does", () => {
            expect(domainEndpointSetId("example.com")).toBe("domain-example-com");
            expect(domainEndpointSetId("mail.example.co.uk")).toBe("domain-mail-example-co-uk");
            expect(hostsEndpointSetId("cloudflare-main")).toBe("hosts-cloudflare-main");
        });

        it("adds a hash when the name has a hyphen, which the mapping would make ambiguous, or when it is too long", () => {
            const a = domainEndpointSetId("a-b.example.com");
            const b = domainEndpointSetId("a.b-example.com");
            expect(a).toMatch(/^domain-a-b-example-com-[0-9a-f]{8}$/);
            expect(b).toMatch(/^domain-a-b-example-com-[0-9a-f]{8}$/);
            expect(a).not.toBe(b);
            const long = domainEndpointSetId(`${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.com`);
            expect(long.length).toBeLessThanOrEqual(180);
            expect(long).toMatch(/^domain-a+-b+-c*[a-z-]*-[0-9a-f]{8}$/);
            expect(domainEndpointSetId("x".repeat(63) + ".example.com")).toBe(domainEndpointSetId("x".repeat(63) + ".example.com"));
        });
    });

    describe("public addresses and hosts", () => {
        it("accepts only global unicast addresses", () => {
            for (const ok of ["203.0.114.7", "8.8.8.8", "2606:4700:4700::1111", "2a01:4f8::1"]) {
                expect(isGlobalUnicastAddress(ok), ok).toBe(true);
            }
            for (const bad of ["10.0.0.1", "172.16.4.2", "192.168.1.1", "127.0.0.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fd00::1", "ff02::1", "::ffff:10.0.0.1", "mail.example.com", ""]) {
                expect(isGlobalUnicastAddress(bad), bad).toBe(false);
            }
        });

        it("takes the address list as a list or the JSON string the chart renders, refusing the rest", () => {
            expect(normalizePublicAddresses(["203.0.114.7", "10.0.0.1", "2606:4700::1", "203.0.114.7"])).toEqual({ addresses: ["203.0.114.7", "2606:4700::1"], refused: ["10.0.0.1"] });
            expect(normalizePublicAddresses('["203.0.114.7"]')).toEqual({ addresses: ["203.0.114.7"], refused: [] });
            expect(normalizePublicAddresses(undefined)).toEqual({ addresses: [], refused: [] });
            expect(normalizePublicAddresses("not json")).toEqual({ addresses: [], refused: ["not json"] });
        });

        it("takes the host list as a list or JSON string, skipping invalid entries", () => {
            const { hosts, invalid } = normalizePublishHosts(
                JSON.stringify([
                    { name: "Mail.Example.com.", type: "address" },
                    { name: "auth.example.com", type: "cname" },
                    { name: "x.example.com", type: "cname", target: "elsewhere.example.net" },
                    { name: "bad name", type: "address" },
                    { name: "y.example.com", type: "mx" },
                    "z.example.com",
                ]),
            );
            expect(hosts).toEqual([
                { name: "mail.example.com", type: "address" },
                { name: "auth.example.com", type: "cname" },
                { name: "x.example.com", type: "cname", target: "elsewhere.example.net" },
            ]);
            expect(invalid).toBe(3);
            expect(normalizePublishHosts(undefined)).toEqual({ hosts: [], invalid: 0 });
        });

        it("publishes each host through the provider with the most specific zone covering it, the rest manual", () => {
            const providers = [provider(), provider({ uid: "sub", zones: ["mail.example.com"] }), provider({ uid: "other", zones: ["other.com"] })];
            expect(providerForName("mail.example.com", providers)?.uid).toBe("sub");
            expect(providerForName("auth.example.com", providers)?.uid).toBe("cloudflare-main");
            expect(providerForName("nowhere.net", providers)).toBeUndefined();

            const { endpointSets, manual } = buildHostEndpointSets(
                [
                    { name: "mail.example.com", type: "address" },
                    { name: "auth.example.com", type: "cname" },
                    { name: "outside.net", type: "cname" },
                ],
                ["203.0.114.7", "2606:4700::1"],
                providers,
                ctx,
            );
            expect(endpointSets).toEqual([
                { id: "hosts-cloudflare-main", providerUid: "cloudflare-main", records: [{ dnsName: "auth.example.com", recordType: "CNAME", targets: ["mail.example.com"], ttl: 300 }] },
                {
                    id: "hosts-sub",
                    providerUid: "sub",
                    records: [
                        { dnsName: "mail.example.com", recordType: "A", targets: ["203.0.114.7"], ttl: 300 },
                        { dnsName: "mail.example.com", recordType: "AAAA", targets: ["2606:4700::1"], ttl: 300 },
                    ],
                },
            ]);
            expect(manual).toEqual([{ name: "outside.net", reason: "outside_zones" }]);
        });

        it("publishes no address record while there are no public addresses, and says why", () => {
            const { endpointSets, manual } = buildHostEndpointSets([{ name: "mail.example.com", type: "address" }], [], [provider()], ctx);
            expect(endpointSets).toEqual([]);
            expect(manual).toEqual([{ name: "mail.example.com", reason: "no_addresses" }]);
        });

        it("publishes no CNAME to the mail host while none is configured", () => {
            const { endpointSets, manual } = buildHostEndpointSets([{ name: "auth.example.com", type: "cname" }], [], [provider()], { mxHostname: "", ttl: 300 });
            expect(endpointSets).toEqual([]);
            expect(manual).toEqual([{ name: "auth.example.com", reason: "no_target" }]);
        });
    });

    describe("a domain's records", () => {
        it("publishes what the checklist recommends, minus manual records, values unquoted", () => {
            const records = domainDnsRecordsV1(domain({ dkimSelector: "mail", dkimPublicKey: "KEY" }), provider(), ctx);
            expect(records).toEqual([
                { dnsName: "_rapidmx-verify.example.com", recordType: "TXT", targets: ["rapidmx-domain-verification=3f9c1d"], ttl: 300 },
                { dnsName: "example.com", recordType: "MX", targets: ["10 mail.example.com"], ttl: 300 },
                { dnsName: "mail._domainkey.example.com", recordType: "TXT", targets: ["v=DKIM1; k=rsa; p=KEY"], ttl: 300 },
                { dnsName: "_dmarc.example.com", recordType: "TXT", targets: ["v=DMARC1; p=none;"], ttl: 300 },
                { dnsName: "openpgpkey.example.com", recordType: "CNAME", targets: ["mail.example.com"], ttl: 300 },
            ]);
        });

        it("leaves out MX and SRV on rfc2136, records not configured yet, and SPF unless the apex TXT set is managed", () => {
            const rfc = provider({ type: "rfc2136", options: { hosts: ["ns1.example.com"], zone: "example.com" } });
            const types = (records: { recordType: string; dnsName: string }[]) => records.map((r) => `${r.recordType} ${r.dnsName}`);
            expect(types(domainDnsRecordsV1(domain(), rfc, { ...ctx, autodiscoverHostname: "mail.example.com" }))).toEqual([
                "TXT _rapidmx-verify.example.com",
                "TXT _dmarc.example.com",
                "CNAME openpgpkey.example.com",
                "CNAME autodiscover.example.com",
            ]);
            const managed = domain({ apexTxt: { managed: true, keep: ["ms=1"], spf: "v=spf1 mx ~all" } });
            expect(domainDnsRecordsV1(managed, provider(), ctx)).toContainEqual({ dnsName: "example.com", recordType: "TXT", targets: ["v=spf1 mx ~all", "ms=1"], ttl: 300 });
            expect(domainDnsRecordsV1(managed, provider(), { mxHostname: "", ttl: 300 }).map((r) => r.recordType)).not.toContain("MX");
        });

        it("raises the TTL to Cloudflare's minimum", () => {
            expect(publishTtl("cloudflare", 60)).toBe(120);
            expect(publishTtl("cloudflare", 300)).toBe(300);
            expect(publishTtl("route53", 60)).toBe(60);
            expect(domainDnsRecordsV1(domain(), provider(), { mxHostname: "", ttl: 30 })[0].ttl).toBe(120);
        });
    });

    describe("buildDesiredState()", () => {
        const input = (fields: Partial<DesiredStateInput> = {}): DesiredStateInput => ({
            version: 42,
            ownerId: "rapidmx-k3x9q2m7a1b4c8d0",
            externalDnsImage: "registry.k8s.io/external-dns/external-dns:v0.23.0",
            providers: [provider()],
            domains: [domain()],
            operations: [],
            hosts: [],
            addresses: [],
            ...fields,
            context: { ...ctx, ...(fields.context ?? {}) },
        });

        it("has the shape of the shared desired-state fixture", () => {
            const state: any = buildDesiredState(input());
            const expected = fixture("desired-state");
            delete expected.futureField;
            const keys = (o: any) => Object.keys(o).sort();
            expect(keys(state)).toEqual(keys(expected));
            expect(keys(state.providers[0])).toEqual(keys(expected.providers[0]));
            expect(keys(state.endpointSets[0])).toEqual(keys(expected.endpointSets[0]));
            expect(keys(state.endpointSets[0].records[0])).toEqual(keys(expected.endpointSets[0].records[0]));
            expect(state).toMatchObject({ apiVersion: "dns.rapidmx.io/v1", kind: "DesiredState", version: 42, ownerId: expected.ownerId, externalDnsImage: expected.externalDnsImage });
            // Exactly the wire shape, list-valued options included (Cloudflare's zoneIds).
            expect(state.providers[0]).toEqual(expected.providers[0]);
            expect(state.endpointSets[0]).toMatchObject({ id: "domain-example-com", providerUid: "cloudflare-main", domainUid: "example.com" });
            for (const record of expected.endpointSets[0].records) {
                expect(state.endpointSets[0].records).toContainEqual(record);
            }
        });

        it("publishes a domain only through an existing provider covering it, disabled domains and providers included", () => {
            const state = buildDesiredState(
                input({
                    providers: [provider(), provider({ uid: "off", zones: ["off.com"], enabled: false, secretRef: null })],
                    domains: [
                        domain(),
                        domain({ uid: "manual.com", name: "manual.com", dnsProviderUid: null }),
                        domain({ uid: "gone.com", name: "gone.com", dnsProviderUid: "deleted" }),
                        domain({ uid: "elsewhere.net", name: "elsewhere.net", dnsProviderUid: "cloudflare-main" }),
                        domain({ uid: "off.com", name: "off.com", dnsProviderUid: "off", enabled: false }),
                    ],
                }),
            );
            expect(state.endpointSets.map((s) => s.id)).toEqual(["domain-example-com", "domain-off-com"]);
            expect(state.providers.find((p) => p.uid === "off")).toEqual({ uid: "off", type: "cloudflare", zones: ["off.com"], options: { zoneIds: ["0123456789abcdef0123456789abcdef"] }, enabled: false });
        });

        it("hands queued and running operations over, and nothing of a credential", () => {
            const op = (fields: Partial<DnsOperation>): DnsOperation => ({ uid: "op", type: "test", providerUid: "cloudflare-main", state: "queued", ...fields }) as DnsOperation;
            const state = buildDesiredState(
                input({
                    operations: [
                        op({ uid: "t1" }),
                        op({ uid: "k1", type: "takeover", state: "running", endpointSetId: "domain-example-com", domainUid: "example.com", records: [{ dnsName: "example.com", recordType: "MX", targets: ["10 mail.example.com"], ttl: 300 }] }),
                        op({ uid: "done", state: "succeeded" }),
                        op({ uid: "failed", state: "failed" }),
                    ],
                }),
            );
            expect(state.operations).toEqual([
                { id: "t1", type: "test", providerUid: "cloudflare-main" },
                { id: "k1", type: "takeover", providerUid: "cloudflare-main", endpointSetId: "domain-example-com", records: [{ dnsName: "example.com", recordType: "MX", targets: ["10 mail.example.com"], ttl: 300 }] },
            ]);
        });

        it("adds the hosts' endpoint sets after the domains'", () => {
            const state = buildDesiredState(input({ hosts: [{ name: "mail.example.com", type: "address" }], addresses: ["203.0.114.7"] }));
            expect(state.endpointSets.map((s) => s.id)).toEqual(["domain-example-com", "hosts-cloudflare-main"]);
        });

        it("leaves out of the hosts' sets a record the deployment's own domain already publishes, in whichever config", () => {
            const hosts = [
                { name: "mail.example.com", type: "address" as const },
                { name: "openpgpkey.example.com", type: "cname" as const },
                { name: "autodiscover.example.com", type: "cname" as const },
                { name: "auth.example.com", type: "cname" as const },
            ];
            const autodiscover = { ...ctx, autodiscoverHostname: "mail.example.com" };
            const state = buildDesiredState(input({ hosts, addresses: ["203.0.114.7"], context: autodiscover }));
            const names = (id: string) => state.endpointSets.find((s) => s.id === id)!.records.map((r) => `${r.recordType} ${r.dnsName}`);
            expect(names("domain-example-com")).toEqual(expect.arrayContaining(["CNAME openpgpkey.example.com", "CNAME autodiscover.example.com"]));
            expect(names("hosts-cloudflare-main")).toEqual(["A mail.example.com", "CNAME auth.example.com"]);
            // No name and type is in two sets.
            const all = state.endpointSets.flatMap((s) => s.records.map((r) => `${r.recordType} ${r.dnsName}`));
            expect(new Set(all).size).toBe(all.length);

            // A host whose zone another config covers more specifically is still not published twice.
            const narrow = provider({ uid: "narrow", zones: ["openpgpkey.example.com"] });
            const split = buildDesiredState(input({ providers: [provider(), narrow], hosts, addresses: ["203.0.114.7"], context: autodiscover }));
            expect(split.endpointSets.map((s) => s.id)).toEqual(["domain-example-com", "hosts-cloudflare-main"]);

            // Once the domain no longer publishes them (here: it is manual), the hosts' set does.
            const manual = buildDesiredState(input({ domains: [domain({ dnsProviderUid: null })], hosts, addresses: ["203.0.114.7"], context: autodiscover }));
            expect(manual.endpointSets.map((s) => s.id)).toEqual(["hosts-cloudflare-main"]);
            expect(manual.endpointSets[0].records.map((r) => `${r.recordType} ${r.dnsName}`)).toEqual([
                "A mail.example.com",
                "CNAME openpgpkey.example.com",
                "CNAME autodiscover.example.com",
                "CNAME auth.example.com",
            ]);
        });

        it("never puts a host's CNAME next to another record a domain publishes at that name, or a host's record next to a domain's CNAME", () => {
            const { endpointSets } = buildHostEndpointSets(
                [
                    { name: "example.com", type: "cname" },
                    { name: "openpgpkey.example.com", type: "address" },
                    { name: "mail.example.com", type: "address" },
                ],
                ["203.0.114.7"],
                [provider()],
                ctx,
                [
                    { dnsName: "example.com", recordType: "MX" },
                    { dnsName: "openpgpkey.example.com", recordType: "CNAME" },
                ],
            );
            expect(endpointSets[0].records.map((r) => `${r.recordType} ${r.dnsName}`)).toEqual(["A mail.example.com"]);
        });
    });
});
