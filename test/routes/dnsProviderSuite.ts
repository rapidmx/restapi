///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// HTTP behaviour of `system/dns-providers`, of assigning a domain to one (`PUT mail/domains/:id/dns-provider`) and of the deployment identity, identical on
// both backends. Credentials go to the (in-memory) secret store only: every test that saves one also checks the stored row and the audit entry never
// carry its value.
import { request } from "@rapidrest/service-core/test";
import { JWTUtils } from "@rapidrest/core";
import { ApiErrors, type RepoUtils } from "@rapidrest/service-core";
import * as uuid from "uuid";
import { DNS_PROVIDER_UID_PATTERN } from "../../src/dns/DnsProviderTypes.js";
import { AuditAction, DeploymentIdentity } from "../../src/models/types.js";
import { NO_SECRET_STORE_MESSAGE } from "../../src/secrets/NullSecretStore.js";
import { DEPLOYMENT_IDENTITY_UID, findOrCreateDeploymentIdentity, INSTALLATION_ID_PATTERN } from "../../src/util/DeploymentIdentityUtils.js";
import type { InMemorySecretStore } from "../testDoubles.js";

export interface DnsProviderSuiteContext {
    config: any;
    app: () => any;
    prefix: string;
    store: () => InMemorySecretStore;
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
        ctx.store().reset();
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
            expect(ctx.store().secrets.size).toBe(0);
            expect((await as(adminToken, request(ctx.app()).get(providers()))).body).toEqual([]);
        });

        it("saves the credentials in the secret store and only a reference on the row, never the value", async () => {
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

            expect(ctx.store().secrets.get(`dns/${created.uid}`)).toEqual({ apiToken: TOKEN });
            const row = await ctx.providerRow(created.uid);
            expect(row.secretRef).toEqual({ backend: "openbao", path: `dns/${created.uid}`, keys: ["apiToken"], generation: 1 });
            expect(JSON.stringify(row)).not.toContain(TOKEN);

            const [entry] = await ctx.auditEntries();
            expect(entry).toEqual(expect.objectContaining({ action: AuditAction.DNS_PROVIDER_CREATE, targetUid: created.uid }));
            expect(entry.details).toEqual(expect.objectContaining({ name: "Cloudflare main", type: "cloudflare", optionKeys: ["zoneIds"], credentialsChanged: true }));
            expect(JSON.stringify(entry)).not.toContain(TOKEN);
        });

        it("refuses to save credentials without a secret store (400), and creates nothing", async () => {
            ctx.store().refuse = true;
            const result = await as(adminToken, request(ctx.app()).post(providers())).send(cloudflare());
            expect(result.status).toBe(400);
            expect(result.body.message).toBe(NO_SECRET_STORE_MESSAGE);
            expect((await as(adminToken, request(ctx.app()).get(providers()))).body).toEqual([]);
            expect(await actions()).toEqual([]);
        });

        it("creates a config that needs no credentials without a store: Route 53 through the service account's role, with defaults filled in", async () => {
            ctx.store().refuse = true;
            const created = await create({ name: "AWS", type: "route53", zones: ["example.com"], options: { region: "US-EAST-1" }, allowTakeover: true, enabled: false });
            expect(created).toEqual(expect.objectContaining({ options: { region: "us-east-1", zoneType: "public" }, credentials: {}, allowTakeover: true, enabled: false }));
            expect((await ctx.providerRow(created.uid)).secretRef ?? undefined).toBeUndefined();
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
            expect(ctx.store().secrets.size).toBe(0);
        });

        it("refuses a name another config has, whatever its case (409), without touching the store", async () => {
            await create();
            const result = await as(adminToken, request(ctx.app()).post(providers())).send(cloudflare({ name: "CLOUDFLARE MAIN", credentials: { apiToken: "other" } }));
            expect(result.status).toBe(409);
            expect(ctx.store().secrets.size).toBe(1);

            // A name that reads like a search operator is compared as text.
            await create(cloudflare({ name: "gt(a)", credentials: { apiToken: "gt-token" } }));
            expect((await as(adminToken, request(ctx.app()).post(providers())).send(cloudflare({ name: "GT(A)" }))).status).toBe(409);
        });

        it("refuses a name another config took while the credentials were being saved (409), and removes the credentials it wrote", async () => {
            ctx.store().duringChange = async () => {
                const other = await as(adminToken, request(ctx.app()).post(providers())).send({ name: "cloudflare MAIN", type: "route53", zones: ["example.org"], options: { region: "us-east-1" } });
                expect(other.status).toBe(200);
            };
            const result = await as(adminToken, request(ctx.app()).post(providers())).send(cloudflare());
            expect(result.status).toBe(409);
            expect(result.body.code).toBe(ApiErrors.IDENTIFIER_EXISTS);
            expect(ctx.store().secrets.size).toBe(0);
            expect((await as(adminToken, request(ctx.app()).get(providers()))).body.map((p: any) => p.name)).toEqual(["cloudflare MAIN"]);
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
            expect(ctx.store().secrets.size).toBe(0);
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
            const roundTrip = await update(created.uid, { ...created });
            expect(roundTrip.status).toBe(200);
            expect(roundTrip.body).toEqual(created);
            expect(ctx.store().secrets.get(`dns/${created.uid}`)).toEqual({ apiToken: TOKEN });
            expect(await actions()).toEqual([AuditAction.DNS_PROVIDER_CREATE]);
        });

        it("replaces a credential in the store, bumping the reference's generation, and audits that it changed without its value", async () => {
            const created = await create();
            const result = await update(created.uid, { credentials: { apiToken: " new-token-VALUE\n" } });
            expect(result.status).toBe(200);
            expect(result.body.credentials).toEqual({ apiToken: { secret: true } });
            expect(ctx.store().secrets.get(`dns/${created.uid}`)).toEqual({ apiToken: "new-token-VALUE" });
            const row = await ctx.providerRow(created.uid);
            expect(row.secretRef.generation).toBe(2);
            expect(JSON.stringify(row)).not.toContain("new-token-VALUE");
            const entry = (await ctx.auditEntries()).find((e) => e.action === AuditAction.DNS_PROVIDER_UPDATE)!;
            expect(entry.details).toEqual({ name: "Cloudflare main", fields: ["credentials"], optionKeys: [], credentialsChanged: true });
            expect(JSON.stringify(entry)).not.toContain("new-token-VALUE");
        });

        it("clears credentials with null, removing them from the store when none is left, and refuses leaving a required one unset", async () => {
            const created = await create({
                name: "AWS",
                type: "route53",
                zones: ["example.com"],
                options: { region: "us-east-1" },
                credentials: { accessKeyId: "AKIAABCDEFGHIJKLMNOP", secretAccessKey: "secret-VALUE" },
            });
            expect((await update(created.uid, { credentials: { accessKeyId: null } })).status).toBe(400);
            expect(ctx.store().secrets.get(`dns/${created.uid}`)).toEqual({ accessKeyId: "AKIAABCDEFGHIJKLMNOP", secretAccessKey: "secret-VALUE" });

            const cleared = await update(created.uid, { credentials: { accessKeyId: null, secretAccessKey: null } });
            expect(cleared.status).toBe(200);
            expect(cleared.body.credentials).toEqual({});
            expect(ctx.store().secrets.has(`dns/${created.uid}`)).toBe(false);
            expect((await ctx.providerRow(created.uid)).secretRef ?? undefined).toBeUndefined();

            // Clearing a field that isn't saved is no change at all.
            const noop = await update(created.uid, { credentials: { accessKeyId: null } });
            expect(noop.status).toBe(200);
            expect((await actions()).filter((a) => a === AuditAction.DNS_PROVIDER_UPDATE)).toHaveLength(1);

            // ... and adding them back writes a new secret.
            const restored = await update(created.uid, { credentials: { accessKeyId: "AKIAABCDEFGHIJKLMNOP", secretAccessKey: "s2" } });
            expect(restored.body.credentials).toEqual({ accessKeyId: { secret: true }, secretAccessKey: { secret: true } });
            expect(ctx.store().secrets.get(`dns/${created.uid}`)).toEqual({ accessKeyId: "AKIAABCDEFGHIJKLMNOP", secretAccessKey: "s2" });
        });

        it("refuses a credential change without a secret store (400) and leaves the row as it was", async () => {
            const created = await create();
            ctx.store().refuse = true;
            const result = await update(created.uid, { name: "renamed", credentials: { apiToken: "x" } });
            expect(result.status).toBe(400);
            expect(result.body.message).toBe(NO_SECRET_STORE_MESSAGE);
            expect((await ctx.providerRow(created.uid)).name).toBe("Cloudflare main");
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
            await create(cloudflare({ name: "Other" }));
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

        it("points the row at new credentials when another write lands during the store call, audits the change and still refuses the rest (409)", async () => {
            const created = await create();
            // Another admin's change (or the controller's status report) bumps the version while the token is being patched in the store.
            ctx.store().duringChange = async () => {
                expect((await update(created.uid, { enabled: false })).status).toBe(200);
            };
            const result = await update(created.uid, { name: "Renamed", credentials: { apiToken: "raced-token-VALUE" } });
            expect(result.status).toBe(409);
            expect(result.body.code).toBe(ApiErrors.INVALID_OBJECT_VERSION);

            expect(ctx.store().secrets.get(`dns/${created.uid}`)).toEqual({ apiToken: "raced-token-VALUE" });
            const row = await ctx.providerRow(created.uid);
            // The store's new generation reached the row (so the pod rolls), the other write's change stands, and the refused rename was not applied.
            expect(row.secretRef).toEqual({ backend: "openbao", path: `dns/${created.uid}`, keys: ["apiToken"], generation: 2 });
            expect(row.enabled).toBe(false);
            expect(row.name).toBe("Cloudflare main");
            const entries = (await ctx.auditEntries()).filter((e) => e.action === AuditAction.DNS_PROVIDER_UPDATE);
            expect(entries.map((e) => e.details)).toEqual([
                { name: "Cloudflare main", fields: ["enabled"], optionKeys: [], credentialsChanged: false },
                { name: "Cloudflare main", fields: ["credentials"], optionKeys: [], credentialsChanged: true, rowWriteFailed: true, rowMatchesStore: true },
            ]);
            expect(JSON.stringify(entries)).not.toContain("raced-token-VALUE");
        });

        it("keeps the row on the cleared reference when the secret is removed while another write lands", async () => {
            const created = await create({
                name: "AWS",
                type: "route53",
                zones: ["example.com"],
                options: { region: "us-east-1" },
                credentials: { accessKeyId: "AKIAABCDEFGHIJKLMNOP", secretAccessKey: "secret-VALUE" },
            });
            ctx.store().duringChange = async () => {
                expect((await update(created.uid, { allowTakeover: true })).status).toBe(200);
            };
            expect((await update(created.uid, { credentials: { accessKeyId: null, secretAccessKey: null } })).status).toBe(409);
            expect(ctx.store().secrets.has(`dns/${created.uid}`)).toBe(false);
            const row = await ctx.providerRow(created.uid);
            expect(row.secretRef ?? undefined).toBeUndefined();
            expect(row.allowTakeover).toBe(true);
        });

        it("never sends a reference from another backend to this deployment's store: clearing leaves it there, replacing writes a new one", async () => {
            const created = await create({
                name: "AWS",
                type: "route53",
                zones: ["example.com"],
                options: { region: "us-east-1" },
                credentials: { accessKeyId: "AKIAABCDEFGHIJKLMNOP", secretAccessKey: "secret-VALUE" },
            });
            // A database restored into a deployment whose store is another backend.
            ctx.store().backend = "kubernetes";

            // Keeping a field whose value is only in the other backend can't be done.
            const partial = await update(created.uid, { credentials: { secretAccessKey: "s2" } });
            expect(partial.status).toBe(409);
            expect(ctx.store().secrets.get(`dns/${created.uid}`)).toEqual({ accessKeyId: "AKIAABCDEFGHIJKLMNOP", secretAccessKey: "secret-VALUE" });

            // Replacing every field writes them to this store, saying the old ones were left behind.
            const replaced = await update(created.uid, { credentials: { accessKeyId: "AKIAZYXWVUTSRQPONMLK", secretAccessKey: "s3" } });
            expect(replaced.status).toBe(200);
            const row = await ctx.providerRow(created.uid);
            expect(row.secretRef).toEqual(expect.objectContaining({ backend: "kubernetes", keys: ["accessKeyId", "secretAccessKey"] }));

            // Clearing every field leaves another backend's secret where it is, and says so.
            ctx.store().backend = "openbao";
            const cleared = await update(created.uid, { credentials: { accessKeyId: null, secretAccessKey: null } });
            expect(cleared.status).toBe(200);
            expect(ctx.store().secrets.has(`dns/${created.uid}`)).toBe(true);
            expect((await ctx.providerRow(created.uid)).secretRef ?? undefined).toBeUndefined();

            const details = (await ctx.auditEntries()).filter((e) => e.action === AuditAction.DNS_PROVIDER_UPDATE).map((e) => e.details);
            expect(details).toEqual([
                { name: "AWS", fields: ["credentials"], optionKeys: [], credentialsChanged: true, secretLeftBehind: true },
                { name: "AWS", fields: ["credentials"], optionKeys: [], credentialsChanged: true, secretLeftBehind: true },
            ]);
        });

        it("refuses a rename to a name another config took while the credentials were being saved (409), keeping the new credentials", async () => {
            const created = await create();
            ctx.store().duringChange = async () => {
                const other = await as(adminToken, request(ctx.app()).post(providers())).send({ name: "Beta", type: "route53", zones: ["example.org"], options: { region: "us-east-1" } });
                expect(other.status).toBe(200);
            };
            const result = await update(created.uid, { name: "BETA", credentials: { apiToken: "beta-token-VALUE" } });
            expect(result.status).toBe(409);
            expect(result.body.code).toBe(ApiErrors.IDENTIFIER_EXISTS);
            const row = await ctx.providerRow(created.uid);
            expect(row.name).toBe("Cloudflare main");
            expect(row.secretRef.generation).toBe(2);
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
            expect(ctx.store().secrets.size).toBe(1);
        });

        it("removes the row, then its credentials from the store, and audits it", async () => {
            const created = await create();
            const result = await as(adminToken, request(ctx.app()).delete(providers(`/${created.uid}`)));
            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            expect(await ctx.providerRow(created.uid)).toBeFalsy();
            expect(ctx.store().secrets.size).toBe(0);
            const entry = (await ctx.auditEntries()).find((e) => e.action === AuditAction.DNS_PROVIDER_DELETE)!;
            expect(entry.details).toEqual({ name: "Cloudflare main", type: "cloudflare", secretLeftBehind: false });
        });

        it("still removes the row when the store can't remove the credentials, or holds another backend's, and says they were left behind", async () => {
            const failing = await create();
            ctx.store().failDelete = true;
            expect((await as(adminToken, request(ctx.app()).delete(providers(`/${failing.uid}`)))).status).toBeLessThan(300);
            expect(await ctx.providerRow(failing.uid)).toBeFalsy();

            ctx.store().failDelete = false;
            const other = await create(cloudflare({ name: "Other" }));
            ctx.store().backend = "none";
            expect((await as(adminToken, request(ctx.app()).delete(providers(`/${other.uid}`)))).status).toBeLessThan(300);
            expect(ctx.store().secrets.has(`dns/${other.uid}`)).toBe(true);

            const left = (await ctx.auditEntries()).filter((e) => e.action === AuditAction.DNS_PROVIDER_DELETE).map((e) => e.details.secretLeftBehind);
            expect(left).toEqual([true, true]);
        });

        it("removes a config that has no credentials", async () => {
            const created = await create({ name: "AWS", type: "route53", zones: ["example.com"], options: { region: "us-east-1" } });
            expect((await as(adminToken, request(ctx.app()).delete(providers(`/${created.uid}`)))).status).toBeLessThan(300);
            expect((await ctx.auditEntries()).find((e) => e.action === AuditAction.DNS_PROVIDER_DELETE)!.details.secretLeftBehind).toBe(false);
        });
    });

    describe("assigning a domain", () => {
        it("assigns a domain to a config whose zones cover it, reassigns it and sets it back to manual, auditing each change", async () => {
            const first = await create();
            const second = await create(cloudflare({ name: "Second", zones: ["mail.example.com"] }));
            await ctx.saveDomain({ name: "mail.example.com" });

            const assigned = await assign("mail.example.com", { dnsProviderUid: first.uid });
            expect(assigned.status).toBe(200);
            expect(assigned.body.dnsProviderUid).toBe(first.uid);
            expect((await ctx.domainRow("mail.example.com")).dnsProviderUid).toBe(first.uid);

            // The same provider again changes nothing.
            expect((await assign("mail.example.com", { dnsProviderUid: first.uid })).status).toBe(200);

            expect((await assign("mail.example.com", { dnsProviderUid: second.uid })).body.dnsProviderUid).toBe(second.uid);
            const manual = await assign("mail.example.com", { dnsProviderUid: null });
            expect(manual.status).toBe(200);
            expect(manual.body.dnsProviderUid ?? undefined).toBeUndefined();
            expect((await ctx.domainRow("mail.example.com")).dnsProviderUid ?? undefined).toBeUndefined();

            const entries = (await ctx.auditEntries()).filter((e) => e.action === AuditAction.DOMAIN_DNS_PROVIDER_ASSIGN);
            expect(entries.map((e) => [e.targetUid, e.details])).toEqual([
                ["mail.example.com", { name: "mail.example.com", from: null, to: first.uid }],
                ["mail.example.com", { name: "mail.example.com", from: first.uid, to: second.uid }],
                ["mail.example.com", { name: "mail.example.com", from: second.uid, to: null }],
            ]);
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
