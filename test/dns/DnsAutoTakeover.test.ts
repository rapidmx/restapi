///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// What the server queues a takeover of by itself (a provider config with `allowTakeover`): the records in conflict, never the apex TXT set, never a record of
// another type than the one published, at most once per name, type and values, and never while another takeover or restore of the set is under way.
import { planAutomaticTakeovers, type AutoTakeoverInput } from "../../src/dns/DnsAutoTakeover.js";
import { buildHostEndpointSets } from "../../src/dns/DnsDesiredState.js";
import type { ConfigEnvelope, DnsOperation, DnsProvider, Domain } from "../../src/models/types.js";
import { StaticDnsResolver } from "../testDoubles.js";

const OWNER = "rapidmx-0123456789abcdef";
const ENVELOPE: ConfigEnvelope = { $enc: 1, kid: "k1", iv: "iv", ct: "ct", tag: "tag" };
const registry = (): string[][] => [[`heritage=external-dns,external-dns/owner=${OWNER},external-dns/resource=crd/mail/x`]];

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
        allowTakeover: true,
        ...fields,
    } as DnsProvider;
}

function domain(fields: Partial<Domain> = {}): Domain {
    return { uid: "example.com", name: "example.com", enabled: true, verified: false, verificationToken: "3f9c1d", dnsProviderUid: "cloudflare-main", ...fields } as Domain;
}

function operation(fields: Partial<DnsOperation>): DnsOperation {
    return { uid: `op-${Math.random()}`, type: "takeover", providerUid: "cloudflare-main", state: "succeeded", ...fields } as DnsOperation;
}

describe("planAutomaticTakeovers()", () => {
    let resolver: StaticDnsResolver;

    beforeEach(() => {
        resolver = new StaticDnsResolver();
    });

    const input = (fields: Partial<AutoTakeoverInput> = {}): AutoTakeoverInput => ({
        providers: [provider()],
        domains: [domain()],
        operations: [],
        hosts: [],
        addresses: [],
        context: { mxHostname: "mail.example.com", ttl: 300 },
        resolver,
        ownerId: OWNER,
        observed: () => true,
        ...fields,
    });
    const names = (records: { recordType: string; dnsName: string }[]): string[] => records.map((r) => `${r.recordType} ${r.dnsName}`);
    const conflictingMxAndDmarc = (): void => {
        resolver.mxRecords.set("example.com", [{ priority: 5, exchange: "mx.oldhost.net" }]);
        resolver.records.set("_dmarc.example.com", [["v=DMARC1; p=reject;"]]);
    };

    describe("a domain's records", () => {
        it("plans the takeover of the records in conflict only, for the domain's endpoint set", async () => {
            conflictingMxAndDmarc();
            // The ownership record and the openpgpkey CNAME aren't there: nothing to take over.

            const plan = await planAutomaticTakeovers(input());

            expect(plan).toHaveLength(1);
            expect(plan[0]).toMatchObject({ endpointSetId: "domain-example-com" });
            expect(plan[0].provider.uid).toBe("cloudflare-main");
            expect(plan[0].domain?.uid).toBe("example.com");
            expect(plan[0].records).toEqual([
                { dnsName: "example.com", recordType: "MX", targets: ["10 mail.example.com"], ttl: 300 },
                { dnsName: "_dmarc.example.com", recordType: "TXT", targets: ["v=DMARC1; p=none;"], ttl: 300 },
            ]);
        });

        it("plans nothing for records this deployment owns, or that aren't there", async () => {
            conflictingMxAndDmarc();
            resolver.records.set("rmx-mx.example.com", registry());
            resolver.records.set("rmx-txt._dmarc.example.com", registry());

            expect(await planAutomaticTakeovers(input())).toEqual([]);
        });

        it("plans nothing while the provider config doesn't allow takeover, is disabled, or the domain isn't published through it", async () => {
            conflictingMxAndDmarc();

            expect(await planAutomaticTakeovers(input({ providers: [provider({ allowTakeover: false })] }))).toEqual([]);
            expect(await planAutomaticTakeovers(input({ providers: [provider({ enabled: false })] }))).toEqual([]);
            expect(await planAutomaticTakeovers(input({ domains: [domain({ dnsProviderUid: undefined })] }))).toEqual([]);
            expect(await planAutomaticTakeovers(input({ domains: [domain({ dnsProviderUid: "gone" })] }))).toEqual([]);
        });

        it("waits until external-dns has observed the domain's endpoint, since until then nothing has tried to publish the record", async () => {
            conflictingMxAndDmarc();
            const asked: string[] = [];

            const plan = await planAutomaticTakeovers(
                input({
                    observed: (id) => {
                        asked.push(id);
                        return false;
                    },
                }),
            );

            expect(plan).toEqual([]);
            expect(asked).toEqual(["domain-example-com"]);
        });

        it("never takes the apex TXT set over, whether or not the domain has opted it in: only the opt-in itself does", async () => {
            resolver.records.set("example.com", [["v=spf1 include:old.example.net ~all"], ["site-verification=abc"]]);

            expect(await planAutomaticTakeovers(input())).toEqual([]);
            const managed = domain({ apexTxt: { managed: true, keep: ["site-verification=abc"], spf: "v=spf1 mx ~all" } });
            expect(await planAutomaticTakeovers(input({ domains: [managed] }))).toEqual([]);

            // Next to a record that is taken over, the SPF record stays out of it.
            conflictingMxAndDmarc();
            const [plan] = await planAutomaticTakeovers(input({ domains: [managed] }));
            expect(names(plan.records)).toEqual(["MX example.com", "TXT _dmarc.example.com"]);
        });

        it("never takes over a record of another type than the one published: a CNAME wanted where an address is, or a record wanted where a CNAME is", async () => {
            resolver.addressRecords.set("openpgpkey.example.com", ["192.0.2.10"]);
            resolver.cnameRecords.set("_dmarc.example.com", ["_dmarc.provider.example.net"]);
            resolver.mxRecords.set("example.com", [{ priority: 5, exchange: "mx.oldhost.net" }]);

            const [plan] = await planAutomaticTakeovers(input());

            expect(names(plan.records)).toEqual(["MX example.com"]);
        });

        it("takes over the ownership record too when the administrator published the token there by hand", async () => {
            resolver.records.set("_rapidmx-verify.example.com", [["rapidmx-domain-verification=3f9c1d"]]);

            const [plan] = await planAutomaticTakeovers(input());

            expect(plan.records).toEqual([{ dnsName: "_rapidmx-verify.example.com", recordType: "TXT", targets: ["rapidmx-domain-verification=3f9c1d"], ttl: 300 }]);
        });
    });

    describe("what was taken over before, and what is under way", () => {
        it("doesn't take over again what a takeover of the same name, type and values was queued for, whatever became of it", async () => {
            conflictingMxAndDmarc();
            const mx = { dnsName: "example.com", recordType: "MX" as const, targets: ["10 mail.example.com"], ttl: 300 };

            for (const state of ["succeeded", "failed"] as const) {
                const [plan] = await planAutomaticTakeovers(input({ operations: [operation({ endpointSetId: "domain-example-com", records: [mx], state })] }));
                expect(names(plan.records), state).toEqual(["TXT _dmarc.example.com"]);
            }
        });

        it("isn't held back by an administrator's takeover that failed, which may have failed for another record of its set, but is by one that succeeded", async () => {
            conflictingMxAndDmarc();
            const mx = { dnsName: "example.com", recordType: "MX" as const, targets: ["10 mail.example.com"], ttl: 300 };

            const [failed] = await planAutomaticTakeovers(input({ operations: [operation({ endpointSetId: "domain-example-com", records: [mx], state: "failed", requestedBy: "admin" })] }));
            const [done] = await planAutomaticTakeovers(input({ operations: [operation({ endpointSetId: "domain-example-com", records: [mx], state: "succeeded", requestedBy: "admin" })] }));

            expect(names(failed.records)).toEqual(["MX example.com", "TXT _dmarc.example.com"]);
            expect(names(done.records)).toEqual(["TXT _dmarc.example.com"]);
        });

        it("takes the record over again once its desired value changed, and leaves the other provider's and the other sets' history alone", async () => {
            conflictingMxAndDmarc();
            const before = { dnsName: "_dmarc.example.com", recordType: "TXT" as const, targets: ["v=DMARC1; p=none;"], ttl: 300 };
            const mx = { dnsName: "example.com", recordType: "MX" as const, targets: ["10 mail.example.com"], ttl: 300 };
            const history = [operation({ endpointSetId: "domain-example-com", records: [before, mx] })];

            // The same values: nothing.
            expect(await planAutomaticTakeovers(input({ operations: history }))).toEqual([]);

            // A stricter policy: the record's desired value is another one.
            const [plan] = await planAutomaticTakeovers(input({ operations: history, domains: [domain({ dmarcPolicy: "quarantine" })] }));
            expect(plan.records).toEqual([{ dnsName: "_dmarc.example.com", recordType: "TXT", targets: ["v=DMARC1; p=quarantine;"], ttl: 300 }]);

            // Another provider's or another set's takeover of the same records says nothing about this one.
            const others = [operation({ providerUid: "other", endpointSetId: "domain-example-com", records: [before, mx] }), operation({ endpointSetId: "hosts-cloudflare-main", records: [before, mx] })];
            expect(names((await planAutomaticTakeovers(input({ operations: others })))[0].records)).toEqual(["MX example.com", "TXT _dmarc.example.com"]);
        });

        it("compares the values without regard to their order", async () => {
            resolver.addressRecords.set("mail.example.com", ["198.51.100.9"]);
            const hosts = [{ name: "mail.example.com", type: "address" as const }];
            const done = operation({ endpointSetId: "hosts-cloudflare-main", records: [{ dnsName: "mail.example.com", recordType: "A", targets: ["203.0.113.8", "203.0.113.7"], ttl: 300 }] });

            const plan = await planAutomaticTakeovers(input({ domains: [], hosts, addresses: ["203.0.113.7", "203.0.113.8"], operations: [done] }));

            expect(plan).toEqual([]);
        });

        it("plans nothing for a set while a takeover or a restore of it is queued or running, and plans the other sets", async () => {
            conflictingMxAndDmarc();
            resolver.addressRecords.set("mail.example.com", ["198.51.100.9"]);
            const hosts = [{ name: "mail.example.com", type: "address" as const }];
            const base = { domains: [domain()], hosts, addresses: ["203.0.113.7"] };

            for (const [type, state] of [["takeover", "queued"], ["takeover", "running"], ["restore", "queued"], ["restore", "running"]] as const) {
                const under = operation({ type, state, endpointSetId: "domain-example-com", records: [] });
                const plan = await planAutomaticTakeovers(input({ ...base, operations: [under] }));
                expect(plan.map((p) => p.endpointSetId), `${type} ${state}`).toEqual(["hosts-cloudflare-main"]);
            }
            // A test, or an operation of another set, or one that finished, blocks nothing.
            for (const other of [
                operation({ type: "test", state: "running", endpointSetId: "domain-example-com" }),
                operation({ type: "takeover", state: "queued", endpointSetId: "domain-other-com", records: [] }),
                operation({ type: "restore", state: "failed", endpointSetId: "domain-example-com", records: [] }),
            ]) {
                const plan = await planAutomaticTakeovers(input({ ...base, operations: [other] }));
                expect(plan.map((p) => p.endpointSetId)).toEqual(["domain-example-com", "hosts-cloudflare-main"]);
            }
        });
    });

    describe("the deployment's own hosts", () => {
        const hosts = [
            { name: "mail.example.com", type: "address" as const },
            { name: "auth.example.com", type: "cname" as const },
        ];

        it("plans the takeover of the hosts in conflict, in the provider's hosts set and without a domain", async () => {
            resolver.addressRecords.set("mail.example.com", ["198.51.100.9"]);

            const plan = await planAutomaticTakeovers(input({ domains: [], hosts, addresses: ["203.0.113.7"] }));

            expect(plan).toHaveLength(1);
            expect(plan[0].endpointSetId).toBe("hosts-cloudflare-main");
            expect(plan[0].domain).toBeUndefined();
            expect(plan[0].records).toEqual([{ dnsName: "mail.example.com", recordType: "A", targets: ["203.0.113.7"], ttl: 300 }]);
        });

        it("leaves out a host whose live records are another type than the one published, and one that stays manual", async () => {
            resolver.addressRecords.set("auth.example.com", ["192.0.2.1"]);

            expect(await planAutomaticTakeovers(input({ domains: [], hosts, addresses: ["203.0.113.7"] }))).toEqual([]);
            // Outside every zone: no hosts set at all.
            resolver.addressRecords.set("mail.example.com", ["198.51.100.9"]);
            expect(await planAutomaticTakeovers(input({ domains: [], hosts: [{ name: "mail.example.org", type: "address" }], addresses: ["203.0.113.7"] }))).toEqual([]);
        });

        it("waits for the hosts' endpoint to be observed, and for a provider that allows takeover", async () => {
            resolver.addressRecords.set("mail.example.com", ["198.51.100.9"]);
            const hostsOnly = { domains: [], hosts, addresses: ["203.0.113.7"] };

            expect(await planAutomaticTakeovers(input({ ...hostsOnly, observed: (id) => id !== "hosts-cloudflare-main" }))).toEqual([]);
            expect(await planAutomaticTakeovers(input({ ...hostsOnly, providers: [provider({ allowTakeover: false })] }))).toEqual([]);
        });

        it("leaves out a host record a domain's set already publishes, which that set takes over", async () => {
            resolver.cnameRecords.set("openpgpkey.example.com", ["old.example.net"]);
            const withOpenpgpkey = [...hosts, { name: "openpgpkey.example.com", type: "cname" as const }];

            const plan = await planAutomaticTakeovers(input({ hosts: withOpenpgpkey, addresses: ["203.0.113.7"] }));

            expect(plan.map((p) => p.endpointSetId)).toEqual(["domain-example-com"]);
            expect(names(plan[0].records)).toEqual(["CNAME openpgpkey.example.com"]);
            // The hosts' own set holds no such record to plan either.
            const set = buildHostEndpointSets(withOpenpgpkey, ["203.0.113.7"], [provider()], { mxHostname: "mail.example.com", ttl: 300 }, plan[0].records).endpointSets[0];
            expect(names(set.records)).not.toContain("CNAME openpgpkey.example.com");
        });
    });

    describe("the operation's uid", () => {
        it("is the same for the same records and another for other values, so two servers planning at once can only queue it once", async () => {
            conflictingMxAndDmarc();

            const [first] = await planAutomaticTakeovers(input());
            const [again] = await planAutomaticTakeovers(input());
            const [other] = await planAutomaticTakeovers(input({ domains: [domain({ dmarcPolicy: "reject" })] }));

            expect(first.uid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
            expect(again.uid).toBe(first.uid);
            expect(other.uid).not.toBe(first.uid);
        });
    });
});
