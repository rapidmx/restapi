///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The publication state of the deployment's own hosts (spec 6.3): manual with the reason, pending, published once observed and live, and in conflict, for a
// record of the right type this deployment doesn't own or one of another type that can't stand next to it.
import { checkHostPublication, type HostPublicationInput } from "../../src/dns/DnsHostPublication.js";
import type { ConfigEnvelope, DnsProvider, Domain } from "../../src/models/types.js";
import { StaticDnsResolver } from "../testDoubles.js";

const OWNER = "rapidmx-0123456789abcdef";
const ENVELOPE: ConfigEnvelope = { $enc: 1, kid: "k1", iv: "iv", ct: "ct", tag: "tag" };
const registry = (owner: string = OWNER): string[][] => [[`heritage=external-dns,external-dns/owner=${owner},external-dns/resource=crd/mail/x`]];

function provider(fields: Partial<DnsProvider> = {}): DnsProvider {
    return {
        uid: "cloudflare-main",
        name: "Cloudflare",
        nameKey: "cloudflare",
        type: "cloudflare",
        zones: ["example.com"],
        options: { zoneIds: ["0123456789abcdef0123456789abcdef"] },
        credentials: { apiToken: ENVELOPE },
        credentialsGeneration: 1,
        enabled: true,
        allowTakeover: false,
        ...fields,
    } as DnsProvider;
}

describe("checkHostPublication()", () => {
    let resolver: StaticDnsResolver;

    beforeEach(() => {
        resolver = new StaticDnsResolver();
    });

    const input = (fields: Partial<HostPublicationInput> = {}): HostPublicationInput => ({
        hosts: [
            { name: "mail.example.com", type: "address" },
            { name: "auth.example.com", type: "cname" },
        ],
        addresses: ["203.0.113.7", "2001:db8::7"],
        providers: [provider()],
        domains: [],
        context: { mxHostname: "mail.example.com", ttl: 300 },
        resolver,
        ownerId: OWNER,
        observed: () => false,
        ...fields,
    });
    const stateOf = (list: Awaited<ReturnType<typeof checkHostPublication>>) => Object.fromEntries(list.map((entry) => [`${entry.type} ${entry.recordName}`, entry]));

    it("lists an address host's A and AAAA records and a CNAME host's CNAME, pending until they are observed and live, each with its provider config", async () => {
        const list = await checkHostPublication(input());

        expect(list).toEqual([
            { type: "host_a", recordName: "mail.example.com", recordKind: "A", state: "pending", providerUid: "cloudflare-main" },
            { type: "host_aaaa", recordName: "mail.example.com", recordKind: "AAAA", state: "pending", providerUid: "cloudflare-main" },
            { type: "host_cname", recordName: "auth.example.com", recordKind: "CNAME", state: "pending", providerUid: "cloudflare-main" },
        ]);
    });

    it("says published once the hosts' endpoint is observed, the live values are exactly the desired ones and this deployment owns them", async () => {
        resolver.addressRecords.set("mail.example.com", ["2001:db8::7", "203.0.113.7"]);
        resolver.records.set("rmx-a.mail.example.com", registry());
        resolver.records.set("rmx-aaaa.mail.example.com", registry());
        resolver.cnameRecords.set("auth.example.com", ["Mail.Example.com."]);
        resolver.records.set("rmx-cname.auth.example.com", registry());

        const notObserved = stateOf(await checkHostPublication(input()));
        const observed = stateOf(await checkHostPublication(input({ observed: (id) => id === "hosts-cloudflare-main" })));

        expect(Object.values(notObserved).map((entry) => entry.state)).toEqual(["pending", "pending", "pending"]);
        expect(Object.values(observed).map((entry) => entry.state)).toEqual(["published", "published", "published"]);
    });

    it("stays pending while the live values aren't exactly the desired ones, even once observed", async () => {
        resolver.addressRecords.set("mail.example.com", ["203.0.113.7", "203.0.113.99"]);
        resolver.records.set("rmx-a.mail.example.com", registry());

        const list = stateOf(await checkHostPublication(input({ observed: () => true })));

        expect(list["host_a mail.example.com"].state).toBe("pending");
    });

    it("reports a record of the right type this deployment doesn't own as a conflict that a takeover can resolve", async () => {
        resolver.addressRecords.set("mail.example.com", ["198.51.100.9"]);
        resolver.records.set("rmx-a.mail.example.com", registry("rapidmx-someoneelse"));

        const list = stateOf(await checkHostPublication(input({ observed: () => true })));

        expect(list["host_a mail.example.com"]).toEqual({
            type: "host_a",
            recordName: "mail.example.com",
            recordKind: "A",
            state: "conflict",
            conflictReason: "not_owned",
            providerUid: "cloudflare-main",
        });
        // The AAAA record isn't there: nothing in its way.
        expect(list["host_aaaa mail.example.com"].state).toBe("pending");
    });

    it("reports a CNAME wanted where addresses are, with the addresses the administrator has to delete, whoever else's they are not", async () => {
        resolver.addressRecords.set("auth.example.com", ["192.0.2.1", "2001:db8::1"]);

        const list = stateOf(await checkHostPublication(input()));

        expect(list["host_cname auth.example.com"]).toEqual({
            type: "host_cname",
            recordName: "auth.example.com",
            recordKind: "CNAME",
            state: "conflict",
            conflictReason: "type_mismatch",
            existing: [
                { type: "A", value: "192.0.2.1" },
                { type: "AAAA", value: "2001:db8::1" },
            ],
            providerUid: "cloudflare-main",
        });
    });

    it("doesn't call the addresses this deployment published itself (an earlier CNAME-less publication) a mismatch", async () => {
        resolver.addressRecords.set("auth.example.com", ["192.0.2.1"]);
        resolver.records.set("rmx-a.auth.example.com", registry());

        expect(stateOf(await checkHostPublication(input()))["host_cname auth.example.com"].state).toBe("pending");
    });

    it("reports addresses wanted where a CNAME is, naming the CNAME, unless it is this deployment's own, which is being replaced", async () => {
        const hosts = [{ name: "auth.example.com", type: "address" as const }];
        resolver.cnameRecords.set("auth.example.com", ["mail.example.com"]);

        const foreign = stateOf(await checkHostPublication(input({ hosts })));
        expect(foreign["host_a auth.example.com"]).toMatchObject({ state: "conflict", conflictReason: "type_mismatch", existing: [{ type: "CNAME", value: "mail.example.com" }] });
        expect(foreign["host_aaaa auth.example.com"]).toMatchObject({ state: "conflict", conflictReason: "type_mismatch" });

        // An address lookup that follows the CNAME finds its target's addresses: still no "published", and no conflict over records not owned.
        resolver.records.set("rmx-cname.auth.example.com", registry());
        resolver.addressRecords.set("auth.example.com", ["203.0.113.7"]);
        const own = stateOf(await checkHostPublication(input({ hosts, observed: () => true })));
        expect(own["host_a auth.example.com"].state).toBe("pending");
    });

    it("lists a host no provider config covers, and one with no address or no mail host to point at, as manual with the reason", async () => {
        const list = await checkHostPublication(
            input({
                hosts: [
                    { name: "mail.example.org", type: "address" },
                    { name: "auth.example.com", type: "cname" },
                    { name: "box.example.com", type: "address" },
                ],
                addresses: [],
                context: { mxHostname: "", ttl: 300 },
            }),
        );

        expect(list).toEqual([
            { type: "host_a", recordName: "mail.example.org", recordKind: "A", state: "manual", manualReason: "outside_zones" },
            { type: "host_cname", recordName: "auth.example.com", recordKind: "CNAME", state: "manual", manualReason: "no_target", providerUid: "cloudflare-main" },
            { type: "host_a", recordName: "box.example.com", recordKind: "A", state: "manual", manualReason: "no_addresses", providerUid: "cloudflare-main" },
        ]);
    });

    it("leaves out a host record a domain's set publishes, which that domain's own check reports", async () => {
        const domain = { uid: "example.com", name: "example.com", enabled: true, verified: false, verificationToken: "t", dnsProviderUid: "cloudflare-main" } as Domain;

        const list = await checkHostPublication(input({ domains: [domain], hosts: [{ name: "openpgpkey.example.com", type: "cname" }, { name: "auth.example.com", type: "cname" }] }));

        expect(list.map((entry) => entry.recordName)).toEqual(["auth.example.com"]);
    });

    it("judges nothing it can't look up: no owner id means no conflict, a resolver without address lookups means an address is never live", async () => {
        resolver.addressRecords.set("mail.example.com", ["198.51.100.9"]);
        const noOwner = stateOf(await checkHostPublication(input({ ownerId: undefined, observed: () => true })));
        expect(noOwner["host_a mail.example.com"].state).toBe("pending");

        const noAddresses = { resolveTxt: resolver.resolveTxt.bind(resolver), resolveMx: resolver.resolveMx.bind(resolver), resolveCname: resolver.resolveCname.bind(resolver), resolveSrv: resolver.resolveSrv.bind(resolver) };
        const blind = stateOf(await checkHostPublication(input({ resolver: noAddresses, observed: () => true })));
        expect(blind["host_a mail.example.com"].state).toBe("pending");
        expect(blind["host_cname auth.example.com"].state).toBe("pending");
    });
});
