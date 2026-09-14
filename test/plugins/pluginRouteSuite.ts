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
import { computePluginStateHash, PLUGIN_API_VERSION } from "../../src/plugins/PluginUtils.js";
import { RegistryRequestError } from "../../src/plugins/NpmRegistryClient.js";
import {
    brokenPackages,
    failingSearchNamespaces,
    instanceStatuses,
    publishedHashes,
    publishFakePackage,
    registryClientRequests,
    resetPluginTestDoubles,
} from "./pluginTestDoubles.js";

export interface PluginRouteSuiteContext {
    config: any;
    app: () => any;
    baseUrl: string;
    clear: () => Promise<void>;
    auditActions: () => Promise<string[]>;
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

        it("rejects an invalid namespace and reports a registry failure", async () => {
            expect((await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/search?namespace=Not%20A%20Scope`))).status).toBe(400);
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
                { uid: current.uid, name: "@rapidmx/activesync", installedVersion: "1.1.0", latestVersion: "1.1.0", updateAvailable: false },
                { uid: flaky.body.plugin.uid, name: "@rapidmx/flaky-plugin", installedVersion: "1.0.0", updateAvailable: false, error: "registry offline" },
                { uid: old.body.plugin.uid, name: "@rapidmx/old-plugin", installedVersion: "1.0.0", latestVersion: "1.0.1", updateAvailable: true },
            ]);
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
    });

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
