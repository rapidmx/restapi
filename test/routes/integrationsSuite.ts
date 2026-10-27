///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// HTTP behaviour of `system/integrations`, identical on both backends. Secrets are saved as encrypted envelopes in the settings row, in the one write that
// saves the rest of the change: every test that saves one also checks the stored row and the audit entries never carry its value.
import { request } from "@rapidrest/service-core/test";
import { ApiError, JWTUtils } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import * as uuid from "uuid";
import { AuditAction } from "../../src/models/types.js";
import { isConfigEnvelope, type ConfigCipher } from "../../src/secrets/ConfigCipher.js";
import { DEFAULT_DOH_ENDPOINT } from "../../src/util/IntegrationSettingsUtils.js";
import { setDiscoveryAddressLookup } from "../../src/util/KeyDiscoveryClient.js";

export interface IntegrationsSuiteContext {
    config: any;
    app: () => any;
    prefix: string;
    cipher: () => ConfigCipher;
    clear: () => Promise<void>;
    /** The stored settings row, as the database holds it (`undefined`/`null` when there is none). */
    row: () => Promise<any>;
    auditEntries: () => Promise<{ action: string; targetType?: string; targetUid: string; details?: any }[]>;
}

const MASK = { secret: true };
const GIPHY_KEY = "giphy-KEY-never-stored";
const REGISTRY_TOKEN = "npm_REGISTRY_never_stored";
const NAMESPACE_TOKEN = "npm_NAMESPACE_never_stored";

export function integrationsSuite(ctx: IntegrationsSuiteContext): void {
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
        setDiscoveryAddressLookup(async (hostname) => {
            const addresses: Record<string, string[]> = {
                "registry.example.com": ["93.184.216.34"],
                "npm.acme.example.com": ["93.184.216.35"],
                "acme.example.com": ["93.184.216.36"],
                "dns.example.com": ["93.184.216.37"],
                "registry.internal.example.com": ["10.0.0.8"],
            };
            if (!addresses[hostname]) {
                throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
            }
            return addresses[hostname];
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    afterAll(() => {
        setDiscoveryAddressLookup();
    });

    const path = (suffix = "") => `${ctx.prefix}/integrations${suffix}`;
    const as = (token: string, req: any) => req.set("Authorization", "jwt " + token);
    const get = (token = adminToken) => as(token, request(ctx.app()).get(path()));
    const put = (section: string, body: unknown, token = adminToken) => as(token, request(ctx.app()).put(path(`/${section}`))).send(body as any);
    const reset = (section: string, body: unknown = {}, token = adminToken) => as(token, request(ctx.app()).post(path(`/${section}/reset`))).send(body as any);
    const ok = async (req: Promise<any>) => {
        const result = await req;
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        return result.body;
    };
    const audits = async () => (await ctx.auditEntries()).filter((entry) => entry.action === AuditAction.INTEGRATION_UPDATE || entry.action === AuditAction.INTEGRATION_RESET);
    /** What an envelope of `field` of the settings row holds, decrypted as the context it was saved for: the one way a test reads a secret back. */
    const open = (field: string, sealed: unknown): string => ctx.cipher().decryptString(sealed as any, { record: "IntegrationSettings", uid: "integrations", field });
    /** Everything persisted: what must never hold a secret's value. */
    const persisted = async () => JSON.stringify({ row: await ctx.row(), audits: await ctx.auditEntries() });
    /** Makes saving a secret fail as it does on a server without a keyring (503), and answers the spy so a test can see whether anything was encrypted. */
    const withoutKeyring = () =>
        vi.spyOn(ctx.cipher(), "encrypt").mockImplementation(() => {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 503, "No configuration keyring is loaded, so secrets can't be saved.");
        });

    describe("GET", () => {
        it("answers a trusted role with the deployment's values, before anything is saved, and writes nothing", async () => {
            const body = await ok(get());
            expect(body.version).toBe(0);
            expect(body.giphy).toEqual({ values: { enabled: true, apiKey: null }, defaults: { enabled: true, apiKey: null }, source: { enabled: "deployment", apiKey: "deployment" } });
            expect(body.dnsResolver.values).toEqual({ mode: "node", dohEndpoint: DEFAULT_DOH_ENDPOINT });
            expect(body.pluginRegistry.values.namespaces).toEqual([{ name: "@rapidmx" }]);
            expect(Object.keys(body).sort()).toEqual(["dnsResolver", "giphy", "pluginRegistry", "signingCa", "stun", "version"]);
            expect(await ctx.row()).toBeFalsy();
        });

        it("refuses a caller without a trusted role", async () => {
            expect((await get(userToken)).status).toBe(403);
            expect([401, 403]).toContain((await request(ctx.app()).get(path())).status);
        });
    });

    describe("PUT /:section", () => {
        it("refuses a caller without a trusted role or without elevation (403), and saves nothing", async () => {
            expect((await put("giphy", { apiKey: GIPHY_KEY }, userToken)).status).toBe(403);
            expect((await put("giphy", { apiKey: GIPHY_KEY }, unelevatedToken)).status).toBe(403);
            expect((await reset("giphy", {}, unelevatedToken)).status).toBe(403);
            expect(await ctx.row()).toBeFalsy();
            expect(await audits()).toEqual([]);
        });

        it("saves the Giphy key encrypted on the row, bound to it and its field, never the value", async () => {
            const body = await ok(put("giphy", { enabled: true, apiKey: `  ${GIPHY_KEY}\n` }));
            expect(body.giphy).toEqual({ values: { enabled: true, apiKey: MASK }, defaults: { enabled: true, apiKey: null }, source: { enabled: "admin", apiKey: "admin" } });
            expect(body.version).toBeGreaterThan(0);
            const row = await ctx.row();
            expect(row.uid).toBe("integrations");
            expect(row.giphy.enabled).toBe(true);
            expect(Object.keys(row.giphy).sort()).toEqual(["apiKey", "enabled"]);
            expect(isConfigEnvelope(row.giphy.apiKey)).toBe(true);
            expect(open("giphy.apiKey", row.giphy.apiKey)).toBe(GIPHY_KEY);
            expect(await persisted()).not.toContain(GIPHY_KEY);
            // Bound to this row and field: copied to another field, row or record type it doesn't decrypt.
            const cipher = ctx.cipher();
            expect(() => open("pluginRegistry.token", row.giphy.apiKey)).toThrow();
            expect(() => cipher.decryptString(row.giphy.apiKey, { record: "IntegrationSettings", uid: "another-row", field: "giphy.apiKey" })).toThrow();
            expect(() => cipher.decryptString(row.giphy.apiKey, { record: "DnsProvider", uid: "integrations", field: "giphy.apiKey" })).toThrow();

            const [entry] = await audits();
            expect(entry).toEqual(expect.objectContaining({ action: AuditAction.INTEGRATION_UPDATE, targetType: "IntegrationSettings", targetUid: "integrations" }));
            expect(entry.details).toEqual({ section: "giphy", keys: ["apiKey", "enabled"], secretChanged: true });
        });

        it("keeps a secret sent back as the mask, and changes and audits nothing for a request that changes nothing", async () => {
            await ok(put("giphy", { enabled: false, apiKey: GIPHY_KEY }));
            const before = await ctx.row();
            const body = await ok(put("giphy", { enabled: false, apiKey: MASK }));
            expect(body.giphy.values).toEqual({ enabled: false, apiKey: MASK });
            const after = await ctx.row();
            expect(after.version).toBe(before.version);
            expect(after.giphy.apiKey).toEqual(before.giphy.apiKey);
            expect(open("giphy.apiKey", after.giphy.apiKey)).toBe(GIPHY_KEY);
            expect(await audits()).toHaveLength(1);
            expect((await ok(put("giphy", {}))).version).toBe(before.version);
        });

        it("replaces a secret with a new value, and clears it with null, back to the deployment's", async () => {
            await ok(put("giphy", { apiKey: GIPHY_KEY }));
            const first = (await ctx.row()).giphy.apiKey;
            await ok(put("giphy", { apiKey: "second-key" }));
            const second = (await ctx.row()).giphy.apiKey;
            expect(second).not.toEqual(first);
            expect(open("giphy.apiKey", second)).toBe("second-key");

            const body = await ok(put("giphy", { apiKey: null }));
            expect(body.giphy.source.apiKey).toBe("deployment");
            expect(body.giphy.values.apiKey).toBeNull();
            expect((await ctx.row()).giphy ?? null).toBeNull();
            expect((await audits()).map((entry) => entry.details)).toEqual([
                { section: "giphy", keys: ["apiKey"], secretChanged: true },
                { section: "giphy", keys: ["apiKey"], secretChanged: true },
                { section: "giphy", keys: ["apiKey"], secretChanged: true },
            ]);
            expect(await persisted()).not.toMatch(/giphy-KEY|second-key/);
        });

        it("refuses to save a secret without a keyring (503), and saves nothing else of the request", async () => {
            withoutKeyring();
            const result = await put("giphy", { enabled: false, apiKey: GIPHY_KEY });
            expect(result.status).toBe(503);
            expect(JSON.stringify(result.body)).not.toContain(GIPHY_KEY);
            expect(await ctx.row()).toBeFalsy();
            expect(await audits()).toEqual([]);
            // What needs no keyring still saves.
            expect((await ok(put("giphy", { enabled: false }))).giphy.values.enabled).toBe(false);
        });

        it("clears a secret without needing a keyring", async () => {
            await ok(put("giphy", { apiKey: GIPHY_KEY }));
            withoutKeyring();
            expect((await ok(put("giphy", { apiKey: null }))).giphy.source.apiKey).toBe("deployment");
            expect((await ctx.row()).giphy ?? null).toBeNull();
        });

        it.each([
            ["an unknown section", "turn", { urls: [] }, 404],
            ["a body that isn't an object", "giphy", ["x"], 400],
            ["a dotted key", "giphy", { "giphy.enabled": true }, 400],
            ["an unknown field", "giphy", { enabled: true, apiKeyRef: { backend: "openbao", path: "dns/x", keys: ["apiKey"], generation: 9 } }, 400],
            ["an envelope sent as a value", "giphy", { apiKey: { $enc: 1, kid: "k", iv: "aXY=", ct: "Y3Q=", tag: "dGFn" } }, 400],
            ["a version that isn't a number", "giphy", { enabled: true, version: "x" }, 400],
            ["a switch that isn't one", "giphy", { enabled: "yes" }, 400],
            ["an empty secret", "giphy", { apiKey: "  " }, 400],
            ["a secret with a line break inside", "giphy", { apiKey: "a\nb" }, 400],
            ["a TURN URI among the STUN servers", "stun", { urls: ["turn:turn.example.com"] }, 400],
            // The meet plugin takes an empty list as its built-in one; a reset is the way back to it.
            ["an empty list of STUN servers", "stun", { urls: [] }, 400],
            ["an unknown signing backend", "signingCa", { backend: "acme" }, 400],
            ["a plain-http ACME directory", "signingCa", { directoryUrl: "http://acme.example.com/directory" }, 400],
            ["a contact that isn't an address", "signingCa", { contactEmail: "pki" }, 400],
            ["an unknown resolver", "dnsResolver", { mode: "doh" }, 400],
            ["a DoH endpoint on a private address", "dnsResolver", { dohEndpoint: "https://192.168.1.1/dns-query" }, 400],
            ["a registry that resolves inside the network", "pluginRegistry", { url: "https://registry.internal.example.com/" }, 400],
            ["a registry URL carrying a password", "pluginRegistry", { url: "https://user:pw@registry.example.com/" }, 400],
            ["a namespace that isn't a scope", "pluginRegistry", { namespaces: ["@Not Valid"] }, 400],
        ])("refuses %s, and saves nothing", async (_label, section, body, status) => {
            const result = await put(section, body);
            expect(result.status, JSON.stringify(result.body)).toBe(status);
            expect(await ctx.row()).toBeFalsy();
        });

        it("names the allowed fields for an unknown one, never repeating what was sent", async () => {
            const result = await put("giphy", { [GIPHY_KEY]: true });
            expect(result.status).toBe(400);
            expect(result.body.message).toContain("enabled, apiKey");
            expect(result.body.message).not.toContain(GIPHY_KEY);
        });

        it("saves the STUN servers, the signing CA and the DNS resolver, each field marked as the administrator's", async () => {
            const stun = await ok(put("stun", { urls: ["STUN:stun.example.com:3478", "stuns:stun.example.com"] }));
            expect(stun.stun).toEqual({ values: { urls: ["stun:stun.example.com:3478", "stuns:stun.example.com"] }, defaults: { urls: null }, source: { urls: "admin" } });

            const ca = await ok(put("signingCa", { backend: "rfc8823", directoryUrl: "https://acme.example.com/directory", contactEmail: "pki@example.com" }));
            expect(ca.signingCa.values).toEqual({ backend: "rfc8823", directoryUrl: "https://acme.example.com/directory", contactEmail: "pki@example.com" });
            expect(ca.signingCa.source).toEqual({ backend: "admin", directoryUrl: "admin", contactEmail: "admin" });

            const dns = await ok(put("dnsResolver", { mode: "doh-dnssec" }));
            expect(dns.dnsResolver.values).toEqual({ mode: "doh-dnssec", dohEndpoint: DEFAULT_DOH_ENDPOINT });
            expect(dns.dnsResolver.source).toEqual({ mode: "admin", dohEndpoint: "deployment" });
            // Earlier sections are untouched by a later one's change.
            expect(dns.stun.values.urls).toEqual(["stun:stun.example.com:3478", "stuns:stun.example.com"]);

            const row = await ctx.row();
            expect(row.stun).toEqual({ urls: ["stun:stun.example.com:3478", "stuns:stun.example.com"] });
            expect(row.dnsResolver).toEqual({ mode: "doh-dnssec" });
            expect((await audits()).map((entry) => entry.details)).toEqual([
                { section: "stun", keys: ["urls"], secretChanged: false },
                { section: "signingCa", keys: ["backend", "contactEmail", "directoryUrl"], secretChanged: false },
                { section: "dnsResolver", keys: ["mode"], secretChanged: false },
            ]);
        });

        it("resets a plain field sent as null to the deployment's value", async () => {
            await ok(put("signingCa", { backend: "none", contactEmail: "pki@example.com" }));
            const body = await ok(put("signingCa", { backend: null }));
            expect(body.signingCa.source).toEqual({ backend: "deployment", directoryUrl: "deployment", contactEmail: "admin" });
            expect((await ctx.row()).signingCa).toEqual({ contactEmail: "pki@example.com" });
            // Clearing what was never set changes nothing.
            const audited = (await audits()).length;
            await ok(put("signingCa", { directoryUrl: null }));
            expect(await audits()).toHaveLength(audited);
        });

        it("keeps the registry token and each namespace's token encrypted on the row, bound to their fields, shown only as masks", async () => {
            const body = await ok(
                put("pluginRegistry", {
                    url: "https://registry.example.com",
                    token: REGISTRY_TOKEN,
                    namespaces: ["rapidmx", { name: "@acme", registry: "https://npm.acme.example.com/", token: NAMESPACE_TOKEN }],
                }),
            );
            expect(body.pluginRegistry.values).toEqual({
                url: "https://registry.example.com",
                token: MASK,
                namespaces: [{ name: "@rapidmx" }, { name: "@acme", registry: "https://npm.acme.example.com/", token: MASK }],
            });
            const registry = (await ctx.row()).pluginRegistry;
            expect(registry.url).toBe("https://registry.example.com");
            expect(isConfigEnvelope(registry.token)).toBe(true);
            expect(open("pluginRegistry.token", registry.token)).toBe(REGISTRY_TOKEN);
            // The token is inside its namespace, and the namespace without one has none.
            expect(registry.namespaces).toEqual([{ name: "@rapidmx" }, { name: "@acme", registry: "https://npm.acme.example.com/", token: expect.objectContaining({ $enc: 1 }) }]);
            expect(open("pluginRegistry.namespaces.@acme.token", registry.namespaces[1].token)).toBe(NAMESPACE_TOKEN);
            // A token copied to another namespace, or taken for the registry's own, doesn't decrypt.
            expect(() => open("pluginRegistry.namespaces.@rapidmx.token", registry.namespaces[1].token)).toThrow();
            expect(() => open("pluginRegistry.token", registry.namespaces[1].token)).toThrow();
            expect(await persisted()).not.toMatch(new RegExp(`${REGISTRY_TOKEN}|${NAMESPACE_TOKEN}`));
            expect((await audits())[0].details).toEqual({ section: "pluginRegistry", keys: ["namespaces", "token", "url"], secretChanged: true });
        });

        it("keeps a namespace's token sent back as the mask, and drops the token of a namespace taken off the list", async () => {
            await ok(put("pluginRegistry", { namespaces: [{ name: "@acme", token: NAMESPACE_TOKEN }, { name: "@other", token: "other-token" }] }));
            const acme = (await ctx.row()).pluginRegistry.namespaces[0].token;
            const body = await ok(put("pluginRegistry", { namespaces: [{ name: "@acme", token: MASK }, "@public"] }));
            expect(body.pluginRegistry.values.namespaces).toEqual([{ name: "@acme", token: MASK }, { name: "@public" }]);
            const namespaces = (await ctx.row()).pluginRegistry.namespaces;
            expect(namespaces).toEqual([{ name: "@acme", token: acme }, { name: "@public" }]);
            expect(open("pluginRegistry.namespaces.@acme.token", namespaces[0].token)).toBe(NAMESPACE_TOKEN);
            expect(await persisted()).not.toContain("other-token");

            // The mask on a namespace that has no saved token keeps nothing.
            const again = await ok(put("pluginRegistry", { namespaces: [{ name: "@public", token: MASK }] }));
            expect(again.pluginRegistry.values.namespaces).toEqual([{ name: "@public" }]);
            expect((await ctx.row()).pluginRegistry.namespaces).toEqual([{ name: "@public" }]);
            expect((await audits()).at(-1)!.details).toEqual({ section: "pluginRegistry", keys: ["namespaces"], secretChanged: true });
        });

        it("replaces a namespace's token with a new one, and drops it when the namespace is sent without one", async () => {
            await ok(put("pluginRegistry", { namespaces: [{ name: "@acme", token: NAMESPACE_TOKEN }] }));
            await ok(put("pluginRegistry", { namespaces: [{ name: "@acme", token: "second-token" }] }));
            expect(open("pluginRegistry.namespaces.@acme.token", (await ctx.row()).pluginRegistry.namespaces[0].token)).toBe("second-token");
            await ok(put("pluginRegistry", { namespaces: [{ name: "@acme", token: null }] }));
            expect((await ctx.row()).pluginRegistry.namespaces).toEqual([{ name: "@acme" }]);
            expect((await audits()).at(-1)!.details).toEqual({ section: "pluginRegistry", keys: ["namespaces"], secretChanged: true });
            expect(await persisted()).not.toMatch(/second-token|never_stored/);
        });

        it("saves namespaces without tokens without a keyring, and resets them with null", async () => {
            const encrypt = withoutKeyring();
            const body = await ok(put("pluginRegistry", { namespaces: ["@public", { name: "@acme", registry: null, token: null }] }));
            expect(body.pluginRegistry.values.namespaces).toEqual([{ name: "@public" }, { name: "@acme" }]);
            expect(encrypt).not.toHaveBeenCalled();
            expect((await audits())[0].details).toEqual({ section: "pluginRegistry", keys: ["namespaces"], secretChanged: false });

            const cleared = await ok(put("pluginRegistry", { namespaces: null }));
            expect(cleared.pluginRegistry.source.namespaces).toBe("deployment");
            expect(cleared.pluginRegistry.values.namespaces).toEqual([{ name: "@rapidmx" }]);
            // Nothing left to reset changes nothing.
            await ok(put("pluginRegistry", { namespaces: null }));
            expect(await audits()).toHaveLength(2);
        });

        it("refuses a change made against an older version (409), before anything is encrypted", async () => {
            const first = await ok(put("giphy", { enabled: false }));
            await ok(put("stun", { urls: ["stun:stun.example.com"] }));
            const encrypt = vi.spyOn(ctx.cipher(), "encrypt");
            const result = await put("giphy", { apiKey: GIPHY_KEY, version: first.version });
            expect(result.status).toBe(409);
            expect(result.body.code).toBe(ApiErrors.INVALID_OBJECT_VERSION);
            expect(encrypt).not.toHaveBeenCalled();
            expect((await ctx.row()).giphy.apiKey).toBeUndefined();
            expect((await ok(put("giphy", { apiKey: GIPHY_KEY, version: first.version + 1 }))).giphy.values.apiKey).toEqual(MASK);
            // No row yet is version 0.
            await ctx.clear();
            expect((await put("giphy", { enabled: true, version: 3 })).status).toBe(409);
            expect((await ok(put("giphy", { enabled: true, version: 0 }))).giphy.values.enabled).toBe(true);
        });

        it("checks the version after validating the request, so a change landing during the URL check is refused (409) before anything is encrypted", async () => {
            const first = await ok(put("giphy", { enabled: false }));
            setDiscoveryAddressLookup(async () => {
                setDiscoveryAddressLookup(async () => ["93.184.216.34"]);
                await ok(put("stun", { urls: ["stun:stun.example.com"] }));
                return ["93.184.216.34"];
            });
            const encrypt = vi.spyOn(ctx.cipher(), "encrypt");
            const result = await put("pluginRegistry", { url: "https://registry.example.com", token: REGISTRY_TOKEN, version: first.version });
            expect(result.status).toBe(409);
            expect(encrypt).not.toHaveBeenCalled();
            expect((await ctx.row()).pluginRegistry ?? null).toBeNull();
        });
    });

    describe("POST /:section/reset", () => {
        it("deletes every administrator value of a section, its secrets with it, and audits the keys", async () => {
            await ok(put("pluginRegistry", { url: "https://registry.example.com", token: REGISTRY_TOKEN, namespaces: [{ name: "@acme", token: NAMESPACE_TOKEN }] }));
            await ok(put("giphy", { enabled: false }));
            const body = await ok(reset("pluginRegistry"));
            expect(body.pluginRegistry.source).toEqual({ url: "deployment", token: "deployment", namespaces: "deployment" });
            expect(body.giphy.source.enabled).toBe("admin");
            expect((await ctx.row()).pluginRegistry ?? null).toBeNull();
            expect(await persisted()).not.toMatch(new RegExp(`${REGISTRY_TOKEN}|${NAMESPACE_TOKEN}`));
            const entry = (await audits()).at(-1)!;
            expect(entry.action).toBe(AuditAction.INTEGRATION_RESET);
            expect(entry.details).toEqual({ section: "pluginRegistry", keys: ["namespaces", "token", "url"] });
        });

        it("resets only the keys asked for", async () => {
            await ok(put("giphy", { enabled: false, apiKey: GIPHY_KEY }));
            const body = await ok(reset("giphy", { keys: ["enabled"] }));
            expect(body.giphy.source).toEqual({ enabled: "deployment", apiKey: "admin" });
            expect(open("giphy.apiKey", (await ctx.row()).giphy.apiKey)).toBe(GIPHY_KEY);
            expect((await audits()).at(-1)!.details).toEqual({ section: "giphy", keys: ["enabled"] });

            const secret = await ok(reset("giphy", { keys: ["apiKey"] }));
            expect(secret.giphy.source).toEqual({ enabled: "deployment", apiKey: "deployment" });
            expect((await ctx.row()).giphy ?? null).toBeNull();
        });

        it("changes and audits nothing when nothing of the section was set", async () => {
            await ok(reset("stun"));
            await ok(put("stun", { urls: ["stun:stun.example.com"] }));
            const audited = (await audits()).length;
            await ok(reset("giphy", { keys: ["apiKey"] }));
            expect(await audits()).toHaveLength(audited);
        });

        it.each([
            ["an unknown section", "turn", {}, 404],
            ["an unknown key", "giphy", { keys: ["apiKeyRef"] }, 400],
            ["keys that aren't a list", "giphy", { keys: "enabled" }, 400],
            ["a body that isn't an object", "giphy", ["enabled"], 400],
        ])("refuses %s", async (_label, section, body, status) => {
            expect((await reset(section, body)).status).toBe(status);
        });

        it("refuses a reset made against an older version (409)", async () => {
            const first = await ok(put("giphy", { enabled: false }));
            await ok(put("giphy", { enabled: true }));
            expect((await reset("giphy", { version: first.version })).status).toBe(409);
            expect((await ctx.row()).giphy.enabled).toBe(true);
        });
    });
}
