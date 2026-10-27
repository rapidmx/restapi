///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// HTTP behaviour of `system/dns-providers`, of assigning a domain to one (`PUT mail/domains/:id/dns-provider`) and of the deployment identity, identical on
// both backends. Credentials are saved as encrypted envelopes in the provider's own row, in the one versioned write that saves the rest of the change:
// every test that saves one also checks the stored row and the audit entry never carry its value.
import { request } from "@rapidrest/service-core/test";
import { JWTUtils } from "@rapidrest/core";
import { ApiErrors, type RepoUtils } from "@rapidrest/service-core";
import * as uuid from "uuid";
import { DNS_PROVIDER_UID_PATTERN } from "../../src/dns/DnsProviderTypes.js";
import { AuditAction, DeploymentIdentity } from "../../src/models/types.js";
import { isConfigEnvelope, type ConfigCipher } from "../../src/secrets/ConfigCipher.js";
import { DEPLOYMENT_IDENTITY_UID, findOrCreateDeploymentIdentity, INSTALLATION_ID_PATTERN } from "../../src/util/DeploymentIdentityUtils.js";

export interface DnsProviderSuiteContext {
    config: any;
    app: () => any;
    prefix: string;
    cipher: () => ConfigCipher;
    clear: () => Promise<void>;
    /** Saves a domain row with these fields (and defaults for the rest). */
    saveDomain: (fields: Record<string, unknown>) => Promise<void>;
    /** Saves many domain rows at once, as `saveDomain()` does each. */
    saveDomains: (rows: Record<string, unknown>[]) => Promise<void>;
    /** The stored domain row, as the database holds it. */
    domainRow: (uid: string) => Promise<any>;
    /** The stored provider row, as the database holds it (`undefined` when there is none). */
    providerRow: (uid: string) => Promise<any>;
    auditEntries: () => Promise<{ action: string; targetUid: string; details?: any }[]>;
    identityRepo: () => RepoUtils<DeploymentIdentity>;
    /** Saves a deployment identity row with this installation id. */
    saveIdentity: (installationId: string) => Promise<void>;
}

const CF_ZONE_ID = "0123456789abcdef0123456789abcdef";
const CF_ZONE_ID_2 = "fedcba9876543210fedcba9876543210";
const TOKEN = "cf-token-VALUE-never-stored";

export function dnsProviderSuite(ctx: DnsProviderSuiteContext): void {
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
    });

    const providers = (suffix = "") => `${ctx.prefix}/dns-providers${suffix}`;
    const domains = (suffix = "") => `${ctx.prefix}/domains${suffix}`;
    const as = (token: string, req: any) => req.set("Authorization", "jwt " + token);
    const cloudflare = (fields: Record<string, unknown> = {}) => ({
        name: "Cloudflare main",
        type: "cloudflare",
        zones: ["example.com"],
        options: { zoneIds: [CF_ZONE_ID] },
        credentials: { apiToken: TOKEN },
        ...fields,
    });
    const create = async (body: Record<string, unknown> = cloudflare()) => {
        const result = await as(adminToken, request(ctx.app()).post(providers())).send(body);
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        return result.body;
    };
    const update = (uid: string, body: unknown, token = adminToken) => as(token, request(ctx.app()).put(providers(`/${uid}`))).send(body);
    const assign = (domainUid: string, body: unknown, token = adminToken) => as(token, request(ctx.app()).put(domains(`/${domainUid}/dns-provider`))).send(body);
    const actions = async () => (await ctx.auditEntries()).map((entry) => entry.action);
    /** What the stored row's credential `field` holds, decrypted as the context it was saved for: the one way a test reads a credential back. */
    const stored = async (uid: string, field: string): Promise<string | undefined> => {
        const envelope = (await ctx.providerRow(uid)).credentials?.[field];
        return envelope === undefined ? undefined : ctx.cipher().decryptString(envelope, { record: "DnsProvider", uid, field: `credentials.${field}` });
    };
    const AWS = {
        name: "AWS",
        type: "route53",
        zones: ["example.com"],
        options: { region: "us-east-1" },
        credentials: { accessKeyId: "AKIAABCDEFGHIJKLMNOP", secretAccessKey: "secret-VALUE" },
    };

    describe("types", () => {
        it("lists every provider type with its form, for a trusted caller only", async () => {
            const result = await as(adminToken, request(ctx.app()).get(providers("/types")));
            expect(result.status).toBe(200);
            const byType = Object.fromEntries(result.body.map((info: any) => [info.type, info]));
            expect(Object.keys(byType).sort()).toEqual(["azure", "cloudflare", "google", "rfc2136", "route53"]);
            expect(byType.cloudflare.tested).toBe(true);
            expect(byType.route53.tested).toBe(false);
            expect(byType.route53.externalDnsProvider).toBe("aws");
            expect(byType.rfc2136.unsupportedRecordKinds).toEqual(["MX", "SRV"]);
            expect(byType.google.secretFields).toEqual([expect.objectContaining({ key: "serviceAccountJson", required: true, multiLine: true })]);
            expect(byType.cloudflare.options[0]).toEqual(expect.objectContaining({ key: "zoneIds", kind: "string-list", required: true }));
            expect((await as(userToken, request(ctx.app()).get(providers("/types")))).status).toBe(403);
            expect([401, 403]).toContain((await request(ctx.app()).get(providers("/types"))).status);
        });
    });

    describe("create", () => {
        it("refuses a caller without a trusted role or without elevation (403), and saves nothing", async () => {
            expect((await as(userToken, request(ctx.app()).post(providers())).send(cloudflare())).status).toBe(403);
            expect((await as(unelevatedToken, request(ctx.app()).post(providers())).send(cloudflare())).status).toBe(403);
            expect((await as(adminToken, request(ctx.app()).get(providers()))).body).toEqual([]);
        });

        it("saves the credentials encrypted on the row, bound to it, with generation 1, never the value", async () => {
            const created = await create(cloudflare({ name: "  Cloudflare main  ", zones: ["Example.COM."], options: { zoneIds: [CF_ZONE_ID.toUpperCase()] } }));
            expect(created).toEqual(
                expect.objectContaining({
                    name: "Cloudflare main",
                    type: "cloudflare",
                    zones: ["example.com"],
                    options: { zoneIds: [CF_ZONE_ID] },
                    credentials: { apiToken: { secret: true } },
                    origin: "console",
                    enabled: true,
                    allowTakeover: false,
                    domainCount: 0,
                }),
            );
            expect(created.secretRef).toBeUndefined();
            expect(created.uid).toMatch(DNS_PROVIDER_UID_PATTERN);
            expect(created.uid).toMatch(/^cloudflare-main-[a-z0-9]{8}$/);

            const row = await ctx.providerRow(created.uid);
            expect(row.secretRef).toBeUndefined();
            expect(row.credentialsGeneration).toBe(1);
            expect(Object.keys(row.credentials)).toEqual(["apiToken"]);
            expect(isConfigEnvelope(row.credentials.apiToken)).toBe(true);
            expect(JSON.stringify(row)).not.toContain(TOKEN);
            expect(await stored(created.uid, "apiToken")).toBe(TOKEN);
            // Bound to this row and field: moved to another row or another field it doesn't decrypt.
            const cipher = ctx.cipher();
            expect(() => cipher.decryptString(row.credentials.apiToken, { record: "DnsProvider", uid: "another-row", field: "credentials.apiToken" })).toThrow();
            expect(() => cipher.decryptString(row.credentials.apiToken, { record: "DnsProvider", uid: created.uid, field: "credentials.other" })).toThrow();
            expect(() => cipher.decryptString(row.credentials.apiToken, { record: "Plugin", uid: created.uid, field: "credentials.apiToken" })).toThrow();

            const [entry] = await ctx.auditEntries();
            expect(entry).toEqual(expect.objectContaining({ action: AuditAction.DNS_PROVIDER_CREATE, targetUid: created.uid }));
            expect(entry.details).toEqual(expect.objectContaining({ name: "Cloudflare main", type: "cloudflare", optionKeys: ["zoneIds"], credentialsChanged: true }));
            expect(JSON.stringify(entry)).not.toContain(TOKEN);
        });

        it("creates a config that needs no credentials: Route 53 through the service account's role, with defaults filled in and no generation", async () => {
            const created = await create({ name: "AWS", type: "route53", zones: ["example.com"], options: { region: "US-EAST-1" }, allowTakeover: true, enabled: false });
            expect(created).toEqual(expect.objectContaining({ options: { region: "us-east-1", zoneType: "public" }, credentials: {}, allowTakeover: true, enabled: false }));
            const row = await ctx.providerRow(created.uid);
            expect(row.credentials ?? undefined).toBeUndefined();
            expect(row.credentialsGeneration).toBe(0);
            expect((await ctx.auditEntries())[0].details.credentialsChanged).toBe(false);
        });

        it("treats a credential sent as null or as the mask on create as not sent", async () => {
            const result = await as(adminToken, request(ctx.app()).post(providers())).send({
                name: "AWS",
                type: "route53",
                zones: ["example.com"],
                options: { region: "eu-west-1" },
                credentials: { accessKeyId: null, secretAccessKey: { secret: true } },
            });
            expect(result.status).toBe(200);
            expect(result.body.credentials).toEqual({});
            const row = await ctx.providerRow(result.body.uid);
            expect(row.credentials ?? undefined).toBeUndefined();
            expect(row.credentialsGeneration).toBe(0);
        });

        it("refuses a name another config has, whatever its case (409)", async () => {
            await create();
            const result = await as(adminToken, request(ctx.app()).post(providers())).send(cloudflare({ name: "CLOUDFLARE MAIN", zones: ["example.org"], credentials: { apiToken: "other" } }));
            expect(result.status).toBe(409);
            expect((await as(adminToken, request(ctx.app()).get(providers()))).body).toHaveLength(1);

            // A name that reads like a search operator is compared as text.
            await create(cloudflare({ name: "gt(a)", zones: ["example.net"], credentials: { apiToken: "gt-token" } }));
            expect((await as(adminToken, request(ctx.app()).post(providers())).send(cloudflare({ name: "GT(A)", zones: ["example.edu"] }))).status).toBe(409);
        });

        it("saves exactly one of two creates racing for the same name, whatever its case, the other being the same 409", async () => {
            const body = (name: string, zone: string) => cloudflare({ name, zones: [zone] });
            const results = await Promise.all([
                as(adminToken, request(ctx.app()).post(providers())).send(body("Race", "one.example.com")),
                as(adminToken, request(ctx.app()).post(providers())).send(body("RACE", "two.example.com")),
            ]);
            expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
            expect(results.find((result) => result.status === 409)!.body.code).toBe(ApiErrors.IDENTIFIER_EXISTS);
            expect((await as(adminToken, request(ctx.app()).get(providers()))).body).toHaveLength(1);
        });

        it("refuses a zone another config already has (409), whatever its case, enabled or not, naming the zone and the config", async () => {
            await create(cloudflare({ zones: ["example.com", "example.org"], options: { zoneIds: [CF_ZONE_ID, CF_ZONE_ID_2] }, enabled: false }));
            for (const zones of [["example.org"], ["EXAMPLE.COM."], ["example.net", "example.org"]]) {
                const result = await as(adminToken, request(ctx.app()).post(providers())).send(
                    cloudflare({ name: "Second", zones, options: { zoneIds: zones.map((_, i) => (i === 0 ? CF_ZONE_ID : CF_ZONE_ID_2)) } }),
                );
                expect(result.status, JSON.stringify(zones)).toBe(409);
                expect(result.body.code).toBe(ApiErrors.IDENTIFIER_EXISTS);
                expect(result.body.message).toContain("example.");
                expect(result.body.message).toContain("Cloudflare main");
            }
            expect((await as(adminToken, request(ctx.app()).get(providers()))).body).toHaveLength(1);

            // A zone under another's is a different zone: a nested config is how a subdomain gets its own account (7.4).
            expect((await as(adminToken, request(ctx.app()).post(providers())).send(cloudflare({ name: "Nested", zones: ["mail.example.com"] }))).status).toBe(200);
        });

        it("refuses a config whose zones cover a domain assigned to another config more specifically (409) until that domain is set to manual", async () => {
            const parent = await create(cloudflare({ name: "Parent" }));
            await ctx.saveDomain({ name: "eu.example.com" });
            await ctx.saveDomain({ name: "www.example.com" });
            for (const name of ["eu.example.com", "www.example.com"]) {
                expect((await assign(name, { dnsProviderUid: parent.uid })).status).toBe(200);
            }

            // The nested instance would take eu.example.com's records over and delete them, while the parent's leaves the zone out (7.4).
            const nested = cloudflare({ name: "Nested", zones: ["eu.example.com"] });
            const refused = await as(adminToken, request(ctx.app()).post(providers())).send(nested);
            expect(refused.status).toBe(409);
            expect(refused.body.code).toBe(ApiErrors.IDENTIFIER_EXISTS);
            expect(refused.body.message).toContain("eu.example.com");
            expect(refused.body.message).toContain("Parent");
            expect((await as(adminToken, request(ctx.app()).get(providers()))).body).toHaveLength(1);
            expect((await ctx.domainRow("eu.example.com")).dnsProviderUid).toBe(parent.uid);

            expect((await assign("eu.example.com", { dnsProviderUid: null })).status).toBe(200);
            const created = await create(nested);
            expect((await assign("eu.example.com", { dnsProviderUid: created.uid })).status).toBe(200);
            // The rest of the parent's zone is untouched by the nested config.
            expect((await ctx.domainRow("www.example.com")).dnsProviderUid).toBe(parent.uid);
        });

        it.each([
            ["a body that isn't an object", ["x"]],
            ["a dotted key", { ...cloudflare(), "options.zoneIds": [CF_ZONE_ID] }],
            ["no name", cloudflare({ name: undefined })],
            ["a name with a control character", cloudflare({ name: "a\u0007b" })],
            ["a name that is too long", cloudflare({ name: "n".repeat(101) })],
            ["an unknown type", cloudflare({ type: "digitalocean" })],
            ["no zones", cloudflare({ zones: [] })],
            ["a zone that isn't a domain name", cloudflare({ zones: ["exa mple.com"] })],
            ["a top-level domain as a zone", cloudflare({ zones: ["com"] })],
            ["an unknown option", cloudflare({ options: { zoneIds: [CF_ZONE_ID], proxied: true } })],
            ["a missing required option", cloudflare({ options: {} })],
            ["a zone ID per zone missing", cloudflare({ zones: ["example.com", "example.org"] })],
            ["a malformed zone ID", cloudflare({ options: { zoneIds: ["not-a-zone-id"] } })],
            ["no API token", cloudflare({ credentials: undefined })],
            ["an empty API token", cloudflare({ credentials: { apiToken: "  " } })],
            ["a non-boolean enabled", cloudflare({ enabled: "yes" })],
            ["a non-boolean allowTakeover", cloudflare({ allowTakeover: 1 })],
            ["only one of Route 53's keys", { name: "AWS", type: "route53", zones: ["example.com"], options: { region: "us-east-1" }, credentials: { accessKeyId: "AKIAABCDEFGHIJKLMNOP" } }],
        ])("refuses %s (400)", async (_what, body) => {
            const result = await as(adminToken, request(ctx.app()).post(providers())).send(body);
            expect(result.status).toBe(400);
            expect((await as(adminToken, request(ctx.app()).get(providers()))).body).toEqual([]);
        });

        it("never repeats a credential sent under an unknown field name", async () => {
            const result = await as(adminToken, request(ctx.app()).post(providers())).send(cloudflare({ credentials: { [TOKEN]: "x" } }));
            expect(result.status).toBe(400);
            expect(JSON.stringify(result.body)).not.toContain(TOKEN);
        });
    });

    describe("read", () => {
        it("lists the configs by name with their assigned domain counts, masks only, for a trusted caller", async () => {
            const b = await create(cloudflare({ name: "b", credentials: { apiToken: "b-token" } }));
            const a = await create({ name: "A", type: "route53", zones: ["example.org"], options: { region: "us-east-1" } });
            await ctx.saveDomain({ name: "mail.example.com", dnsProviderUid: b.uid });
            await ctx.saveDomain({ name: "example.com", dnsProviderUid: b.uid });

            const list = await as(adminToken, request(ctx.app()).get(providers()));
            expect(list.status).toBe(200);
            expect(list.body.map((p: any) => [p.name, p.domainCount])).toEqual([
                ["A", 0],
                ["b", 2],
            ]);
            expect(JSON.stringify(list.body)).not.toContain("b-token");

            const one = await as(adminToken, request(ctx.app()).get(providers(`/${b.uid}`)));
            expect(one.status).toBe(200);
            expect(one.body).toEqual(expect.objectContaining({ uid: b.uid, domainCount: 2, credentials: { apiToken: { secret: true } } }));
            expect(one.body.secretRef).toBeUndefined();
            expect((await as(adminToken, request(ctx.app()).get(providers(`/${a.uid}`)))).body.credentials).toEqual({});

            expect((await as(adminToken, request(ctx.app()).get(providers("/nope")))).status).toBe(404);
            expect((await as(userToken, request(ctx.app()).get(providers()))).status).toBe(403);
            expect((await as(userToken, request(ctx.app()).get(providers(`/${b.uid}`)))).status).toBe(403);
        });
    });

    describe("update", () => {
        it("refuses a caller without elevation (403) and an unknown config (404)", async () => {
            const created = await create();
            expect((await update(created.uid, { enabled: false }, unelevatedToken)).status).toBe(403);
            expect((await update(created.uid, { enabled: false }, userToken)).status).toBe(403);
            expect((await update("nope", { enabled: false })).status).toBe(404);
            expect((await update(created.uid, ["x"])).status).toBe(400);
        });

        it("keeps credentials sent back as the mask or left out, and changes nothing for a round trip", async () => {
            const created = await create();
            const before = await ctx.providerRow(created.uid);
            const roundTrip = await update(created.uid, { ...created });
            expect(roundTrip.status).toBe(200);
            expect(roundTrip.body).toEqual(created);
            expect(await stored(created.uid, "apiToken")).toBe(TOKEN);
            // Nothing was written: not the row, nor its generation, nor the audit log.
            const after = await ctx.providerRow(created.uid);
            expect(after.version).toBe(before.version);
            expect(after.credentialsGeneration).toBe(1);
            expect(await actions()).toEqual([AuditAction.DNS_PROVIDER_CREATE]);
        });

        it("replaces a credential on the row in the one write of the change, bumping the generation, and audits that it changed without its value", async () => {
            const created = await create();
            const before = await ctx.providerRow(created.uid);
            const result = await update(created.uid, { name: "Renamed", credentials: { apiToken: " new-token-VALUE\n" } });
            expect(result.status).toBe(200);
            expect(result.body.credentials).toEqual({ apiToken: { secret: true } });
            const row = await ctx.providerRow(created.uid);
            expect(await stored(created.uid, "apiToken")).toBe("new-token-VALUE");
            expect(row.credentialsGeneration).toBe(2);
            // The new envelope is another encryption (its own nonce), saved with the rename in one write: one version step.
            expect(row.credentials.apiToken.iv).not.toBe(before.credentials.apiToken.iv);
            expect(row.name).toBe("Renamed");
            expect(row.version).toBe(before.version + 1);
            expect(JSON.stringify(row)).not.toContain("new-token-VALUE");
            const entry = (await ctx.auditEntries()).find((e) => e.action === AuditAction.DNS_PROVIDER_UPDATE)!;
            expect(entry.details).toEqual({ name: "Renamed", fields: ["name", "credentials"], optionKeys: [], credentialsChanged: true });
            expect(JSON.stringify(entry)).not.toContain("new-token-VALUE");
        });

        it("keeps the other credentials' envelopes when one is replaced, and the generation counts every credentials change", async () => {
            const created = await create(AWS);
            const before = (await ctx.providerRow(created.uid)).credentials;
            expect((await update(created.uid, { credentials: { secretAccessKey: "secret-NEW" } })).status).toBe(200);
            const row = await ctx.providerRow(created.uid);
            expect(row.credentials.accessKeyId).toEqual(before.accessKeyId);
            expect(await stored(created.uid, "secretAccessKey")).toBe("secret-NEW");
            expect(row.credentialsGeneration).toBe(2);
            // Sending the same value again is a change too: the controller can't tell, and rewriting its Secret with it is harmless.
            expect((await update(created.uid, { credentials: { secretAccessKey: "secret-NEW" } })).status).toBe(200);
            expect((await ctx.providerRow(created.uid)).credentialsGeneration).toBe(3);
        });

        it("clears credentials with null, leaving none on the row when none is left, and refuses leaving a required one unset", async () => {
            const created = await create(AWS);
            expect((await update(created.uid, { credentials: { accessKeyId: null } })).status).toBe(400);
            expect(await stored(created.uid, "accessKeyId")).toBe("AKIAABCDEFGHIJKLMNOP");
            expect((await ctx.providerRow(created.uid)).credentialsGeneration).toBe(1);

            const cleared = await update(created.uid, { credentials: { accessKeyId: null, secretAccessKey: null } });
            expect(cleared.status).toBe(200);
            expect(cleared.body.credentials).toEqual({});
            const row = await ctx.providerRow(created.uid);
            // `null` once every credential was cleared (4.1), not an empty object and not unset.
            expect(row.credentials).toBeNull();
            expect(row.credentialsGeneration).toBe(2);

            // Clearing a field that isn't saved is no change at all.
            const noop = await update(created.uid, { credentials: { accessKeyId: null } });
            expect(noop.status).toBe(200);
            expect((await actions()).filter((a) => a === AuditAction.DNS_PROVIDER_UPDATE)).toHaveLength(1);
            expect((await ctx.providerRow(created.uid)).credentialsGeneration).toBe(2);

            // ... and adding them back saves new envelopes at the next generation.
            const restored = await update(created.uid, { credentials: { accessKeyId: "AKIAABCDEFGHIJKLMNOP", secretAccessKey: "s2" } });
            expect(restored.body.credentials).toEqual({ accessKeyId: { secret: true }, secretAccessKey: { secret: true } });
            expect(await stored(created.uid, "secretAccessKey")).toBe("s2");
            expect((await ctx.providerRow(created.uid)).credentialsGeneration).toBe(3);
        });

        it("refuses a change made against an older version (409) with nothing saved, credentials included", async () => {
            const created = await create();
            const result = await update(created.uid, { name: "Renamed", credentials: { apiToken: "stale-token-VALUE" }, version: created.version + 5 });
            expect(result.status).toBe(409);
            expect(result.body.code).toBe(ApiErrors.INVALID_OBJECT_VERSION);
            const row = await ctx.providerRow(created.uid);
            expect(row.name).toBe("Cloudflare main");
            expect(row.credentialsGeneration).toBe(1);
            expect(await stored(created.uid, "apiToken")).toBe(TOKEN);
            expect(await actions()).toEqual([AuditAction.DNS_PROVIDER_CREATE]);
        });

        it("saves exactly one of two credential changes racing from the same version, the other a 409 that changes nothing", async () => {
            const created = await create();
            const results = await Promise.all(["token-A-VALUE", "token-B-VALUE"].map((apiToken) => update(created.uid, { credentials: { apiToken }, version: created.version })));
            expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
            expect(results.find((result) => result.status === 409)!.body.code).toBe(ApiErrors.INVALID_OBJECT_VERSION);
            const row = await ctx.providerRow(created.uid);
            expect(row.credentialsGeneration).toBe(2);
            // The generation and the credentials are the one winner's, never a mix.
            expect(["token-A-VALUE", "token-B-VALUE"]).toContain(await stored(created.uid, "apiToken"));
            expect((await actions()).filter((a) => a === AuditAction.DNS_PROVIDER_UPDATE)).toHaveLength(1);
        });

        it("renames, changes options, zones and switches, auditing the fields and option keys that changed", async () => {
            const created = await create();
            const result = await update(created.uid, {
                name: "Renamed",
                zones: ["example.com", "example.org"],
                options: { zoneIds: [CF_ZONE_ID, CF_ZONE_ID_2] },
                enabled: false,
                allowTakeover: true,
                type: "cloudflare",
                version: created.version,
            });
            expect(result.status).toBe(200);
            expect(result.body).toEqual(
                expect.objectContaining({ name: "Renamed", zones: ["example.com", "example.org"], options: { zoneIds: [CF_ZONE_ID, CF_ZONE_ID_2] }, enabled: false, allowTakeover: true }),
            );
            const entry = (await ctx.auditEntries()).find((e) => e.action === AuditAction.DNS_PROVIDER_UPDATE)!;
            expect(entry.details).toEqual({ name: "Renamed", fields: ["name", "zones", "options", "enabled", "allowTakeover"], optionKeys: ["zoneIds"], credentialsChanged: false });
        });

        it("refuses a type change, a taken name, an older version and options the zones don't fit", async () => {
            const created = await create();
            await create(cloudflare({ name: "Other", zones: ["example.net"] }));
            expect((await update(created.uid, { type: "route53" })).status).toBe(400);
            const taken = await update(created.uid, { name: "other" });
            expect(taken.status).toBe(409);
            expect(taken.body.code).toBe(ApiErrors.IDENTIFIER_EXISTS);
            // The same code as the optimistic lock's own failure, however the older version is noticed.
            const stale = await update(created.uid, { name: "Cloudflare main", enabled: false, version: created.version + 5 });
            expect(stale.status).toBe(409);
            expect(stale.body.code).toBe(ApiErrors.INVALID_OBJECT_VERSION);
            // Two zones but still one zone ID.
            expect((await update(created.uid, { zones: ["example.com", "example.org"] })).status).toBe(400);
            expect((await update(created.uid, { enabled: "no" })).status).toBe(400);
            expect((await ctx.providerRow(created.uid)).enabled).toBe(true);
        });

        it("refuses narrowing the zones while an assigned domain would fall outside them (409), and allows it otherwise", async () => {
            const created = await create(cloudflare({ zones: ["example.com", "example.org"], options: { zoneIds: [CF_ZONE_ID, CF_ZONE_ID_2] } }));
            await ctx.saveDomain({ name: "mail.example.org", dnsProviderUid: created.uid });
            const refused = await update(created.uid, { zones: ["example.com"], options: { zoneIds: [CF_ZONE_ID] } });
            expect(refused.status).toBe(409);
            expect(refused.body.message).toContain("mail.example.org");

            const allowed = await update(created.uid, { zones: ["example.org"], options: { zoneIds: [CF_ZONE_ID_2] } });
            expect(allowed.status).toBe(200);
            expect(allowed.body.domainCount).toBe(1);
        });

        it("refuses a zone another config already has (409) on a change of zones, naming the zone and the config, and changes nothing", async () => {
            const first = await create(cloudflare({ name: "First", zones: ["example.com"] }));
            const second = await create(cloudflare({ name: "Second", zones: ["example.org"], options: { zoneIds: [CF_ZONE_ID_2] } }));
            const refused = await update(second.uid, { zones: ["example.org", "EXAMPLE.com."], options: { zoneIds: [CF_ZONE_ID_2, CF_ZONE_ID] }, enabled: false });
            expect(refused.status).toBe(409);
            expect(refused.body.code).toBe(ApiErrors.IDENTIFIER_EXISTS);
            expect(refused.body.message).toContain("example.com");
            expect(refused.body.message).toContain("First");
            const row = await ctx.providerRow(second.uid);
            expect(row.zones).toEqual(["example.org"]);
            expect(row.enabled).toBe(true);

            // A config's own zones aren't another's: keeping, reordering or adding to them is fine, and so is a zone under or above another config's.
            expect((await update(first.uid, { zones: ["example.com"], enabled: false })).status).toBe(200);
            expect((await update(second.uid, { zones: ["mail.example.com", "example.org"], options: { zoneIds: [CF_ZONE_ID, CF_ZONE_ID_2] } })).status).toBe(200);
            expect((await ctx.providerRow(first.uid)).enabled).toBe(false);
        });

        it("refuses added zones that cover a domain assigned to another config more specifically (409), but not one that config no longer covers", async () => {
            const parent = await create(cloudflare({ name: "Parent" }));
            const other = await create(cloudflare({ name: "Other", zones: ["example.org"], options: { zoneIds: [CF_ZONE_ID_2] } }));
            await ctx.saveDomain({ name: "eu.example.com", dnsProviderUid: parent.uid });

            const refused = await update(other.uid, { zones: ["example.org", "eu.example.com"], options: { zoneIds: [CF_ZONE_ID_2, CF_ZONE_ID] } });
            expect(refused.status).toBe(409);
            expect(refused.body.code).toBe(ApiErrors.IDENTIFIER_EXISTS);
            expect(refused.body.message).toContain("eu.example.com");
            expect(refused.body.message).toContain("Parent");
            expect((await ctx.providerRow(other.uid)).zones).toEqual(["example.org"]);

            // The parent's own change doesn't take its domains from itself.
            expect((await update(parent.uid, { zones: ["example.com", "eu.example.com"], options: { zoneIds: [CF_ZONE_ID, CF_ZONE_ID_2] } })).status).toBe(200);
            // Assigned to a config whose zones don't cover it: manual already, so nothing is taken from it.
            await ctx.saveDomain({ name: "old.example.net", dnsProviderUid: parent.uid });
            expect((await update(other.uid, { zones: ["example.org", "old.example.net"], options: { zoneIds: [CF_ZONE_ID_2, CF_ZONE_ID] } })).status).toBe(200);
        });

        it("checks the zones against every assigned domain, not only the first page of them", async () => {
            const created = await create(cloudflare({ zones: ["example.com", "example.org"], options: { zoneIds: [CF_ZONE_ID, CF_ZONE_ID_2] } }));
            const rows: Record<string, unknown>[] = [];
            for (let i = 0; i < 1000; i++) {
                rows.push({ name: `h${String(i).padStart(4, "0")}.example.com`, dnsProviderUid: created.uid });
            }
            // Sorts after every other one.
            rows.push({ name: "zz.example.org", dnsProviderUid: created.uid });
            await ctx.saveDomains(rows);

            expect((await as(adminToken, request(ctx.app()).get(providers(`/${created.uid}`)))).body.domainCount).toBe(1001);
            const refused = await update(created.uid, { zones: ["example.com"], options: { zoneIds: [CF_ZONE_ID] } });
            expect(refused.status).toBe(409);
            expect(refused.body.message).toContain("zz.example.org");
            const deleted = await as(adminToken, request(ctx.app()).delete(providers(`/${created.uid}`)));
            expect(deleted.status).toBe(409);
            expect(deleted.body.message).toContain("1001 domain(s)");
        });
    });

    describe("delete", () => {
        it("refuses a caller without elevation (403), an unknown config (404) and a config with assigned domains (409)", async () => {
            const created = await create();
            expect((await as(unelevatedToken, request(ctx.app()).delete(providers(`/${created.uid}`)))).status).toBe(403);
            expect((await as(adminToken, request(ctx.app()).delete(providers("/nope")))).status).toBe(404);
            await ctx.saveDomain({ name: "example.com", dnsProviderUid: created.uid });
            const refused = await as(adminToken, request(ctx.app()).delete(providers(`/${created.uid}`)));
            expect(refused.status).toBe(409);
            expect(refused.body.message).toContain("example.com");
            expect(await ctx.providerRow(created.uid)).toBeTruthy();
        });

        it("removes the row, and the encrypted credentials with it, and audits it", async () => {
            const created = await create();
            const result = await as(adminToken, request(ctx.app()).delete(providers(`/${created.uid}`)));
            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            expect(await ctx.providerRow(created.uid)).toBeFalsy();
            const entry = (await ctx.auditEntries()).find((e) => e.action === AuditAction.DNS_PROVIDER_DELETE)!;
            expect(entry.details).toEqual({ name: "Cloudflare main", type: "cloudflare" });
            expect(JSON.stringify(await ctx.auditEntries())).not.toContain(TOKEN);
        });

        it("removes a config that has no credentials", async () => {
            const created = await create({ name: "AWS", type: "route53", zones: ["example.com"], options: { region: "us-east-1" } });
            expect((await as(adminToken, request(ctx.app()).delete(providers(`/${created.uid}`)))).status).toBeLessThan(300);
            expect((await ctx.auditEntries()).find((e) => e.action === AuditAction.DNS_PROVIDER_DELETE)!.details).toEqual({ name: "AWS", type: "route53" });
        });
    });

    describe("assigning a domain", () => {
        it("assigns a domain to a config whose zones cover it, reassigns it and sets it back to manual, auditing each change", async () => {
            const first = await create();
            await ctx.saveDomain({ name: "mail.example.com" });

            const assigned = await assign("mail.example.com", { dnsProviderUid: first.uid });
            expect(assigned.status).toBe(200);
            expect(assigned.body.dnsProviderUid).toBe(first.uid);
            expect((await ctx.domainRow("mail.example.com")).dnsProviderUid).toBe(first.uid);

            // The same provider again changes nothing.
            expect((await assign("mail.example.com", { dnsProviderUid: first.uid })).status).toBe(200);

            // A config added later for the subdomain's own zone is the more specific one, which the domain moves to through manual: adding the config
            // is refused while the domain is assigned to the parent.
            expect((await as(adminToken, request(ctx.app()).post(providers())).send(cloudflare({ name: "Second", zones: ["mail.example.com"] }))).status).toBe(409);
            expect((await assign("mail.example.com", { dnsProviderUid: null })).status).toBe(200);
            const second = await create(cloudflare({ name: "Second", zones: ["mail.example.com"] }));
            expect((await assign("mail.example.com", { dnsProviderUid: second.uid })).body.dnsProviderUid).toBe(second.uid);
            const manual = await assign("mail.example.com", { dnsProviderUid: null });
            expect(manual.status).toBe(200);
            expect(manual.body.dnsProviderUid ?? undefined).toBeUndefined();
            expect((await ctx.domainRow("mail.example.com")).dnsProviderUid ?? undefined).toBeUndefined();

            const entries = (await ctx.auditEntries()).filter((e) => e.action === AuditAction.DOMAIN_DNS_PROVIDER_ASSIGN);
            expect(entries.map((e) => [e.targetUid, e.details])).toEqual([
                ["mail.example.com", { name: "mail.example.com", from: null, to: first.uid }],
                ["mail.example.com", { name: "mail.example.com", from: first.uid, to: null }],
                ["mail.example.com", { name: "mail.example.com", from: null, to: second.uid }],
                ["mail.example.com", { name: "mail.example.com", from: second.uid, to: null }],
            ]);
        });

        it("assigns a domain only to the config whose zones cover it most specifically (400 otherwise, naming that config), disabled ones included", async () => {
            const parent = await create(cloudflare({ name: "Parent" }));
            const nested = await create(cloudflare({ name: "Nested", zones: ["mail.example.com"] }));
            for (const name of ["example.com", "www.example.com", "mail.example.com", "a.mail.example.com", "b.mail.example.com"]) {
                await ctx.saveDomain({ name });
            }

            // What the nested zone covers publishes only through the nested config: the parent's external-dns instance leaves that zone out.
            for (const name of ["mail.example.com", "a.mail.example.com"]) {
                const refused = await assign(name, { dnsProviderUid: parent.uid });
                expect(refused.status, name).toBe(400);
                expect(refused.body.message).toContain("Nested");
                expect((await ctx.domainRow(name)).dnsProviderUid ?? undefined).toBeUndefined();
                expect((await assign(name, { dnsProviderUid: nested.uid })).status, name).toBe(200);
            }
            // The rest of the parent's zone stays with the parent, which the nested config doesn't cover.
            for (const name of ["example.com", "www.example.com"]) {
                expect((await assign(name, { dnsProviderUid: nested.uid })).status, name).toBe(400);
                expect((await assign(name, { dnsProviderUid: parent.uid })).status, name).toBe(200);
            }
            // A disabled config still holds its zone, so it still counts; and a domain can always go back to manual.
            expect((await update(nested.uid, { enabled: false })).status).toBe(200);
            expect((await assign("b.mail.example.com", { dnsProviderUid: parent.uid })).status).toBe(400);
            expect((await assign("a.mail.example.com", { dnsProviderUid: null })).status).toBe(200);
            expect((await ctx.domainRow("a.mail.example.com")).dnsProviderUid ?? undefined).toBeUndefined();
        });

        it("refuses a caller without a trusted role or elevation (403) and an unknown domain (404)", async () => {
            const created = await create();
            await ctx.saveDomain({ name: "example.com" });
            expect((await assign("example.com", { dnsProviderUid: created.uid }, userToken)).status).toBe(403);
            expect((await assign("example.com", { dnsProviderUid: created.uid }, unelevatedToken)).status).toBe(403);
            expect((await assign("nope.example.com", { dnsProviderUid: created.uid })).status).toBe(404);
            expect((await ctx.domainRow("example.com")).dnsProviderUid ?? undefined).toBeUndefined();
        });

        it("refuses a missing or malformed provider, an unknown one and one whose zones don't cover the domain (400)", async () => {
            const created = await create();
            await ctx.saveDomain({ name: "example.net" });
            await ctx.saveDomain({ name: "notexample.com" });
            expect((await assign("example.net", {})).status).toBe(400);
            expect((await assign("example.net", { dnsProviderUid: 5 })).status).toBe(400);
            expect((await assign("example.net", ["x"])).status).toBe(400);
            expect((await assign("example.net", { dnsProviderUid: "nope" })).status).toBe(400);
            expect((await assign("example.net", { dnsProviderUid: created.uid })).status).toBe(400);
            // A name that merely ends with the zone's text is not in it.
            expect((await assign("notexample.com", { dnsProviderUid: created.uid })).status).toBe(400);
            expect(await actions()).toEqual([AuditAction.DNS_PROVIDER_CREATE]);
        });

        it("keeps the assignment out of every other way of writing a domain", async () => {
            const created = await create();
            await ctx.saveDomain({ name: "example.com", dnsProviderUid: created.uid });
            const row = await ctx.domainRow("example.com");

            // A plain PUT round-tripping the domain ignores the server-managed fields.
            const put = await as(adminToken, request(ctx.app()).put(domains("/example.com"))).send({
                uid: "example.com",
                version: row.version,
                enabled: false,
                dnsProviderUid: null,
                dnsPublication: { endpoints: [], records: [] },
            });
            expect(put.status).toBe(200);
            expect(put.body.enabled).toBe(false);
            expect((await ctx.domainRow("example.com")).dnsProviderUid).toBe(created.uid);
            expect((await ctx.domainRow("example.com")).dnsPublication ?? undefined).toBeUndefined();

            // `PUT /:id/:property` refuses them outright.
            expect((await as(adminToken, request(ctx.app()).put(domains("/example.com/dnsProviderUid"))).send({ value: null })).status).toBe(403);
            expect((await as(adminToken, request(ctx.app()).put(domains("/example.com/dnsPublication"))).send({ endpoints: [], records: [] })).status).toBe(403);

            // A create can't assign a provider either.
            const createdDomain = await as(adminToken, request(ctx.app()).post(domains())).send({ name: "example.org", dnsProviderUid: created.uid, dnsPublication: { endpoints: [], records: [] } });
            expect(createdDomain.status).toBe(200);
            expect(createdDomain.body.dnsProviderUid ?? undefined).toBeUndefined();
            expect(createdDomain.body.dnsPublication ?? undefined).toBeUndefined();
        });
    });

    describe("deployment identity", () => {
        it("is created once with a random installation id, and every later or concurrent call returns the same row", async () => {
            const [a, b] = await Promise.all([findOrCreateDeploymentIdentity(ctx.identityRepo()), findOrCreateDeploymentIdentity(ctx.identityRepo())]);
            expect(a.uid).toBe(DEPLOYMENT_IDENTITY_UID);
            expect(a.installationId).toMatch(INSTALLATION_ID_PATTERN);
            expect(b.installationId).toBe(a.installationId);
            expect((await findOrCreateDeploymentIdentity(ctx.identityRepo())).installationId).toBe(a.installationId);
        });

        it("refuses a malformed installation id rather than replacing it", async () => {
            await ctx.saveIdentity("NOT valid");
            await expect(findOrCreateDeploymentIdentity(ctx.identityRepo())).rejects.toThrow(/malformed/);
        });
    });
}
