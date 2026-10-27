///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// HTTP behaviour of DNS publishing, identical on both backends: ownership verification at `_rapidmx-verify` with the legacy apex transition, the DNS
// checklist's publication states, the apex TXT opt-in (`PUT mail/domains/:id/apex-txt`), the queued test and takeover operations, and the DNS
// controller's internal API (`/internal/dns`: handshake, desired state with its long poll, status reports).
import { readFileSync } from "node:fs";
import { request } from "@rapidrest/service-core/test";
import { JWTUtils } from "@rapidrest/core";
import * as uuid from "uuid";
import { AuditAction } from "../../src/models/types.js";
import type { ConfigCipher } from "../../src/secrets/ConfigCipher.js";
import { TEST_DNS_CONTROLLER_TOKEN, TEST_OTHER_SERVICE_ACCOUNT_TOKEN, type InMemoryDnsPublisher, type StaticDnsResolver } from "../testDoubles.js";

export interface DnsPublishingSuiteContext {
    config: any;
    app: () => any;
    prefix: string;
    cipher: () => ConfigCipher;
    publisher: () => InMemoryDnsPublisher;
    resolver: () => StaticDnsResolver;
    clear: () => Promise<void>;
    /** Saves a domain row with these fields (and defaults for the rest). */
    saveDomain: (fields: Record<string, unknown>) => Promise<void>;
    domainRow: (uid: string) => Promise<any>;
    providerRow: (uid: string) => Promise<any>;
    /** Changes fields of the stored provider row directly, as a restore or a manual edit of the database would. */
    updateProviderRow: (uid: string, fields: Record<string, unknown>) => Promise<void>;
    operationRows: () => Promise<any[]>;
    auditEntries: () => Promise<{ action: string; targetUid: string; details?: any }[]>;
    /** A new instance of the backend's domain route, configured from `config` as it is now (the server's own instance was configured at start-up). */
    newDomainRoute: (name: string) => Promise<any>;
}

const CF_ZONE_ID = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf-token-VALUE-never-in-desired-state";
const MX_HOST = "mail.rapidmx-test.example.com";
const V1 = "dns.rapidmx.io/v1";

export function dnsPublishingSuite(ctx: DnsPublishingSuiteContext): void {
    let userToken: string;
    let adminToken: string;
    let unelevatedToken: string;

    beforeAll(() => {
        userToken = JWTUtils.createTokenSync(ctx.config.get("auth"), { uid: uuid.v4(), roles: [], elevated: Date.now() });
        adminToken = JWTUtils.createTokenSync(ctx.config.get("auth"), { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() });
        unelevatedToken = JWTUtils.createTokenSync(ctx.config.get("auth"), { uid: uuid.v4(), roles: ["admin"] });
    });

    beforeEach(async () => {
        await ctx.clear();
        ctx.publisher().reset();
        const resolver = ctx.resolver();
        resolver.records.clear();
        resolver.mxRecords.clear();
        resolver.cnameRecords.clear();
        resolver.srvRecords.clear();
        resolver.failing.clear();
    });

    const providers = (suffix = "") => `${ctx.prefix}/dns-providers${suffix}`;
    const domains = (suffix = "") => `${ctx.prefix}/domains${suffix}`;
    const internal = (suffix = "") => `${ctx.prefix}/internal/dns${suffix}`;
    const as = (token: string, req: any) => req.set("Authorization", "jwt " + token);
    const asController = (req: any, token: string = TEST_DNS_CONTROLLER_TOKEN) => req.set("Authorization", "Bearer " + token);

    const createProvider = async (fields: Record<string, unknown> = {}) => {
        const body = {
            name: `Cloudflare ${uuid.v4().slice(0, 8)}`,
            type: "cloudflare",
            zones: ["example.com"],
            options: { zoneIds: [CF_ZONE_ID] },
            credentials: { apiToken: TOKEN },
            ...fields,
        };
        const result = await as(adminToken, request(ctx.app()).post(providers())).send(body);
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        return result.body;
    };
    const createRfc2136 = () =>
        createProvider({ name: "Bind", type: "rfc2136", options: { hosts: ["ns1.example.com"], zone: "example.com", insecure: true }, credentials: undefined });
    const GUID = "11111111-2222-3333-4444-555555555555";
    const createAzure = () =>
        createProvider({
            name: "Azure",
            type: "azure",
            options: { tenantId: GUID, subscriptionId: GUID, resourceGroup: "dns-rg" },
            credentials: { clientId: GUID, clientSecret: "azure-secret-VALUE" },
        });
    const assign = async (domainUid: string, dnsProviderUid: string | null) => {
        const result = await as(adminToken, request(ctx.app()).put(domains(`/${domainUid}/dns-provider`))).send({ dnsProviderUid });
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        return result.body;
    };
    const dnsSetup = async (uid: string) => {
        const result = await as(adminToken, request(ctx.app()).get(domains(`/${uid}/dns-setup`)));
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        return Object.fromEntries(result.body.map((check: any) => [check.type, check]));
    };
    const putApexTxt = (uid: string, body: unknown, token = adminToken) => as(token, request(ctx.app()).put(domains(`/${uid}/apex-txt`))).send(body);
    const desiredState = async (query = "") => {
        const result = await asController(request(ctx.app()).get(internal(`/v1/desired-state${query}`)));
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        return result.body;
    };
    const report = (body: Record<string, unknown>) =>
        asController(request(ctx.app()).put(internal("/v1/status"))).send({
            apiVersion: V1,
            kind: "StatusReport",
            controllerVersion: "0.1.0",
            lease: { holder: true, identity: "mail-dns-controller-abc" },
            providers: [],
            endpoints: [],
            operations: [],
            ...body,
        });
    const keysOf = (o: any) => Object.keys(o).sort();
    const audit = async (action: string) => (await ctx.auditEntries()).filter((entry) => entry.action === action);

    describe("ownership verification", () => {
        it("verifies at _rapidmx-verify.<domain> and audits where the token was found", async () => {
            await ctx.saveDomain({ name: "verify.com", verificationToken: "tok" });
            ctx.resolver().records.set("_rapidmx-verify.verify.com", [["rapidmx-domain-verification=tok"]]);

            const result = await as(adminToken, request(ctx.app()).post(domains("/verify.com/verify")));

            expect(result.status).toBe(200);
            expect(result.body.verified).toBe(true);
            const [entry] = await audit(AuditAction.DOMAIN_VERIFIED);
            expect(entry.details).toEqual(expect.objectContaining({ name: "verify.com", location: "record" }));
        });

        it("accepts the token at the domain's root, its old location, during the transition", async () => {
            await ctx.saveDomain({ name: "legacy.com", verificationToken: "tok" });
            ctx.resolver().records.set("legacy.com", [["v=spf1 mx ~all"], ["rapidmx-domain-verification=tok"]]);

            const result = await as(adminToken, request(ctx.app()).post(domains("/legacy.com/verify")));

            expect(result.body.verified).toBe(true);
            expect((await audit(AuditAction.DOMAIN_VERIFIED))[0].details.location).toBe("legacy_apex");
        });

        it("refuses the token at the root once mail:domain_verification:accept_legacy_apex is off, the text \"false\" of an environment variable included", async () => {
            await ctx.saveDomain({ name: "legacy.com", verificationToken: "tok" });
            ctx.resolver().records.set("legacy.com", [["rapidmx-domain-verification=tok"]]);
            const key = "mail:domain_verification:accept_legacy_apex";
            ctx.config.set(key, "false");
            let route: any;
            try {
                route = await ctx.newDomainRoute(`strict-${uuid.v4()}`);
            } finally {
                ctx.config.set(key, undefined);
            }
            const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };

            const result = await route.verify("legacy.com", {}, admin);

            expect(result.verified).toBe(false);
            expect((await ctx.domainRow("legacy.com")).verified).toBe(false);
            expect(await audit(AuditAction.DOMAIN_VERIFIED)).toEqual([]);
            // The checklist still says the token is at the root, for the admin to move it.
            expect((await route.dnsSetup("legacy.com")).find((c: any) => c.type === "ownership")).toMatchObject({ found: false, legacyApex: true });

            // Published at _rapidmx-verify, it verifies.
            ctx.resolver().records.set("_rapidmx-verify.legacy.com", [["rapidmx-domain-verification=tok"]]);
            expect((await route.verify("legacy.com", {}, admin)).verified).toBe(true);
        });
    });

    describe("the DNS checklist", () => {
        it("recommends only _rapidmx-verify, hints at a token left at the root, and shows every record as manual without a provider", async () => {
            await ctx.saveDomain({ name: "example.com", verificationToken: "tok" });
            ctx.resolver().records.set("example.com", [["rapidmx-domain-verification=tok"]]);

            const checks = await dnsSetup("example.com");

            expect(checks.ownership).toMatchObject({ recordName: "_rapidmx-verify.example.com", found: false, legacyApex: true, publication: "manual", manualReason: "no_provider" });
            for (const type of ["mx", "spf", "dmarc", "openpgpkey_cname"]) {
                expect(checks[type], type).toMatchObject({ publication: "manual", manualReason: "no_provider" });
            }
        });

        it("shows assigned records as pending, published once the controller observed them and they are live, and conflicts for records it doesn't own", async () => {
            const provider = await createProvider();
            await ctx.saveDomain({ name: "example.com", verificationToken: "tok" });
            await assign("example.com", provider.uid);
            const { ownerId } = await desiredState();
            const resolver = ctx.resolver();
            resolver.mxRecords.set("example.com", [{ priority: 10, exchange: MX_HOST }]);
            resolver.records.set("rmx-mx.example.com", [[`heritage=external-dns,external-dns/owner=${ownerId},external-dns/resource=crd/mail/x`]]);
            resolver.records.set("_dmarc.example.com", [["v=DMARC1; p=reject;"]]);

            let checks = await dnsSetup("example.com");
            expect(checks.mx).toMatchObject({ matches: true, publication: "pending" });
            expect(checks.ownership).toMatchObject({ publication: "pending" });
            expect(checks.spf).toMatchObject({ publication: "manual", manualReason: "apex_txt_unmanaged" });
            expect(checks.dmarc).toMatchObject({ found: true, publication: "conflict" });

            const status = await report({ endpoints: [{ endpointSetId: "domain-example-com", generation: 2, observedGeneration: 2 }] });
            expect(status.status, JSON.stringify(status.body)).toBe(200);
            checks = await dnsSetup("example.com");
            expect(checks.mx).toMatchObject({ publication: "published" });
            expect(checks.openpgpkey_cname).toMatchObject({ found: false, publication: "pending" });
        });

        it("shows MX as manual on an rfc2136 provider, which can't update or delete it", async () => {
            const provider = await createRfc2136();
            await ctx.saveDomain({ name: "example.com" });
            await assign("example.com", provider.uid);

            const checks = await dnsSetup("example.com");

            expect(checks.mx).toMatchObject({ publication: "manual", manualReason: "kind_unsupported" });
            // A DMARC value is not one plain character-string either, which rfc2136 could never update or delete; the ownership value is.
            expect(checks.dmarc).toMatchObject({ publication: "manual", manualReason: "kind_unsupported" });
            expect(checks.ownership).toMatchObject({ publication: "pending" });
            expect(checks.openpgpkey_cname).toMatchObject({ publication: "pending" });
        });

        it("shows a managed apex TXT set with kept values as manual on Azure, which keeps only the first value of a name, and without them as pending", async () => {
            const provider = await createAzure();
            const managed = (name: string, keep: string[]) =>
                ctx.saveDomain({ name, dkimSelector: "mail", dkimPublicKey: "KEY", dnsProviderUid: provider.uid, apexTxt: { managed: true, keep, spf: "v=spf1 mx ~all" } });
            await ctx.saveDomain({ name: "example.com" });
            await managed("several.example.com", ["ms=1"]);
            await managed("single.example.com", []);

            const several = await dnsSetup("several.example.com");
            expect(several.spf).toMatchObject({ publication: "manual", manualReason: "kind_unsupported" });
            // Its other records are single values, which Azure keeps.
            expect(several.dkim).toMatchObject({ publication: "pending" });
            expect(several.dmarc).toMatchObject({ publication: "pending" });

            expect((await dnsSetup("single.example.com")).spf).toMatchObject({ publication: "pending" });
        });

        it("lists the next and previous DKIM selectors during a rotation", async () => {
            await ctx.saveDomain({
                name: "example.com",
                dkimSelector: "mail",
                dkimPublicKey: "KEY",
                dkimRotation: { phase: "pending", next: { selector: "rmx20261027", publicKey: "NEXT", createdAt: new Date(), reason: "manual" }, previous: { selector: "old", publicKey: "OLD" } },
            });

            const checks = await dnsSetup("example.com");

            expect(checks.dkim_next).toMatchObject({ recordName: "rmx20261027._domainkey.example.com", recommendedValue: "v=DKIM1; k=rsa; p=NEXT" });
            expect(checks.dkim_previous).toMatchObject({ recordName: "old._domainkey.example.com", recommendedValue: "v=DKIM1; k=rsa; p=OLD" });
        });
    });

    describe("apex TXT management", () => {
        const apex = [["google-site-verification=g"], ["v=spf1 include:_spf.example.net ~all"], ["rapidmx-domain-verification=tok"]];

        it("shows the values at the root and suggests keeping all but SPF and ownership tokens", async () => {
            await ctx.saveDomain({ name: "example.com", verificationToken: "tok" });
            ctx.resolver().records.set("example.com", apex);

            const result = await as(adminToken, request(ctx.app()).get(domains("/example.com/apex-txt")));

            expect(result.status).toBe(200);
            expect(result.body).toEqual({
                managed: false,
                keep: [],
                current: ["google-site-verification=g", "v=spf1 include:_spf.example.net ~all", "rapidmx-domain-verification=tok"],
                suggestedKeep: ["google-site-verification=g"],
            });
            expect((await as(userToken, request(ctx.app()).get(domains("/example.com/apex-txt")))).status).toBe(403);
            expect((await as(adminToken, request(ctx.app()).get(domains("/nowhere.com/apex-txt")))).status).toBe(404);
        });

        it("says when the values at the root couldn't be looked up, and refuses to opt in on them", async () => {
            const provider = await createProvider();
            await ctx.saveDomain({ name: "example.com" });
            await assign("example.com", provider.uid);
            ctx.resolver().records.set("example.com", [["v=spf1 mx include:_spf.google.com ~all"], ["google-site-verification=g"]]);
            ctx.resolver().failing.add("example.com");

            const view = await as(adminToken, request(ctx.app()).get(domains("/example.com/apex-txt")));
            expect(view.status).toBe(200);
            expect(view.body).toEqual({ managed: false, keep: [], current: [], suggestedKeep: [], lookupFailed: true });

            const optIn = await putApexTxt("example.com", { managed: true, keep: [] });
            expect(optIn.status).toBe(503);
            expect((await ctx.domainRow("example.com")).apexTxt ?? undefined).toBeUndefined();
            expect(await ctx.operationRows()).toEqual([]);
            expect(await audit(AuditAction.DNS_TAKEOVER)).toEqual([]);

            // A root with no TXT records at all is known to be empty: no failure.
            ctx.resolver().failing.clear();
            ctx.resolver().records.delete("example.com");
            expect((await as(adminToken, request(ctx.app()).get(domains("/example.com/apex-txt")))).body).toEqual({ managed: false, keep: [], current: [], suggestedKeep: [] });
            expect((await putApexTxt("example.com", { managed: true, keep: [] })).status).toBe(200);
        });

        it("needs a trusted role, elevation, an assigned provider and a valid keep list", async () => {
            await ctx.saveDomain({ name: "example.com" });
            expect((await putApexTxt("example.com", { managed: true, keep: [] }, userToken)).status).toBe(403);
            expect((await putApexTxt("example.com", { managed: true, keep: [] }, unelevatedToken)).status).toBe(403);
            expect((await putApexTxt("example.com", { managed: true, keep: [] })).status).toBe(400);
            expect((await putApexTxt("nowhere.com", { managed: true, keep: [] })).status).toBe(404);

            const provider = await createProvider();
            await assign("example.com", provider.uid);
            expect((await putApexTxt("example.com", { managed: true, keep: ["v=spf1 -all"] })).status).toBe(400);
            expect((await putApexTxt("example.com", { managed: "yes", keep: [] })).status).toBe(400);
            expect((await putApexTxt("example.com", { managed: true, keep: "ms=1" })).status).toBe(400);
            expect((await ctx.domainRow("example.com")).apexTxt ?? undefined).toBeUndefined();
            expect(await ctx.operationRows()).toEqual([]);
        });

        it("refuses kept values on an Azure provider, which keeps only the first value of a name, and opts in without them", async () => {
            const provider = await createAzure();
            await ctx.saveDomain({ name: "example.com", verificationToken: "tok" });
            await assign("example.com", provider.uid);
            ctx.resolver().records.set("example.com", apex);

            const refused = await putApexTxt("example.com", { managed: true, keep: ["google-site-verification=g"] });
            expect(refused.status).toBe(400);
            expect(refused.body.message).toContain("Azure");
            expect((await ctx.domainRow("example.com")).apexTxt ?? undefined).toBeUndefined();
            expect(await ctx.operationRows()).toEqual([]);
            expect(await audit(AuditAction.DNS_TAKEOVER)).toEqual([]);

            // Without kept values the set is one value, SPF alone.
            const optedIn = await putApexTxt("example.com", { managed: true, keep: [] });
            expect(optedIn.status, JSON.stringify(optedIn.body)).toBe(200);
            expect(optedIn.body.apexTxt).toEqual({ managed: true, keep: [], spf: "v=spf1 mx ~all" });

            // Adding values to keep later is refused as well, and opting out never is.
            const edited = await putApexTxt("example.com", { managed: true, keep: ["ms=1"] });
            expect(edited.status).toBe(400);
            expect((await ctx.domainRow("example.com")).apexTxt.keep).toEqual([]);
            expect((await putApexTxt("example.com", { managed: false })).status).toBe(200);
        });

        it("refuses the opt-in on an rfc2136 provider, which can't keep an SPF value (400), changing nothing, and opting out is never refused", async () => {
            const provider = await createRfc2136();
            await ctx.saveDomain({ name: "example.com", verificationToken: "tok" });
            await assign("example.com", provider.uid);
            ctx.resolver().records.set("example.com", apex);

            for (const keep of [[], ["ms=1"]]) {
                const refused = await putApexTxt("example.com", { managed: true, keep });
                expect(refused.status, JSON.stringify(keep)).toBe(400);
                expect(refused.body.message).toContain("rfc2136");
            }
            expect((await ctx.domainRow("example.com")).apexTxt ?? undefined).toBeUndefined();
            expect(await ctx.operationRows()).toEqual([]);
            expect(await audit(AuditAction.DNS_TAKEOVER)).toEqual([]);

            // A row opted in before this rule (spf set) can't be edited either, but can be released.
            await ctx.saveDomain({ name: "legacy.example.com", dnsProviderUid: provider.uid, apexTxt: { managed: true, keep: [], spf: "v=spf1 mx ~all" } });
            expect((await putApexTxt("legacy.example.com", { managed: true, keep: ["ms=1"] })).status).toBe(400);
            expect((await putApexTxt("legacy.example.com", { managed: false })).status).toBe(200);
        });

        it("opts in: owns the set with SPF and the kept values, queues the takeover and audits the old values", async () => {
            const provider = await createProvider();
            await ctx.saveDomain({ name: "example.com", verificationToken: "tok" });
            await assign("example.com", provider.uid);
            ctx.resolver().records.set("example.com", apex);
            ctx.publisher().reset();

            const result = await putApexTxt("example.com", { managed: true, keep: ["google-site-verification=g", "rapidmx-domain-verification=tok"] });

            expect(result.status, JSON.stringify(result.body)).toBe(200);
            // The SPF without mx is replaced; the ownership token isn't carried over.
            const expectedApex = { managed: true, keep: ["google-site-verification=g"], spf: "v=spf1 mx ~all" };
            expect(result.body.apexTxt).toEqual(expectedApex);
            expect((await ctx.domainRow("example.com")).apexTxt).toEqual(expectedApex);

            const [op] = await ctx.operationRows();
            expect(op).toEqual(
                expect.objectContaining({
                    type: "takeover",
                    providerUid: provider.uid,
                    domainUid: "example.com",
                    endpointSetId: "domain-example-com",
                    state: "queued",
                    records: [{ dnsName: "example.com", recordType: "TXT", targets: ["v=spf1 mx ~all", "google-site-verification=g"], ttl: 300 }],
                }),
            );
            const [entry] = await audit(AuditAction.DNS_TAKEOVER);
            expect(entry.details).toEqual(
                expect.objectContaining({
                    provider: provider.uid,
                    domain: "example.com",
                    recordNames: ["example.com"],
                    oldValues: ["google-site-verification=g", "v=spf1 include:_spf.example.net ~all", "rapidmx-domain-verification=tok"],
                    keep: ["google-site-verification=g"],
                    spf: "v=spf1 mx ~all",
                    operation: op.uid,
                }),
            );
            expect(ctx.publisher().changes.length).toBeGreaterThan(0);

            const state = await desiredState();
            expect(state.endpointSets[0].records).toContainEqual({ dnsName: "example.com", recordType: "TXT", targets: ["v=spf1 mx ~all", "google-site-verification=g"], ttl: 300 });
            expect(state.operations).toEqual([expect.objectContaining({ id: op.uid, type: "takeover" })]);
            // Published from now on, but still a conflict until the queued takeover makes the set this deployment's.
            expect((await dnsSetup("example.com")).spf).toMatchObject({ recommendedValue: "v=spf1 mx ~all", publication: "conflict" });
            const view = await as(adminToken, request(ctx.app()).get(domains("/example.com/apex-txt")));
            expect(view.body).toEqual(expect.objectContaining({ managed: true, keep: ["google-site-verification=g"], spf: "v=spf1 mx ~all" }));
        });

        it("keeps an existing SPF record that already includes mx verbatim", async () => {
            const provider = await createProvider();
            await ctx.saveDomain({ name: "example.com" });
            await assign("example.com", provider.uid);
            ctx.resolver().records.set("example.com", [["v=spf1 mx include:_spf.google.com ~all"]]);

            const result = await putApexTxt("example.com", { managed: true, keep: [] });

            expect(result.body.apexTxt).toEqual({ managed: true, keep: [], spf: "v=spf1 mx include:_spf.google.com ~all" });
        });

        it("edits the kept values while managed, audited without another takeover; opting out restores them with the SPF record", async () => {
            const provider = await createProvider();
            await ctx.saveDomain({ name: "example.com" });
            await assign("example.com", provider.uid);
            await putApexTxt("example.com", { managed: true, keep: ["ms=1"] });

            const edited = await putApexTxt("example.com", { managed: true, keep: ["ms=1", "ms=2"] });
            expect(edited.status).toBe(200);
            expect(edited.body.apexTxt.keep).toEqual(["ms=1", "ms=2"]);
            expect(await ctx.operationRows()).toHaveLength(1);
            expect((await audit(AuditAction.DOMAIN_APEX_TXT_UPDATE))[0].details).toEqual(expect.objectContaining({ managed: true, keep: ["ms=1", "ms=2"] }));
            expect((await desiredState()).endpointSets[0].records).toContainEqual(expect.objectContaining({ dnsName: "example.com", recordType: "TXT", targets: ["v=spf1 mx ~all", "ms=1", "ms=2"] }));

            const optedOut = await putApexTxt("example.com", { managed: false });
            expect(optedOut.status).toBe(200);
            expect(optedOut.body.apexTxt).toEqual(expect.objectContaining({ managed: false, keep: ["ms=1", "ms=2"] }));
            const restore = (await ctx.operationRows()).find((op) => op.type === "restore");
            // The SPF record RapidMX published stays too: releasing the set deletes all of it, and a domain without SPF fails SPF and DMARC.
            expect(restore).toEqual(
                expect.objectContaining({
                    providerUid: provider.uid,
                    domainUid: "example.com",
                    state: "queued",
                    records: [{ dnsName: "example.com", recordType: "TXT", targets: ["v=spf1 mx ~all", "ms=1", "ms=2"], ttl: 300 }],
                }),
            );
            expect((await audit(AuditAction.DOMAIN_APEX_TXT_UPDATE)).find((e) => e.details.managed === false)!.details).toEqual(
                expect.objectContaining({ keep: ["ms=1", "ms=2"], restoreOperation: restore.uid }),
            );
            const records = (await desiredState()).endpointSets[0].records;
            expect(records.find((r: any) => r.dnsName === "example.com" && r.recordType === "TXT")).toBeUndefined();
            expect((await dnsSetup("example.com")).spf).toMatchObject({ publication: "manual", manualReason: "apex_txt_unmanaged" });

            // Opting out again changes nothing.
            expect((await putApexTxt("example.com", { managed: false })).status).toBe(200);
            expect((await ctx.operationRows()).filter((op) => op.type === "restore")).toHaveLength(1);
        });

        it("restores the SPF record it adopted when no other value was kept", async () => {
            const provider = await createProvider();
            await ctx.saveDomain({ name: "example.com" });
            await assign("example.com", provider.uid);
            ctx.resolver().records.set("example.com", [["v=spf1 mx include:_spf.google.com ~all"]]);
            await putApexTxt("example.com", { managed: true, keep: [] });
            await putApexTxt("example.com", { managed: false });
            const operations = await ctx.operationRows();
            expect(operations.map((op) => op.type)).toEqual(["takeover", "restore"]);
            expect(operations[1].records).toEqual([{ dnsName: "example.com", recordType: "TXT", targets: ["v=spf1 mx include:_spf.google.com ~all"], ttl: 300 }]);
        });

        it("refuses reassigning a managed domain, and restores the kept values when it is deleted", async () => {
            const provider = await createProvider();
            await ctx.saveDomain({ name: "example.com" });
            await assign("example.com", provider.uid);
            await putApexTxt("example.com", { managed: true, keep: ["ms=1"] });

            expect((await as(adminToken, request(ctx.app()).put(domains("/example.com/dns-provider"))).send({ dnsProviderUid: null })).status).toBe(409);

            // Deleting it takes its public records with it: an elevated token, as an opt-out needs.
            expect((await as(unelevatedToken, request(ctx.app()).delete(domains("/example.com")))).status).toBe(403);
            expect((await ctx.operationRows()).map((op) => op.type)).toEqual(["takeover"]);

            const deleted = await as(adminToken, request(ctx.app()).delete(domains("/example.com")));
            expect(deleted.status).toBeGreaterThanOrEqual(200);
            expect(deleted.status).toBeLessThan(300);
            const restore = (await ctx.operationRows()).find((op) => op.type === "restore");
            expect(restore).toEqual(expect.objectContaining({ providerUid: provider.uid, records: [{ dnsName: "example.com", recordType: "TXT", targets: ["v=spf1 mx ~all", "ms=1"], ttl: 300 }] }));
            expect((await desiredState()).operations.map((op: any) => op.type)).toContain("restore");
            expect((await audit(AuditAction.DOMAIN_DELETE))[0].details).toEqual({ name: "example.com", restoreOperation: restore.uid });
        });

        it("needs an elevated token to delete a domain published through a provider config, not a manual one", async () => {
            const provider = await createProvider();
            await ctx.saveDomain({ name: "example.com" });
            await ctx.saveDomain({ name: "manual.com" });
            await assign("example.com", provider.uid);
            expect((await as(unelevatedToken, request(ctx.app()).delete(domains("/example.com")))).status).toBe(403);
            expect(await ctx.domainRow("example.com")).toBeTruthy();
            const manual = await as(unelevatedToken, request(ctx.app()).delete(domains("/manual.com")));
            expect(manual.status).toBeLessThan(300);
        });

        it("never takes apexTxt through the generic update routes", async () => {
            await ctx.saveDomain({ name: "example.com" });
            const row = await ctx.domainRow("example.com");
            expect((await as(adminToken, request(ctx.app()).put(domains("/example.com/apexTxt"))).send({ managed: true, keep: [] })).status).toBe(403);
            expect((await as(adminToken, request(ctx.app()).put(domains("/example.com/dkimRotation"))).send({ phase: "idle" })).status).toBe(403);
            const put = await as(adminToken, request(ctx.app()).put(domains("/example.com"))).send({ uid: "example.com", version: row.version, apexTxt: { managed: true, keep: [] }, dmarcPolicy: "reject" });
            expect(put.status).toBe(200);
            expect(put.body.dmarcPolicy).toBe("reject");
            expect((await ctx.domainRow("example.com")).apexTxt ?? undefined).toBeUndefined();
        });
    });

    describe("queued operations", () => {
        it("queues a credentials test for an elevated admin, audited and handed to the controller", async () => {
            const provider = await createProvider();
            expect((await as(unelevatedToken, request(ctx.app()).post(providers(`/${provider.uid}/test`)))).status).toBe(403);
            expect((await as(userToken, request(ctx.app()).post(providers(`/${provider.uid}/test`)))).status).toBe(403);
            expect((await as(adminToken, request(ctx.app()).post(providers("/nope/test")))).status).toBe(404);

            const result = await as(adminToken, request(ctx.app()).post(providers(`/${provider.uid}/test`)));

            expect(result.status, JSON.stringify(result.body)).toBe(200);
            expect(result.body).toEqual(expect.objectContaining({ type: "test", providerUid: provider.uid, state: "queued" }));
            expect((await audit(AuditAction.DNS_PROVIDER_TEST))[0].details).toEqual(expect.objectContaining({ name: provider.name, operation: result.body.uid }));
            expect((await desiredState()).operations).toEqual([{ id: result.body.uid, type: "test", providerUid: provider.uid }]);
            await new Promise((resolve) => setTimeout(resolve, 10));
            const second = await as(adminToken, request(ctx.app()).post(providers(`/${provider.uid}/test`)));
            // Newest first.
            const listed = await as(adminToken, request(ctx.app()).get(providers(`/${provider.uid}/operations`)));
            expect(listed.status).toBe(200);
            expect(listed.body.map((op: any) => op.uid)).toEqual([second.body.uid, result.body.uid]);
        });

        it("queues a takeover of a domain's records, never its apex TXT set, with the old values audited", async () => {
            const provider = await createProvider();
            await ctx.saveDomain({ name: "example.com", verificationToken: "tok" });
            await ctx.saveDomain({ name: "manual.example.com" });
            const takeover = (body: unknown, token = adminToken) => as(token, request(ctx.app()).post(providers(`/${provider.uid}/takeover`))).send(body);

            expect((await takeover({ domainUid: "example.com" }, unelevatedToken)).status).toBe(403);
            expect((await takeover({ domainUid: "manual.example.com" })).status).toBe(400);
            expect((await takeover({})).status).toBe(400);
            await assign("example.com", provider.uid);
            expect((await takeover({ domainUid: "example.com", records: ["spf"] })).status).toBe(400);
            expect((await takeover({ domainUid: "example.com", records: ["nonsense"] })).status).toBe(400);
            ctx.resolver().mxRecords.set("example.com", [{ priority: 5, exchange: "mx.oldhost.net" }]);

            const all = await takeover({ domainUid: "example.com" });
            expect(all.status, JSON.stringify(all.body)).toBe(200);
            expect(all.body.records.map((r: any) => `${r.recordType} ${r.dnsName}`)).toEqual([
                "TXT _rapidmx-verify.example.com",
                "MX example.com",
                "TXT _dmarc.example.com",
                "CNAME openpgpkey.example.com",
            ]);

            const mx = await takeover({ domainUid: "example.com", records: ["mx"] });
            expect(mx.body).toEqual(
                expect.objectContaining({
                    type: "takeover",
                    endpointSetId: "domain-example-com",
                    domainUid: "example.com",
                    records: [{ dnsName: "example.com", recordType: "MX", targets: [`10 ${MX_HOST}`], ttl: 300 }],
                }),
            );
            const entries = await audit(AuditAction.DNS_TAKEOVER);
            expect(entries.find((e) => e.details.operation === mx.body.uid)!.details).toEqual(
                expect.objectContaining({ provider: provider.uid, domain: "example.com", recordNames: ["example.com"], oldValues: ["5 mx.oldhost.net"] }),
            );
        });
    });

    it("refuses a takeover of records the provider can't hold, also among others it can, naming them", async () => {
        const provider = await createRfc2136();
        await ctx.saveDomain({ name: "example.com" });
        await assign("example.com", provider.uid);
        const takeover = (records: string[]) => as(adminToken, request(ctx.app()).post(providers(`/${provider.uid}/takeover`))).send({ domainUid: "example.com", records });
        expect((await takeover(["mx"])).status).toBe(400);
        const mixed = await takeover(["mx", "ownership"]);
        expect(mixed.status).toBe(400);
        expect(mixed.body.message).toContain("mx");
        expect(mixed.body.message).not.toContain("ownership");
        // DMARC is a value rfc2136 can't keep (not one plain character-string), and DKIM has no key yet: listed but not published either.
        expect((await takeover(["dkim", "ownership"])).status).toBe(400);
        const dmarc = await takeover(["dmarc", "ownership"]);
        expect(dmarc.status).toBe(400);
        expect(dmarc.body.message).toContain("dmarc");
        expect(await ctx.operationRows()).toEqual([]);

        const ownership = await takeover(["ownership"]);
        expect(ownership.status).toBe(200);
        expect(ownership.body.records.map((r: any) => `${r.recordType} ${r.dnsName}`)).toEqual(["TXT _rapidmx-verify.example.com"]);
    });

    it("keeps a provider config with a restore still to run, and cancels its other operations when it is deleted", async () => {
        const provider = await createProvider();
        await ctx.saveDomain({ name: "example.com" });
        await assign("example.com", provider.uid);
        await putApexTxt("example.com", { managed: true, keep: ["ms=1"] });
        await putApexTxt("example.com", { managed: false });
        await assign("example.com", null);
        const test = (await as(adminToken, request(ctx.app()).post(providers(`/${provider.uid}/test`)))).body;
        const restore = (await ctx.operationRows()).find((op) => op.type === "restore");

        const refused = await as(adminToken, request(ctx.app()).delete(providers(`/${provider.uid}`)));
        expect(refused.status).toBe(409);
        expect(refused.body.message).toContain("example.com");
        expect(await ctx.providerRow(provider.uid)).toBeTruthy();

        // Running is still pending; once the controller reports it done, the config can go.
        await report({ operations: [{ id: restore.uid, state: "running" }] });
        expect((await as(adminToken, request(ctx.app()).delete(providers(`/${provider.uid}`)))).status).toBe(409);
        await report({ operations: [{ id: restore.uid, state: "succeeded" }] });
        const deleted = await as(adminToken, request(ctx.app()).delete(providers(`/${provider.uid}`)));
        expect(deleted.status).toBeLessThan(300);

        const operations = await ctx.operationRows();
        const byUid = (uid: string) => operations.find((op) => op.uid === uid);
        expect(byUid(test.uid)).toEqual(expect.objectContaining({ state: "failed", message: "Cancelled: the DNS provider config was deleted." }));
        expect(byUid(test.uid).finishedAt).toBeTruthy();
        expect(operations.find((op) => op.type === "takeover")).toEqual(expect.objectContaining({ state: "failed" }));
        expect(byUid(restore.uid).state).toBe("succeeded");
        expect((await desiredState()).operations).toEqual([]);
    });

    describe("the controller's internal API", () => {
        it("refuses a caller that isn't the controller's ServiceAccount", async () => {
            for (const token of [undefined, "forged", TEST_OTHER_SERVICE_ACCOUNT_TOKEN]) {
                const auth = (req: any) => (token ? req.set("Authorization", "Bearer " + token) : req);
                expect((await auth(request(ctx.app()).post(internal("/handshake"))).send({ kind: "Handshake", controllerVersion: "0.1.0", apiVersions: [V1] })).status).toBe(403);
                expect((await auth(request(ctx.app()).get(internal("/v1/desired-state")))).status).toBe(403);
                expect((await auth(request(ctx.app()).put(internal("/v1/status"))).send({ apiVersion: V1, kind: "StatusReport" })).status).toBe(403);
                expect((await auth(request(ctx.app()).get(internal("/v1/providers/anything/credentials")))).status).toBe(403);
            }
            // A user's own token is no controller token either.
            expect((await as(adminToken, request(ctx.app()).get(internal("/v1/desired-state")))).status).toBe(403);
            expect((await as(adminToken, request(ctx.app()).get(internal("/v1/providers/anything/credentials")))).status).toBe(403);
        });

        it("answers the handshake and records what the controller said, for the console", async () => {
            const ok = await asController(request(ctx.app()).post(internal("/handshake"))).send({ kind: "Handshake", controllerVersion: "0.1.0", apiVersions: [V1] });
            expect(ok.status).toBe(200);
            expect(ok.body).toEqual({ kind: "HandshakeResult", serverVersion: ctx.config.get("version"), apiVersions: [V1], compatible: true, selected: V1 });

            const bad = await asController(request(ctx.app()).post(internal("/handshake"))).send({ kind: "Handshake", controllerVersion: "0.4.0", apiVersions: ["dns.rapidmx.io/v2"] });
            expect(bad.status).toBe(200);
            expect(bad.body).toEqual(expect.objectContaining({ compatible: false, reason: expect.stringContaining("no API version in common") }));
            expect(bad.body.selected).toBeUndefined();

            const state = await as(adminToken, request(ctx.app()).get(providers("/controller")));
            expect(state.status).toBe(200);
            expect(state.body.handshake).toEqual(expect.objectContaining({ controllerVersion: "0.4.0", apiVersions: ["dns.rapidmx.io/v2"], compatible: false }));
            expect((await as(userToken, request(ctx.app()).get(providers("/controller")))).status).toBe(403);

            expect((await asController(request(ctx.app()).post(internal("/handshake"))).send({ kind: "Hello" })).status).toBe(400);
        });

        it("serves the desired state: providers with the names of their credentials only, the owner id, the domains' and hosts' records", async () => {
            const provider = await createProvider({ zones: ["example.com"] });
            await ctx.saveDomain({ name: "example.com", verificationToken: "tok", dkimSelector: "mail", dkimPublicKey: "KEY" });
            await ctx.saveDomain({ name: "manual.com" });
            await assign("example.com", provider.uid);

            const state = await desiredState();

            expect(JSON.stringify(state)).not.toContain(TOKEN);
            expect(state).toEqual(
                expect.objectContaining({
                    apiVersion: V1,
                    kind: "DesiredState",
                    version: expect.any(Number),
                    ownerId: expect.stringMatching(/^rapidmx-[a-z0-9]{16}$/),
                    externalDnsImage: "registry.k8s.io/external-dns/external-dns:v0.23.0",
                }),
            );
            expect(state.providers).toEqual([
                {
                    uid: provider.uid,
                    type: "cloudflare",
                    zones: ["example.com"],
                    options: { zoneIds: [CF_ZONE_ID] },
                    credentials: { keys: ["apiToken"], generation: 1 },
                    enabled: true,
                },
            ]);
            expect(state.endpointSets).toEqual([
                {
                    id: "domain-example-com",
                    providerUid: provider.uid,
                    domainUid: "example.com",
                    records: [
                        { dnsName: "_rapidmx-verify.example.com", recordType: "TXT", targets: ["rapidmx-domain-verification=tok"], ttl: 300 },
                        { dnsName: "example.com", recordType: "MX", targets: [`10 ${MX_HOST}`], ttl: 300 },
                        { dnsName: "mail._domainkey.example.com", recordType: "TXT", targets: ["v=DKIM1; k=rsa; p=KEY"], ttl: 300 },
                        { dnsName: "_dmarc.example.com", recordType: "TXT", targets: ["v=DMARC1; p=none;"], ttl: 300 },
                        { dnsName: "openpgpkey.example.com", recordType: "CNAME", targets: [MX_HOST], ttl: 300 },
                    ],
                },
                {
                    id: `hosts-${provider.uid}`,
                    providerUid: provider.uid,
                    records: [
                        // The private address in the configured list is refused.
                        { dnsName: MX_HOST, recordType: "A", targets: ["203.0.114.7"], ttl: 300 },
                        { dnsName: "auth.rapidmx-test.example.com", recordType: "CNAME", targets: [MX_HOST], ttl: 300 },
                    ],
                },
            ]);
            // The owner id is stable.
            expect((await desiredState()).ownerId).toBe(state.ownerId);
        });

        describe("a provider config's credentials", () => {
            const route53 = () =>
                createProvider({
                    name: "AWS",
                    type: "route53",
                    options: { region: "us-east-1" },
                    credentials: { accessKeyId: "AKIAABCDEFGHIJKLMNOP", secretAccessKey: "aws-secret-VALUE" },
                });
            const credentialsOf = (uid: string, token: string = TEST_DNS_CONTROLLER_TOKEN) => asController(request(ctx.app()).get(internal(`/v1/providers/${uid}/credentials`)), token);
            const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/dns-api/v1/${name}.json`, import.meta.url), "utf8"));

            it("answers the controller only, whatever the config", async () => {
                const provider = await createProvider();
                for (const token of ["forged", TEST_OTHER_SERVICE_ACCOUNT_TOKEN]) {
                    const refused = await credentialsOf(provider.uid, token);
                    expect(refused.status).toBe(403);
                    expect(JSON.stringify(refused.body)).not.toContain(TOKEN);
                }
                expect((await request(ctx.app()).get(internal(`/v1/providers/${provider.uid}/credentials`))).status).toBe(403);
                // An unknown config is no different to a caller that may not ask.
                expect((await credentialsOf("nope", "forged")).status).toBe(403);
            });

            it("hands over the decrypted credentials with their generation, never to be cached, and audits nothing", async () => {
                const provider = await route53();
                const auditBefore = (await ctx.auditEntries()).length;

                const result = await credentialsOf(provider.uid);

                expect(result.status, JSON.stringify(result.body)).toBe(200);
                expect(result.headers["cache-control"]).toBe("no-store");
                expect(result.body).toEqual({
                    apiVersion: V1,
                    kind: "DnsProviderCredentials",
                    providerUid: provider.uid,
                    generation: 1,
                    values: { accessKeyId: "AKIAABCDEFGHIJKLMNOP", secretAccessKey: "aws-secret-VALUE" },
                });
                // The shared fixture has the same shape (and a field of a later version, which readers ignore).
                expect(keysOf(fixture("provider-credentials"))).toEqual([...keysOf(result.body), "futureField"].sort());
                // Asking again is no event: no audit entry.
                await credentialsOf(provider.uid);
                expect((await ctx.auditEntries()).length).toBe(auditBefore);

                // A new credential is a new generation with the new value.
                const changed = await as(adminToken, request(ctx.app()).put(providers(`/${provider.uid}`))).send({ credentials: { secretAccessKey: "aws-secret-NEW" } });
                expect(changed.status).toBe(200);
                expect((await credentialsOf(provider.uid)).body).toEqual(
                    expect.objectContaining({ generation: 2, values: { accessKeyId: "AKIAABCDEFGHIJKLMNOP", secretAccessKey: "aws-secret-NEW" } }),
                );
            });

            it("answers empty values for a config without credentials, and for one whose credentials were all cleared, at the generation it is at", async () => {
                const bare = await createProvider({ name: "AWS IRSA", type: "route53", zones: ["example.net"], options: { region: "us-east-1" }, credentials: undefined });
                expect((await credentialsOf(bare.uid)).body).toEqual({ apiVersion: V1, kind: "DnsProviderCredentials", providerUid: bare.uid, generation: 0, values: {} });

                const aws = await route53();
                await as(adminToken, request(ctx.app()).put(providers(`/${aws.uid}`))).send({ credentials: { accessKeyId: null, secretAccessKey: null } });
                expect((await credentialsOf(aws.uid)).body).toEqual({ apiVersion: V1, kind: "DnsProviderCredentials", providerUid: aws.uid, generation: 2, values: {} });
            });

            it("is a 404 for a config that is gone", async () => {
                const provider = await createProvider();
                await as(adminToken, request(ctx.app()).delete(providers(`/${provider.uid}`)));
                expect((await credentialsOf(provider.uid)).status).toBe(404);
                expect((await credentialsOf("nope")).status).toBe(404);
            });

            it("leaves out a credential that can't be read and names it, without saying why or what was in it", async () => {
                const provider = await route53();
                const row = await ctx.providerRow(provider.uid);
                // Copied from another config, so it fails authentication here; and one that isn't an envelope at all.
                const foreign = ctx.cipher().encrypt("foreign-VALUE", { record: "DnsProvider", uid: "another-config", field: "credentials.secretAccessKey" });
                await ctx.updateProviderRow(provider.uid, { credentials: { ...row.credentials, secretAccessKey: foreign } });
                let result = await credentialsOf(provider.uid);
                expect(result.status).toBe(200);
                expect(result.body).toEqual({
                    apiVersion: V1,
                    kind: "DnsProviderCredentials",
                    providerUid: provider.uid,
                    generation: 1,
                    values: { accessKeyId: "AKIAABCDEFGHIJKLMNOP" },
                    unreadable: ["secretAccessKey"],
                });
                expect(JSON.stringify(result.body)).not.toContain("foreign-VALUE");
                expect(keysOf(fixture("provider-credentials-unreadable"))).toEqual(keysOf(result.body));

                await ctx.updateProviderRow(provider.uid, { credentials: { ...row.credentials, accessKeyId: "plaintext-in-the-row" } });
                result = await credentialsOf(provider.uid);
                expect(result.body.values).toEqual({ secretAccessKey: "aws-secret-VALUE" });
                expect(result.body.unreadable).toEqual(["accessKeyId"]);
                expect(JSON.stringify(result.body)).not.toContain("plaintext-in-the-row");
            });
        });

        it("long-polls: answers as soon as the desired state changes, or with the same version after the wait", async () => {
            const provider = await createProvider();
            await ctx.saveDomain({ name: "example.com" });
            const { version } = await desiredState();

            const started: number = Date.now();
            const waiting = desiredState(`?since=${version}`);
            await new Promise((resolve) => setTimeout(resolve, 100));
            await assign("example.com", provider.uid);
            const changed = await waiting;
            expect(changed.version).toBeGreaterThan(version);
            expect(changed.endpointSets.map((s: any) => s.id)).toContain("domain-example-com");
            expect(Date.now() - started).toBeLessThan(900);

            const idle = await desiredState(`?since=${changed.version}`);
            expect(idle.version).toBe(changed.version);
            expect(Date.now() - started).toBeGreaterThanOrEqual(900);

            // Behind already: no wait.
            expect((await desiredState(`?since=${changed.version - 1}`)).version).toBe(changed.version);
            // Ahead of the server (its counter was reset): answered at once with the server's version, not after every wait.
            const reset: number = Date.now();
            expect((await desiredState(`?since=${changed.version + 4200}`)).version).toBe(changed.version);
            expect(Date.now() - reset).toBeLessThan(500);
            expect((await asController(request(ctx.app()).get(internal("/v1/desired-state?since=abc")))).status).toBe(400);
        });

        it("takes status reports: refuses another apiVersion, records provider, endpoint, operation and Lease state", async () => {
            const provider = await createProvider();
            await ctx.saveDomain({ name: "example.com" });
            await assign("example.com", provider.uid);
            const test = (await as(adminToken, request(ctx.app()).post(providers(`/${provider.uid}/test`)))).body;

            const v2 = await report({ apiVersion: "dns.rapidmx.io/v2" });
            expect(v2.status).toBe(400);
            expect(v2.body).toEqual({ reason: "unsupported_api_version", supported: [V1] });
            expect((await report({ kind: "DesiredState" })).status).toBe(400);
            expect((await report({ providers: [{ providerUid: 1 }] })).status).toBe(400);

            const accepted = await report({
                desiredStateVersion: 7,
                providers: [{ providerUid: provider.uid, readyReplicas: 1, image: "registry.k8s.io/external-dns/external-dns:v0.23.0", lastSyncAt: "2026-10-27T10:00:00Z", lastError: "rate limited" }, { providerUid: "unknown", readyReplicas: 1 }],
                endpoints: [{ endpointSetId: "domain-example-com", generation: 3, observedGeneration: 2 }, { endpointSetId: "domain-unknown-com", generation: 1 }],
                operations: [{ id: test.uid, state: "running" }, { id: "unknown", state: "failed" }],
            });
            expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
            expect(accepted.body).toEqual({ apiVersion: V1, kind: "StatusReportResult" });

            const providerRow = await ctx.providerRow(provider.uid);
            expect(providerRow.status).toEqual(expect.objectContaining({ readyReplicas: 1, image: "registry.k8s.io/external-dns/external-dns:v0.23.0", lastError: "rate limited" }));
            expect(new Date(providerRow.status.lastSyncAt).toISOString()).toBe("2026-10-27T10:00:00.000Z");
            expect(providerRow.status.reportedAt).toBeDefined();
            const domainRow = await ctx.domainRow("example.com");
            expect(domainRow.dnsPublication.endpoints).toEqual([{ name: "domain-example-com", generation: 3, observedGeneration: 2 }]);
            expect((await ctx.operationRows())[0]).toEqual(expect.objectContaining({ uid: test.uid, state: "running" }));
            const controller = (await as(adminToken, request(ctx.app()).get(providers("/controller")))).body;
            expect(controller.lastReport).toEqual(expect.objectContaining({ controllerVersion: "0.1.0", desiredStateVersion: 7, leaseHolder: true, leaseIdentity: "mail-dns-controller-abc" }));
            // Reported through the provider route too.
            expect((await as(adminToken, request(ctx.app()).get(providers(`/${provider.uid}`)))).body.status).toEqual(expect.objectContaining({ readyReplicas: 1 }));

            // The same report again doesn't rewrite the domain (an admin's edit made meanwhile would otherwise lose its version race).
            await report({ endpoints: [{ endpointSetId: "domain-example-com", generation: 3, observedGeneration: 2 }] });
            expect((await ctx.domainRow("example.com")).version).toBe(domainRow.version);

            // A finished operation leaves the desired state, and a late report can't reopen it.
            await report({ operations: [{ id: test.uid, state: "succeeded", message: "authenticated; zones found" }] });
            expect((await ctx.operationRows())[0]).toEqual(expect.objectContaining({ state: "succeeded", message: "authenticated; zones found" }));
            expect((await desiredState()).operations).toEqual([]);
            await report({ operations: [{ id: test.uid, state: "running" }] });
            expect((await ctx.operationRows())[0].state).toBe("succeeded");
        });

        it("acts only on the Lease holder's report, keeping another pod's apart", async () => {
            const provider = await createProvider();
            await ctx.saveDomain({ name: "example.com" });
            await assign("example.com", provider.uid);
            const test = (await as(adminToken, request(ctx.app()).post(providers(`/${provider.uid}/test`)))).body;
            await report({ providers: [{ providerUid: provider.uid, readyReplicas: 1 }], endpoints: [{ endpointSetId: "domain-example-com", generation: 2, observedGeneration: 2 }] });
            const providerRow = await ctx.providerRow(provider.uid);
            const domainRow = await ctx.domainRow("example.com");

            const standby = await report({
                controllerVersion: "0.0.9",
                lease: { holder: false, identity: "mail-dns-controller-old" },
                providers: [{ providerUid: provider.uid, readyReplicas: 0, lastError: "stale" }],
                endpoints: [{ endpointSetId: "domain-example-com", generation: 1, observedGeneration: 1 }],
                operations: [{ id: test.uid, state: "failed", message: "not mine" }],
            });

            expect(standby.status, JSON.stringify(standby.body)).toBe(200);
            expect(standby.body).toEqual({ apiVersion: V1, kind: "StatusReportResult" });
            expect((await ctx.providerRow(provider.uid)).version).toBe(providerRow.version);
            expect((await ctx.providerRow(provider.uid)).status).toEqual(expect.objectContaining({ readyReplicas: 1 }));
            expect((await ctx.domainRow("example.com")).version).toBe(domainRow.version);
            expect((await ctx.operationRows())[0].state).toBe("queued");
            const controller = (await as(adminToken, request(ctx.app()).get(providers("/controller")))).body;
            expect(controller.lastReport).toEqual(expect.objectContaining({ controllerVersion: "0.1.0", leaseHolder: true }));
            expect(controller.lastStandbyReport).toEqual(expect.objectContaining({ controllerVersion: "0.0.9", leaseHolder: false, leaseIdentity: "mail-dns-controller-old" }));
        });
    });

    describe("desired-state change notices", () => {
        it("announces domain and provider changes that move what is published", async () => {
            const publisher = ctx.publisher();
            const provider = await createProvider();
            expect(publisher.changes).toContainEqual({ scope: "provider", providerUid: provider.uid });

            const created = await as(adminToken, request(ctx.app()).post(domains())).send({ name: "notice.com" });
            expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
            expect(publisher.changes).toContainEqual({ scope: "domain", domainUid: "notice.com" });

            publisher.reset();
            await as(adminToken, request(ctx.app()).put(domains("/notice.com"))).send({ uid: "notice.com", version: created.body.version, dmarcPolicy: "reject" });
            expect(publisher.changes).toEqual([{ scope: "domain", domainUid: "notice.com" }]);

            publisher.reset();
            await as(adminToken, request(ctx.app()).put(providers(`/${provider.uid}`))).send({ zones: ["example.com", "notice.com"], options: { zoneIds: [CF_ZONE_ID, "fedcba9876543210fedcba9876543210"] } });
            expect(publisher.changes).toEqual([{ scope: "provider", providerUid: provider.uid }]);

            publisher.reset();
            await assign("notice.com", provider.uid);
            expect(publisher.changes).toEqual([{ scope: "domain", domainUid: "notice.com" }]);

            publisher.reset();
            await assign("notice.com", null);
            await as(adminToken, request(ctx.app()).delete(domains("/notice.com")));
            expect(publisher.changes).toEqual([
                { scope: "domain", domainUid: "notice.com" },
                { scope: "domain", domainUid: "notice.com" },
            ]);

            publisher.reset();
            await as(adminToken, request(ctx.app()).delete(providers(`/${provider.uid}`)));
            expect(publisher.changes).toEqual([{ scope: "provider", providerUid: provider.uid }]);
        });

        it("clears a domain's publication status when it moves to another provider", async () => {
            const provider = await createProvider();
            await ctx.saveDomain({ name: "example.com" });
            await assign("example.com", provider.uid);
            await report({ endpoints: [{ endpointSetId: "domain-example-com", generation: 1, observedGeneration: 1 }] });
            expect((await ctx.domainRow("example.com")).dnsPublication).toBeTruthy();

            await assign("example.com", null);

            expect((await ctx.domainRow("example.com")).dnsPublication ?? undefined).toBeUndefined();
        });
    });
}
