///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The Plugin route's HTTP behaviour, identical on both backends - `test/routes/{mongo,sql}/PluginRoute.test.ts`
// each supply a started server and a way to read audit log rows.
import { request } from "@rapidrest/service-core/test";
import { JWTUtils } from "@rapidrest/core";
import * as uuid from "uuid";
import { AuditAction } from "../../src/models/types.js";
import { BasePluginRoute } from "../../src/routes/BasePluginRoute.js";
import { computePluginStateHash, PLUGIN_API_VERSION } from "../../src/plugins/PluginUtils.js";
import { RegistryRequestError } from "../../src/plugins/NpmRegistryClient.js";
import {
    brokenPackages,
    extraSearchResults,
    failingSearchNamespaces,
    instanceStatuses,
    publishedHashes,
    publishFakePackage,
    registryClientRequests,
    registryHooks,
    registryReads,
    resetPluginTestDoubles,
} from "./pluginTestDoubles.js";

export interface PluginRouteSuiteContext {
    config: any;
    app: () => any;
    baseUrl: string;
    clear: () => Promise<void>;
    auditActions: () => Promise<string[]>;
    /** Saves a plugin row straight to the database, as another request or an older configuration would have. */
    insertPlugin: (fields: Record<string, unknown>) => Promise<void>;
    /** Every plugin row, removed ones included. */
    rows: () => Promise<any[]>;
    /** Bumps a row's optimistic-lock version directly, as a concurrent edit would. */
    bumpVersion: (uid: string) => Promise<void>;
    /** Changes a row's fields directly, as a concurrent request would. */
    updatePlugin: (uid: string, fields: Record<string, unknown>) => Promise<void>;
}

const EAS_MANIFEST = {
    apiVersion: PLUGIN_API_VERSION,
    displayName: "Exchange ActiveSync",
    description: "Mobile sync",
    settings: [
        { key: "mail:eas:sync_window_size", label: "Sync window size", type: "number", default: 100, min: 1, max: 512 },
        { key: "mail:eas:mode", label: "Mode", type: "select", options: [{ value: "a", label: "A" }] },
    ],
};

export function pluginRouteSuite(ctx: PluginRouteSuiteContext): void {
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const user: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    let adminToken: string;
    let userToken: string;

    beforeAll(() => {
        adminToken = JWTUtils.createTokenSync(ctx.config.get("auth"), admin);
        userToken = JWTUtils.createTokenSync(ctx.config.get("auth"), user);
    });

    beforeEach(async () => {
        await ctx.clear();
        resetPluginTestDoubles();
        publishFakePackage("@rapidmx/activesync", "1.0.0", { plugin: EAS_MANIFEST });
        publishFakePackage("@rapidmx/activesync", "1.1.0", {
            plugin: { ...EAS_MANIFEST, settings: [EAS_MANIFEST.settings[0]] },
        });
    });

    const asAdmin = (req: any) => req.set("Authorization", "jwt " + adminToken);

    async function addEasLike(name: string): Promise<any> {
        publishFakePackage(name, "1.0.0", { plugin: EAS_MANIFEST });
        const result = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({ name });
        expect(result.status).toBe(200);
        return result.body.plugin;
    }

    async function addEas(packageVersion?: string): Promise<any> {
        const result = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({ name: "@rapidmx/activesync", packageVersion });
        expect(result.status).toBe(200);
        expect(result.body.dependencies).toEqual([]);
        return result.body.plugin;
    }

    describe("access", () => {
        it("refuses every endpoint to a non-trusted user", async () => {
            const app = ctx.app();
            const auth = (req: any) => req.set("Authorization", "jwt " + userToken);
            expect((await auth(request(app).get(ctx.baseUrl))).status).toBe(403);
            expect((await auth(request(app).get(`${ctx.baseUrl}/status`))).status).toBe(403);
            expect((await auth(request(app).get(`${ctx.baseUrl}/plan?name=%40rapidmx%2Factivesync`))).status).toBe(403);
            expect((await auth(request(app).get(`${ctx.baseUrl}/registry/%40rapidmx%2Factivesync`))).status).toBe(403);
            expect((await auth(request(app).post(ctx.baseUrl)).send({ name: "@rapidmx/activesync" })).status).toBe(403);
            expect((await auth(request(app).put(`${ctx.baseUrl}/x`)).send({ enabled: false })).status).toBe(403);
            expect((await auth(request(app).delete(`${ctx.baseUrl}/x`))).status).toBe(403);
        });
    });

    describe("GET /namespaces and GET /search", () => {
        beforeEach(() => {
            publishFakePackage("@rapidmx/mapi-plugin", "1.0.0", { plugin: EAS_MANIFEST }, { description: "MAPI" });
            publishFakePackage("@rapidmx/mapi-plugin", "1.2.0", { plugin: EAS_MANIFEST }, { description: "MAPI" });
            publishFakePackage("@acme/crm-plugin", "0.1.0", { plugin: EAS_MANIFEST });
            publishFakePackage("@other/thing-plugin", "3.0.0", { plugin: EAS_MANIFEST });
        });

        it("lists the configured namespaces without their tokens", async () => {
            const result = await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/namespaces`));
            expect(result.status).toBe(200);
            expect(result.body).toEqual([{ name: "@rapidmx" }, { name: "@acme", registry: "https://npm.acme.test" }]);
        });

        it("searches every configured namespace, showing each plugin's latest version and install state", async () => {
            publishFakePackage("@rapidmx/activesync-plugin", "1.0.0", { plugin: EAS_MANIFEST });
            publishFakePackage("@rapidmx/activesync-plugin", "2.0.0", { plugin: EAS_MANIFEST });
            const installed = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({ name: "@rapidmx/activesync-plugin", packageVersion: "1.0.0" });
            expect(installed.status).toBe(200);

            const result = await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/search`));
            expect(result.status).toBe(200);
            expect(result.body).toEqual([
                { name: "@acme/crm-plugin", version: "0.1.0", allowed: true, updateAvailable: false },
                {
                    name: "@rapidmx/activesync-plugin",
                    version: "2.0.0",
                    allowed: true,
                    installedUid: installed.body.plugin.uid,
                    installedVersion: "1.0.0",
                    updateAvailable: true,
                },
                { name: "@rapidmx/mapi-plugin", version: "1.2.0", description: "MAPI", allowed: true, updateAvailable: false },
            ]);
            expect(registryClientRequests).toEqual(expect.arrayContaining(["@rapidmx", "@acme"]));
        });

        it("searches one namespace, including an unconfigured one whose packages aren't allowed", async () => {
            const result = await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/search?namespace=other`));
            expect(result.status).toBe(200);
            expect(result.body).toEqual([{ name: "@other/thing-plugin", version: "3.0.0", allowed: false, updateAvailable: false }]);
        });

        it("leaves out a registry result without a version rather than failing", async () => {
            extraSearchResults.push({ name: "@rapidmx/unversioned-plugin" }, { name: "@rapidmx/numbered-plugin", version: 3 });
            const result = await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/search?namespace=rapidmx`));
            expect(result.status).toBe(200);
            expect(result.body.map((r: any) => r.name)).toEqual(["@rapidmx/mapi-plugin"]);
        });

        it("never reports an update for an installed plugin outside the allow-list", async () => {
            await ctx.insertPlugin({ name: "@other/thing-plugin", packageVersion: "1.0.0", enabled: false, removed: false, settings: {}, manifest: EAS_MANIFEST });
            const result = await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/search?namespace=other`));
            expect(result.status).toBe(200);
            expect(result.body).toEqual([
                { name: "@other/thing-plugin", version: "3.0.0", allowed: false, installedUid: expect.any(String), installedVersion: "1.0.0", updateAvailable: false },
            ]);
        });

        it("rejects an invalid namespace and reports a registry failure", async () => {
            expect((await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/search?namespace=Not%20A%20Scope`))).status).toBe(400);
            expect((await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/search?namespace=rapidmx&namespace=acme`))).status).toBe(400);
            failingSearchNamespaces.add("@acme");
            const failed = await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/search`));
            expect(failed.status).toBe(502);
        });

        it("allows adding a package from a configured namespace even when allowed_packages doesn't list it", async () => {
            const result = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({ name: "@acme/crm-plugin" });
            expect(result.status).toBe(200);
            expect(registryClientRequests).toContain("@acme/crm-plugin");
        });
    });

    describe("GET /updates", () => {
        it("reports each installed plugin's latest version and whether it's newer", async () => {
            const current = await addEas("1.1.0");
            publishFakePackage("@rapidmx/old-plugin", "1.0.0", { plugin: EAS_MANIFEST });
            const old = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({ name: "@rapidmx/old-plugin" });
            publishFakePackage("@rapidmx/old-plugin", "1.0.1", { plugin: EAS_MANIFEST });
            publishFakePackage("@rapidmx/flaky-plugin", "1.0.0", { plugin: EAS_MANIFEST });
            const flaky = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({ name: "@rapidmx/flaky-plugin" });

            const removed = await addEasLike("@rapidmx/gone-plugin");
            await asAdmin(request(ctx.app()).delete(`${ctx.baseUrl}/${removed.uid}`));

            brokenPackages.add("@rapidmx/flaky-plugin");
            const result = await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/updates`));
            expect(result.status).toBe(200);
            expect(result.body).toEqual([
                { uid: current.uid, name: "@rapidmx/activesync", installedVersion: "1.1.0", latestVersion: "1.1.0", updateAvailable: false, allowed: true },
                {
                    uid: flaky.body.plugin.uid,
                    name: "@rapidmx/flaky-plugin",
                    installedVersion: "1.0.0",
                    updateAvailable: false,
                    allowed: true,
                    error: "registry offline",
                },
                { uid: old.body.plugin.uid, name: "@rapidmx/old-plugin", installedVersion: "1.0.0", latestVersion: "1.0.1", updateAvailable: true, allowed: true },
            ]);
        });

        it("never offers an upgrade for, or re-enables or re-versions, a plugin outside the allow-list", async () => {
            publishFakePackage("left-pad", "1.0.0", { plugin: EAS_MANIFEST });
            publishFakePackage("left-pad", "2.0.0", { plugin: EAS_MANIFEST });
            await ctx.insertPlugin({ name: "left-pad", packageVersion: "1.0.0", enabled: false, removed: false, settings: {}, manifest: EAS_MANIFEST });
            const [row] = await ctx.rows();

            const updates = await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/updates`));
            expect(updates.body).toEqual([
                { uid: row.uid, name: "left-pad", installedVersion: "1.0.0", latestVersion: "2.0.0", updateAvailable: false, allowed: false },
            ]);

            const enable = await asAdmin(request(ctx.app()).put(`${ctx.baseUrl}/${row.uid}`)).send({ enabled: true });
            expect(enable.status).toBe(400);
            expect(enable.body.message).toMatch(/'left-pad' is not an allowed plugin package/);
            expect((await asAdmin(request(ctx.app()).put(`${ctx.baseUrl}/${row.uid}`)).send({ packageVersion: "2.0.0" })).status).toBe(400);
            // Settings, and keeping it disabled, still work.
            expect((await asAdmin(request(ctx.app()).put(`${ctx.baseUrl}/${row.uid}`)).send({ enabled: false })).status).toBe(200);
            expect((await ctx.rows())[0].enabled).toBe(false);
        });
    });

    describe("GET /registry/:name", () => {
        it("returns the package's versions and the latest version's manifest", async () => {
            const result = await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/registry/%40rapidmx%2Factivesync`));
            expect(result.status).toBe(200);
            expect(result.body.package).toEqual({ name: "@rapidmx/activesync", latest: "1.1.0", versions: ["1.1.0", "1.0.0"] });
            expect(result.body.selected.version).toBe("1.1.0");
            expect(result.body.selected.manifest.displayName).toBe("Exchange ActiveSync");
        });

        it("returns a requested version", async () => {
            const result = await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/registry/%40rapidmx%2Factivesync?packageVersion=1.0.0`));
            expect(result.status).toBe(200);
            expect(result.body.selected.manifest.settings).toHaveLength(2);
        });

        it("rejects a package outside the allow-list before asking the registry", async () => {
            const result = await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/registry/left-pad`));
            expect(result.status).toBe(400);
            expect(result.body.message).toMatch(/not an allowed plugin package/);
        });

        it("returns 404 for an unknown package or version", async () => {
            expect((await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/registry/%40rapidmx%2Fnope`))).status).toBe(404);
            const missing = await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/registry/%40rapidmx%2Factivesync?packageVersion=9.9.9`));
            expect(missing.status).toBe(404);
            expect(missing.body.message).toMatch(/9\.9\.9/);
        });

        it("reads the package from the registry once, and reports a registry failure as 502", async () => {
            expect((await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/registry/%40rapidmx%2Factivesync`))).status).toBe(200);
            expect(registryReads).toEqual(["package:@rapidmx/activesync", "version:@rapidmx/activesync@latest"]);
            brokenPackages.add("@rapidmx/activesync");
            expect((await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/registry/%40rapidmx%2Factivesync`))).status).toBe(502);
        });

        it("rejects a name that isn't a valid npm package name before asking the registry", async () => {
            for (const name of ["@rapidmx/activesync?x", "@rapidmx/a#b", "@rapidmx/a\tb", "@rapidmx/A"]) {
                const result = await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/registry/${encodeURIComponent(name)}`));
                expect(result.status).toBe(400);
                expect(result.body.message).toMatch(/is not a valid npm package name/);
            }
            expect(registryReads).toEqual([]);
        });
    });

    describe("POST /", () => {
        it("adds the latest version with its manifest, default settings and integrity, and announces the change", async () => {
            const created = await addEas();
            expect(created).toEqual(
                expect.objectContaining({
                    name: "@rapidmx/activesync",
                    packageVersion: "1.1.0",
                    integrity: "sha512-@rapidmx/activesync@1.1.0",
                    enabled: true,
                    settings: { "mail:eas:sync_window_size": 100 },
                }),
            );
            expect(created.manifest.displayName).toBe("Exchange ActiveSync");
            expect(publishedHashes).toEqual([computePluginStateHash([created])]);
            expect(await ctx.auditActions()).toEqual([AuditAction.PLUGIN_INSTALL]);

            const list = await asAdmin(request(ctx.app()).get(ctx.baseUrl));
            expect(list.body.map((p: any) => p.name)).toEqual(["@rapidmx/activesync"]);
        });

        it("lists installed plugins by name", async () => {
            publishFakePackage("@rapidmx/autodiscover", "1.0.0", { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "Autodiscover" } });
            await addEas();
            await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({ name: "@rapidmx/autodiscover" });
            const list = await asAdmin(request(ctx.app()).get(ctx.baseUrl));
            expect(list.body.map((p: any) => p.name)).toEqual(["@rapidmx/activesync", "@rapidmx/autodiscover"]);
        });

        it("adds a specific version", async () => {
            expect((await addEas("1.0.0")).packageVersion).toBe("1.0.0");
        });

        it("requires a name", async () => {
            const result = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({});
            expect(result.status).toBe(400);
        });

        it("rejects packages outside the allow-list", async () => {
            publishFakePackage("evil", "1.0.0", { plugin: EAS_MANIFEST });
            const result = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({ name: "evil" });
            expect(result.status).toBe(400);
            expect(publishedHashes).toEqual([]);
        });

        it("rejects a name that isn't a valid npm package name, even inside an allowed scope", async () => {
            for (const name of ["@rapidmx/activesync-plugin?x", "@rapidmx/activesync-plugin#x", "@rapidmx/active\nsync-plugin"]) {
                const result = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({ name });
                expect(result.status).toBe(400);
                expect(result.body.message).toMatch(/not a valid npm package name/);
            }
            expect((await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/plan?name=${encodeURIComponent("@rapidmx/x?y")}`))).status).toBe(400);
            expect(await ctx.rows()).toEqual([]);
        });

        it("returns 404 for a package the registry doesn't have", async () => {
            const result = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({ name: "@rapidmx/nope-plugin" });
            expect(result.status).toBe(404);
            expect(result.body.message).toBe("'@rapidmx/nope-plugin' was not found in the plugin registry.");
        });

        it("rejects a dist-tag that doesn't resolve to a published version number", async () => {
            publishFakePackage("@rapidmx/tagged-plugin", "github:evil/repo", { plugin: EAS_MANIFEST });
            const result = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({ name: "@rapidmx/tagged-plugin" });
            expect(result.status).toBe(400);
            expect(result.body.message).toBe("'@rapidmx/tagged-plugin@latest' resolves to 'github:evil/repo', which isn't a published version.");
        });

        it("rejects a package that isn't a plugin, or targets another plugin API version", async () => {
            publishFakePackage("@rapidmx/not-a-plugin", "1.0.0");
            publishFakePackage("@rapidmx/future", "1.0.0", { plugin: { ...EAS_MANIFEST, apiVersion: PLUGIN_API_VERSION + 1 } });
            const notPlugin = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({ name: "@rapidmx/not-a-plugin" });
            expect(notPlugin.status).toBe(400);
            expect(notPlugin.body.message).toMatch(/not a RapidMX plugin/);
            const future = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({ name: "@rapidmx/future" });
            expect(future.status).toBe(400);
            expect(future.body.message).toMatch(/plugin API version/);
        });

        it("returns 409 when the package is already installed", async () => {
            await addEas();
            const result = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({ name: "@rapidmx/activesync" });
            expect(result.status).toBe(409);
        });

        it("returns 502 when the registry can't be reached", async () => {
            publishFakePackage("@rapidmx/flaky", "1.0.0", { plugin: EAS_MANIFEST }, { fail: new RegistryRequestError("Could not reach the plugin registry: down") });
            const result = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({ name: "@rapidmx/flaky" });
            expect(result.status).toBe(502);
            expect(result.body.message).toMatch(/down/);
        });

        it("returns 500 for an unexpected registry client failure", async () => {
            publishFakePackage("@rapidmx/broken", "1.0.0", { plugin: EAS_MANIFEST }, { fail: new Error("boom") });
            const result = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({ name: "@rapidmx/broken" });
            expect(result.status).toBe(500);
        });
    });

    describe("PUT /:id", () => {
        it("disables a plugin and announces the new state", async () => {
            const created = await addEas();
            const result = await asAdmin(request(ctx.app()).put(`${ctx.baseUrl}/${created.uid}`)).send({ enabled: false });
            expect(result.status).toBe(200);
            expect(result.body.enabled).toBe(false);
            expect(publishedHashes[publishedHashes.length - 1]).toBe(computePluginStateHash([]));
            expect(await ctx.auditActions()).toEqual(expect.arrayContaining([AuditAction.PLUGIN_INSTALL, AuditAction.PLUGIN_UPDATE]));
        });

        it("saves valid settings and rejects invalid ones", async () => {
            const created = await addEas("1.0.0");
            const saved = await asAdmin(request(ctx.app()).put(`${ctx.baseUrl}/${created.uid}`)).send({
                settings: { "mail:eas:sync_window_size": 50, "mail:eas:mode": "a" },
            });
            expect(saved.status).toBe(200);
            expect(saved.body.settings).toEqual({ "mail:eas:sync_window_size": 50, "mail:eas:mode": "a" });

            const tooBig = await asAdmin(request(ctx.app()).put(`${ctx.baseUrl}/${created.uid}`)).send({
                settings: { "mail:eas:sync_window_size": 1000 },
            });
            expect(tooBig.status).toBe(400);
            expect(tooBig.body.message).toMatch(/at most 512/);
        });

        it("rejects a non-boolean enabled", async () => {
            const created = await addEas();
            const result = await asAdmin(request(ctx.app()).put(`${ctx.baseUrl}/${created.uid}`)).send({ enabled: "no" });
            expect(result.status).toBe(400);
        });

        it("changes version, re-snapshots the manifest and drops settings the new version no longer has", async () => {
            const created = await addEas("1.0.0");
            await asAdmin(request(ctx.app()).put(`${ctx.baseUrl}/${created.uid}`)).send({
                settings: { "mail:eas:sync_window_size": 50, "mail:eas:mode": "a" },
            });
            const result = await asAdmin(request(ctx.app()).put(`${ctx.baseUrl}/${created.uid}`)).send({ packageVersion: "1.1.0" });
            expect(result.status).toBe(200);
            expect(result.body.packageVersion).toBe("1.1.0");
            expect(result.body.integrity).toBe("sha512-@rapidmx/activesync@1.1.0");
            expect(result.body.manifest.settings).toHaveLength(1);
            expect(result.body.settings).toEqual({ "mail:eas:sync_window_size": 50 });
        });

        it("clears the recorded integrity when the new version has none", async () => {
            publishFakePackage("@rapidmx/activesync", "1.2.0", { plugin: EAS_MANIFEST }, { dist: {} });
            const created = await addEas("1.0.0");
            const result = await asAdmin(request(ctx.app()).put(`${ctx.baseUrl}/${created.uid}`)).send({ packageVersion: "1.2.0" });
            expect(result.status).toBe(200);
            expect(result.body.integrity ?? undefined).toBeUndefined();
        });

        it("returns 404 for an unknown plugin or version", async () => {
            expect((await asAdmin(request(ctx.app()).put(`${ctx.baseUrl}/${uuid.v4()}`)).send({ enabled: false })).status).toBe(404);
            const created = await addEas();
            expect((await asAdmin(request(ctx.app()).put(`${ctx.baseUrl}/${created.uid}`)).send({ packageVersion: "9.9.9" })).status).toBe(404);
        });

        it("rejects an empty or non-string version rather than moving to latest", async () => {
            const created = await addEas("1.0.0");
            for (const packageVersion of ["", " ", null, 1]) {
                const result = await asAdmin(request(ctx.app()).put(`${ctx.baseUrl}/${created.uid}`)).send({ packageVersion });
                expect(result.status).toBe(400);
                expect(result.body.message).toBe("'packageVersion' must be a version.");
            }
            expect((await ctx.rows())[0].packageVersion).toBe("1.0.0");
        });

        it("refuses a version that isn't normalized, such as one with a leading v", async () => {
            publishFakePackage("@rapidmx/prefixed-plugin", "v1.0.0", { plugin: EAS_MANIFEST });
            const result = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({ name: "@rapidmx/prefixed-plugin" });
            expect(result.status).toBe(400);
            expect(result.body.message).toBe("'@rapidmx/prefixed-plugin@latest' resolves to 'v1.0.0', which isn't a published version.");
        });    });

    describe("DELETE /:id", () => {
        it("removes a plugin (keeping its row, disabled) and announces the change", async () => {
            const created = await addEas();
            const result = await asAdmin(request(ctx.app()).delete(`${ctx.baseUrl}/${created.uid}`));
            expect(result.status).toBe(204);
            expect((await asAdmin(request(ctx.app()).get(ctx.baseUrl))).body).toEqual([]);
            expect(publishedHashes[publishedHashes.length - 1]).toBe(computePluginStateHash([]));
            expect(await ctx.auditActions()).toEqual(expect.arrayContaining([AuditAction.PLUGIN_REMOVE]));
        });

        it("returns 404 for an unknown or already removed plugin, and refuses to update a removed one", async () => {
            expect((await asAdmin(request(ctx.app()).delete(`${ctx.baseUrl}/${uuid.v4()}`))).status).toBe(404);
            const created = await addEas();
            await asAdmin(request(ctx.app()).delete(`${ctx.baseUrl}/${created.uid}`));
            expect((await asAdmin(request(ctx.app()).delete(`${ctx.baseUrl}/${created.uid}`))).status).toBe(404);
            expect((await asAdmin(request(ctx.app()).put(`${ctx.baseUrl}/${created.uid}`)).send({ enabled: true })).status).toBe(404);
        });

        it("revives a removed plugin's row when the package is added again", async () => {
            const created = await addEas("1.0.0");
            await asAdmin(request(ctx.app()).put(`${ctx.baseUrl}/${created.uid}`)).send({ settings: { "mail:eas:sync_window_size": 7 } });
            await asAdmin(request(ctx.app()).delete(`${ctx.baseUrl}/${created.uid}`));

            const revived = await addEas();
            expect(revived.uid).toBe(created.uid);
            expect(revived).toEqual(
                expect.objectContaining({ packageVersion: "1.1.0", enabled: true, removed: false, settings: { "mail:eas:sync_window_size": 100 } }),
            );
            expect((await asAdmin(request(ctx.app()).get(ctx.baseUrl))).body).toHaveLength(1);
        });
    });

    describe("plugin dependencies", () => {
        const MAPI_MANIFEST = { apiVersion: PLUGIN_API_VERSION, displayName: "MAPI over HTTP" };
        const AUTODISCOVER_MANIFEST = {
            apiVersion: PLUGIN_API_VERSION,
            displayName: "Autodiscover",
            requires: { "@rapidmx/activesync": "^1.0.0", "@rapidmx/mapi-plugin": "^1.0.0" },
        };

        beforeEach(() => {
            publishFakePackage("@rapidmx/activesync", "2.0.0", { plugin: EAS_MANIFEST });
            publishFakePackage("@rapidmx/mapi-plugin", "1.0.0", { plugin: MAPI_MANIFEST });
            publishFakePackage("@rapidmx/mapi-plugin", "1.3.0", { plugin: { ...MAPI_MANIFEST, requires: { "@rapidmx/activesync": "^1.1.0" } } });
            publishFakePackage("@rapidmx/autodiscover-plugin", "1.0.0", { plugin: AUTODISCOVER_MANIFEST });
        });

        const add = (name: string, packageVersion?: string) => asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({ name, packageVersion });
        const put = (uid: string, body: any) => asAdmin(request(ctx.app()).put(`${ctx.baseUrl}/${uid}`)).send(body);
        const installed = async (): Promise<Record<string, any>> =>
            Object.fromEntries((await asAdmin(request(ctx.app()).get(ctx.baseUrl))).body.map((row: any) => [row.name, row]));

        it("plans an add without changing anything", async () => {
            const result = await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/plan?name=%40rapidmx%2Fautodiscover-plugin`));
            expect(result.status).toBe(200);
            expect(result.body.plugin).toEqual(expect.objectContaining({ name: "@rapidmx/autodiscover-plugin", version: "1.0.0" }));
            expect(result.body.install.map((i: any) => `${i.name}@${i.version}`)).toEqual(["@rapidmx/activesync@1.1.0", "@rapidmx/mapi-plugin@1.3.0"]);
            expect(result.body.enable).toEqual([]);
            expect(result.body.conflicts).toEqual([]);
            expect(await installed()).toEqual({});
            expect((await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/plan`))).status).toBe(400);
        });

        it("installs what a plugin requires first, at the highest version in range, and announces once", async () => {
            const result = await add("@rapidmx/autodiscover-plugin");
            expect(result.status).toBe(200);
            expect(result.body.plugin.name).toBe("@rapidmx/autodiscover-plugin");
            expect(result.body.dependencies.map((row: any) => `${row.name}@${row.packageVersion}`)).toEqual([
                "@rapidmx/activesync@1.1.0",
                "@rapidmx/mapi-plugin@1.3.0",
            ]);
            expect(Object.keys(await installed())).toEqual(["@rapidmx/activesync", "@rapidmx/autodiscover-plugin", "@rapidmx/mapi-plugin"]);
            expect(publishedHashes).toHaveLength(1);
            expect(await ctx.auditActions()).toEqual([AuditAction.PLUGIN_INSTALL, AuditAction.PLUGIN_INSTALL, AuditAction.PLUGIN_INSTALL]);
        });

        it("enables a disabled requirement and refuses one installed out of range", async () => {
            const eas = await addEas("1.1.0");
            expect((await put(eas.uid, { enabled: false })).status).toBe(200);
            const enabled = await add("@rapidmx/autodiscover-plugin");
            expect(enabled.status).toBe(200);
            expect(enabled.body.dependencies.map((row: any) => [row.name, row.enabled])).toEqual([
                ["@rapidmx/mapi-plugin", true],
                ["@rapidmx/activesync", true],
            ]);

            await ctx.clear();
            await addEas("2.0.0");
            const refused = await add("@rapidmx/autodiscover-plugin");
            expect(refused.status).toBe(409);
            expect(refused.body.message).toMatch(/Autodiscover requires Exchange ActiveSync \^1\.0\.0, but 2\.0\.0 is installed/);
            expect(Object.keys(await installed())).toEqual(["@rapidmx/activesync"]);
        });

        it("refuses a requirement that isn't allowed on this server", async () => {
            publishFakePackage("@rapidmx/needs-evil-plugin", "1.0.0", { plugin: { ...MAPI_MANIFEST, requires: { evil: "*" } } });
            const refused = await add("@rapidmx/needs-evil-plugin");
            expect(refused.status).toBe(409);
            expect(refused.body.message).toMatch(/evil, which isn't an allowed plugin package/);
        });

        it("blocks disabling or uninstalling a plugin an enabled plugin requires", async () => {
            const { body } = await add("@rapidmx/autodiscover-plugin");
            const eas = body.dependencies[0];
            const disable = await put(eas.uid, { enabled: false });
            expect(disable.status).toBe(409);
            expect(disable.body.message).toBe("Autodiscover, MAPI over HTTP require Exchange ActiveSync, so it can't be disabled. Disable Autodiscover, MAPI over HTTP first.");
            const remove = await asAdmin(request(ctx.app()).delete(`${ctx.baseUrl}/${eas.uid}`));
            expect(remove.status).toBe(409);
            expect(remove.body.message).toMatch(/Autodiscover, MAPI over HTTP require Exchange ActiveSync, so it can't be uninstalled/);

            expect((await put(body.plugin.uid, { enabled: false })).status).toBe(200);
            const single = await put(eas.uid, { enabled: false });
            expect(single.status).toBe(409);
            expect(single.body.message).toBe("MAPI over HTTP requires Exchange ActiveSync, so it can't be disabled. Disable MAPI over HTTP first.");
            expect((await put(body.dependencies[1].uid, { enabled: false })).status).toBe(200);
            expect((await put(eas.uid, { enabled: false })).status).toBe(200);
            // Disabling what's already disabled needs no check.
            expect((await put(eas.uid, { enabled: false })).status).toBe(200);
        });

        it("refuses a version change that breaks a dependent's range, and installs what a new version requires", async () => {
            const { body } = await add("@rapidmx/autodiscover-plugin");
            const eas = body.dependencies[0];
            const upgrade = await put(eas.uid, { packageVersion: "2.0.0" });
            expect(upgrade.status).toBe(409);
            expect(upgrade.body.message).toMatch(/Autodiscover requires @rapidmx\/activesync \^1\.0\.0, which 2\.0\.0 doesn't satisfy/);
            expect((await installed())["@rapidmx/activesync"].packageVersion).toBe("1.1.0");

            await ctx.clear();
            const mapi = (await add("@rapidmx/mapi-plugin", "1.0.0")).body.plugin;
            const upgraded = await put(mapi.uid, { packageVersion: "1.3.0" });
            expect(upgraded.status).toBe(200);
            expect((await installed())["@rapidmx/activesync"].packageVersion).toBe("1.1.0");
        });

        it("enables what a plugin requires when it's enabled, and refuses a stale edit before touching anything", async () => {
            const { body } = await add("@rapidmx/autodiscover-plugin");
            expect((await put(body.plugin.uid, { enabled: false })).status).toBe(200);
            expect((await put(body.dependencies[1].uid, { enabled: false })).status).toBe(200);

            const current = (await installed())["@rapidmx/autodiscover-plugin"];
            const stale = await put(current.uid, { enabled: true, version: current.version + 5 });
            expect(stale.status).toBe(409);
            expect((await installed())["@rapidmx/mapi-plugin"].enabled).toBe(false);

            const enabled = await put(current.uid, { enabled: true, version: current.version });
            expect(enabled.status).toBe(200);
            expect((await installed())["@rapidmx/mapi-plugin"].enabled).toBe(true);
        });

        it("reads each package and version from the registry once per request", async () => {
            expect((await add("@rapidmx/autodiscover-plugin")).status).toBe(200);
            expect(registryReads.length).toBe(new Set(registryReads).size);
            expect(registryReads).toEqual(
                expect.arrayContaining(["version:@rapidmx/autodiscover-plugin@latest", "package:@rapidmx/mapi-plugin", "version:@rapidmx/mapi-plugin@1.3.0"]),
            );
        });

        describe("expectedPlan", () => {
            const confirmed = {
                install: [
                    { name: "@rapidmx/mapi-plugin", version: "1.3.0" },
                    { name: "@rapidmx/activesync", version: "1.1.0" },
                ],
                enable: [],
            };

            it("applies an add whose plan still matches the confirmed one, in any order", async () => {
                const result = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({ name: "@rapidmx/autodiscover-plugin", expectedPlan: confirmed });
                expect(result.status).toBe(200);
                expect(result.body.dependencies).toHaveLength(2);
            });

            it("refuses, changing nothing, an add whose plan changed since it was previewed", async () => {
                for (const expectedPlan of [
                    { install: [{ name: "@rapidmx/activesync", version: "1.1.0" }], enable: [] },
                    { install: [...confirmed.install.slice(0, 1), { name: "@rapidmx/activesync", version: "1.0.0" }], enable: [] },
                    { ...confirmed, enable: ["@rapidmx/activesync"] },
                ]) {
                    const result = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({ name: "@rapidmx/autodiscover-plugin", expectedPlan });
                    expect(result.status).toBe(409);
                    expect(result.body.message).toBe("The plugins this change needs have changed since it was previewed. Review the change again.");
                }
                expect(await ctx.rows()).toEqual([]);
                expect(publishedHashes).toEqual([]);
            });

            it("rejects a malformed expectedPlan", async () => {
                for (const expectedPlan of [null, "x", { install: [] }, { install: {}, enable: [] }]) {
                    const result = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({ name: "@rapidmx/autodiscover-plugin", expectedPlan });
                    expect(result.status).toBe(400);
                }
            });

            it("checks a version change or enable against the confirmed plan, where no plan means nothing else changes", async () => {
                const mapi = (await add("@rapidmx/mapi-plugin", "1.0.0")).body.plugin;
                const changed = await put(mapi.uid, { packageVersion: "1.3.0", expectedPlan: { install: [], enable: [] } });
                expect(changed.status).toBe(409);
                expect((await installed())["@rapidmx/mapi-plugin"].packageVersion).toBe("1.0.0");

                const upgraded = await put(mapi.uid, { packageVersion: "1.3.0", expectedPlan: { install: [{ name: "@rapidmx/activesync", version: "1.1.0" }], enable: [] } });
                expect(upgraded.status).toBe(200);
                // A change that plans nothing ignores the preview.
                expect((await put(mapi.uid, { settings: {}, expectedPlan: { install: [], enable: [] } })).status).toBe(200);
                expect((await put(mapi.uid, { settings: {}, expectedPlan: { install: [], enable: ["x"], version: "0.0.1" } })).status).toBe(200);
                expect((await put(mapi.uid, { settings: {}, expectedPlan: { install: {}, enable: [] } })).status).toBe(400);
            });

            it("refuses a change whose target version isn't the previewed one", async () => {
                const stale = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({
                    name: "@rapidmx/autodiscover-plugin",
                    expectedPlan: { ...confirmed, version: "0.9.0" },
                });
                expect(stale.status).toBe(409);
                expect(stale.body.message).toBe("The plugins this change needs have changed since it was previewed. Review the change again.");
                expect(await ctx.rows()).toEqual([]);
                const malformed = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({ name: "@rapidmx/autodiscover-plugin", expectedPlan: { ...confirmed, version: 1 } });
                expect(malformed.status).toBe(400);

                const added = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({ name: "@rapidmx/autodiscover-plugin", expectedPlan: { ...confirmed, version: "1.0.0" } });
                expect(added.status).toBe(200);

                const mapi = added.body.dependencies.find((row: any) => row.name === "@rapidmx/mapi-plugin");
                expect((await put(mapi.uid, { packageVersion: "1.0.0", expectedPlan: { install: [], enable: [], version: "1.3.0" } })).status).toBe(409);
                expect((await put(mapi.uid, { packageVersion: "1.0.0", expectedPlan: { install: [], enable: [], version: "1.0.0" } })).status).toBe(200);
            });

            it("plans enabling an installed plugin from its stored manifest, matching what enabling it checks", async () => {
                const { body } = await add("@rapidmx/autodiscover-plugin");
                expect((await put(body.plugin.uid, { enabled: false })).status).toBe(200);
                expect((await put(body.dependencies[1].uid, { enabled: false })).status).toBe(200);
                registryReads.length = 0;

                for (const query of ["", "&packageVersion=1.0.0"]) {
                    const planned = await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/plan?name=%40rapidmx%2Fautodiscover-plugin${query}`));
                    expect(planned.status).toBe(200);
                    expect(planned.body).toEqual(expect.objectContaining({ install: [], enable: ["@rapidmx/mapi-plugin"], conflicts: [] }));
                    expect(planned.body.plugin).toEqual({ name: "@rapidmx/autodiscover-plugin", version: "1.0.0", manifest: expect.objectContaining({ displayName: "Autodiscover" }) });
                }
                expect(registryReads).toEqual([]);
                const repeated = await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/plan?name=%40rapidmx%2Fautodiscover-plugin&packageVersion=1.0.0&packageVersion=2.0.0`));
                expect(repeated.status).toBe(400);

                const planned = await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/plan?name=%40rapidmx%2Fautodiscover-plugin`));
                const { plugin, conflicts: _conflicts, ...expectedPlan } = planned.body;
                const enabled = await put(body.plugin.uid, { enabled: true, expectedPlan: { ...expectedPlan, version: plugin.version } });
                expect(enabled.status).toBe(200);
            });

            it("ignores the preview for a version change of a disabled plugin, which plans nothing", async () => {
                const mapi = (await add("@rapidmx/mapi-plugin", "1.0.0")).body.plugin;
                expect((await put(mapi.uid, { enabled: false })).status).toBe(200);
                const changed = await put(mapi.uid, { packageVersion: "1.3.0", expectedPlan: { install: [{ name: "x", version: "1" }], enable: [], version: "9.9.9" } });
                expect(changed.status).toBe(200);
                expect(changed.body).toEqual(expect.objectContaining({ packageVersion: "1.3.0", enabled: false }));
                expect((await installed())["@rapidmx/activesync"]).toBeUndefined();
            });
        });

        describe("a change that fails part way", () => {
            const autodiscoverRow = {
                name: "@rapidmx/autodiscover-plugin",
                packageVersion: "0.9.0",
                enabled: true,
                removed: false,
                settings: {},
                manifest: { apiVersion: PLUGIN_API_VERSION, displayName: "Autodiscover", settings: [] },
            };

            it("never overwrites a plugin installed by someone else while the change was planned", async () => {
                registryHooks.set("@rapidmx/mapi-plugin@1.3.0", () =>
                    ctx.insertPlugin({ ...autodiscoverRow, name: "@rapidmx/activesync", packageVersion: "1.0.0", settings: { "mail:eas:sync_window_size": 7 } }),
                );
                const result = await add("@rapidmx/autodiscover-plugin");
                expect(result.status).toBe(409);
                expect(result.body.message).toBe("'@rapidmx/activesync' changed while this change was being planned. Try again.");
                const rows = await ctx.rows();
                expect(rows.map((row) => [row.name, row.packageVersion, row.settings])).toEqual([["@rapidmx/activesync", "1.0.0", { "mail:eas:sync_window_size": 7 }]]);
                // Nothing was written, so there's nothing to announce.
                expect(publishedHashes).toEqual([]);
            });

            it("undoes the dependencies it installed, revived and enabled, then announces the result", async () => {
                const eas = await addEas("1.1.0");
                expect((await put(eas.uid, { enabled: false })).status).toBe(200);
                publishFakePackage("@rapidmx/mapi-plugin", "1.0.0", { plugin: MAPI_MANIFEST }, { dist: {} });
                const oldMapi = (await add("@rapidmx/mapi-plugin", "1.0.0")).body.plugin;
                expect((await asAdmin(request(ctx.app()).delete(`${ctx.baseUrl}/${oldMapi.uid}`))).status).toBe(204);
                const announced: number = publishedHashes.length;

                registryHooks.set("@rapidmx/mapi-plugin@1.3.0", () => ctx.insertPlugin(autodiscoverRow));
                const result = await add("@rapidmx/autodiscover-plugin");
                expect(result.status).toBe(409);
                expect(result.body.message).toMatch(/'@rapidmx\/autodiscover-plugin' changed while this change was being planned/);

                const rows: Record<string, any> = Object.fromEntries((await ctx.rows()).map((row) => [row.name, row]));
                expect(rows["@rapidmx/activesync"].enabled).toBe(false);
                expect(rows["@rapidmx/mapi-plugin"]).toEqual(expect.objectContaining({ uid: oldMapi.uid, removed: true, enabled: false, packageVersion: "1.0.0" }));
                // The revival recorded 1.3.0's integrity; 1.0.0 had none, so undoing it clears it again.
                expect(rows["@rapidmx/mapi-plugin"].integrity ?? undefined).toBeUndefined();
                expect(rows["@rapidmx/autodiscover-plugin"].packageVersion).toBe("0.9.0");
                expect(publishedHashes).toHaveLength(announced + 1);
                expect(publishedHashes[publishedHashes.length - 1]).toBe(computePluginStateHash(Object.values(rows)));
            });

            it("undoes a newly created dependency when the plugin's own update loses a race", async () => {
                await ctx.insertPlugin({ ...autodiscoverRow, enabled: false, packageVersion: "1.0.0", manifest: { ...autodiscoverRow.manifest, requires: { "@rapidmx/mapi-plugin": "^1.0.0" } } });
                const current = (await ctx.rows())[0];
                const announced: number = publishedHashes.length;

                registryHooks.set("@rapidmx/mapi-plugin@1.3.0", () => ctx.bumpVersion(current.uid));
                const result = await put(current.uid, { enabled: true, version: current.version });
                expect(result.status).toBe(409);
                // Rows this change created are deleted, not left removed - a removed row would stop the server's
                // default plugin list from ever adding those packages.
                expect((await ctx.rows()).map((row) => [row.name, row.enabled])).toEqual([["@rapidmx/autodiscover-plugin", false]]);
                expect(publishedHashes).toHaveLength(announced + 1);
            });
        });

        describe("a change racing another change", () => {
            const MAPI_ROW = { name: "@rapidmx/mapi-plugin", packageVersion: "1.0.0", enabled: true, removed: false, settings: {}, manifest: { ...MAPI_MANIFEST, settings: [] } };
            const conflict = /^Another plugin change made at the same time conflicts with this one: /;

            it("undoes an add whose requirement was disabled while it was being applied", async () => {
                await ctx.insertPlugin(MAPI_ROW);
                publishFakePackage("@rapidmx/needs-mapi-plugin", "1.0.0", { plugin: { ...MAPI_MANIFEST, displayName: "Needs MAPI", requires: { "@rapidmx/mapi-plugin": "^1.0.0" } } });
                // Planned against an enabled MAPI; a concurrent disable (whose own dependents check passed) lands first.
                registryHooks.set("@rapidmx/needs-mapi-plugin@1.0.0", async () => {
                    const [mapi] = await ctx.rows();
                    await ctx.updatePlugin(mapi.uid, { enabled: false });
                });
                const result = await add("@rapidmx/needs-mapi-plugin");
                expect(result.status).toBe(409);
                expect(result.body.message).toMatch(conflict);
                expect(result.body.message).toMatch(/Needs MAPI requires @rapidmx\/mapi-plugin \^1\.0\.0, which isn't enabled\./);
                expect((await ctx.rows()).map((row) => [row.name, row.enabled])).toEqual([["@rapidmx/mapi-plugin", false]]);
            });

            it("undoes a version change and what it installed when a dependent needing the old version was enabled meanwhile", async () => {
                publishFakePackage("@rapidmx/mapi-plugin", "2.0.0", { plugin: { ...MAPI_MANIFEST, requires: { "@rapidmx/activesync": "^1.0.0" } } });
                const mapi = (await add("@rapidmx/mapi-plugin", "1.0.0")).body.plugin;
                registryHooks.set("@rapidmx/activesync@1.1.0", () =>
                    ctx.insertPlugin({ ...MAPI_ROW, name: "@rapidmx/pinned-plugin", manifest: { ...MAPI_ROW.manifest, displayName: "Pinned", requires: { "@rapidmx/mapi-plugin": "~1.0.0" } } }),
                );
                const result = await put(mapi.uid, { packageVersion: "2.0.0" });
                expect(result.status).toBe(409);
                expect(result.body.message).toMatch(/Pinned requires MAPI over HTTP ~1\.0\.0, but 2\.0\.0 is installed\./);
                const rows: Record<string, any> = Object.fromEntries((await ctx.rows()).map((row) => [row.name, row]));
                expect(Object.keys(rows)).toEqual(["@rapidmx/mapi-plugin", "@rapidmx/pinned-plugin"]);
                expect(rows["@rapidmx/mapi-plugin"]).toEqual(expect.objectContaining({ packageVersion: "1.0.0", enabled: true }));
                expect(rows["@rapidmx/mapi-plugin"].integrity).toBe("sha512-@rapidmx/mapi-plugin@1.0.0");
            });

            it("undoes an uninstall when a dependent was enabled meanwhile", async () => {
                const mapi = (await add("@rapidmx/mapi-plugin", "1.0.0")).body.plugin;
                const audit = vi.spyOn(BasePluginRoute.prototype as any, "audit").mockImplementationOnce(() =>
                    ctx.insertPlugin({ ...MAPI_ROW, name: "@rapidmx/late-plugin", manifest: { ...MAPI_ROW.manifest, displayName: "Late", requires: { "@rapidmx/mapi-plugin": "*" } } }),
                );
                try {
                    const result = await asAdmin(request(ctx.app()).delete(`${ctx.baseUrl}/${mapi.uid}`));
                    expect(result.status).toBe(409);
                    expect(result.body.message).toMatch(/Late requires @rapidmx\/mapi-plugin \*, which isn't enabled\./);
                } finally {
                    audit.mockRestore();
                }
                expect((await installed())["@rapidmx/mapi-plugin"]).toEqual(expect.objectContaining({ enabled: true, removed: false }));
            });

            it("doesn't refuse a change over a requirement that was already unmet before it", async () => {
                await ctx.insertPlugin({ ...MAPI_ROW, name: "@rapidmx/broken-plugin", manifest: { ...MAPI_ROW.manifest, displayName: "Broken", requires: { "@rapidmx/ghost-plugin": "*" } } });
                const [broken] = await ctx.rows();
                expect((await put(broken.uid, { settings: {} })).status).toBe(200);
            });
        });
    });

    describe("GET /status", () => {
        it("returns the desired hash and fresh instance reports, sorted, dropping stale ones", async () => {
            const created = await addEas();
            const now = new Date().toISOString();
            instanceStatuses.push(
                { instance: "b", hash: "old", loaded: [], errors: [], safeMode: false, updatedAt: now },
                { instance: "a", hash: "new", loaded: [], errors: [], safeMode: false, updatedAt: now },
                { instance: "gone", hash: "old", loaded: [], errors: [], safeMode: false, updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
            );
            const result = await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/status`));
            expect(result.status).toBe(200);
            expect(result.body.hash).toBe(computePluginStateHash([created]));
            expect(result.body.instances.map((i: any) => i.instance)).toEqual(["a", "b"]);
        });
    });
}
