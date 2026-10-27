///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for what HTTP can't reach on `BaseIntegrationsRoute`: its `@Init` hook, a server without a cipher, the change hook failing, and the
// races and failures around the one write of the row. The route itself is tested over HTTP on both backends in test/routes/integrationsSuite.ts.
import { ApiError } from "@rapidrest/core";
import { ApiErrors, RepoUtils } from "@rapidrest/service-core";
import { BaseIntegrationsRoute } from "../../src/routes/BaseIntegrationsRoute.js";
import { AuditLogUtils } from "../../src/util/AuditLogUtils.js";
import { INTEGRATION_SETTINGS_UID } from "../../src/util/IntegrationSettingsUtils.js";

const MASK = { secret: true };

/** A uniquely named stand-in model class. */
function model(name: string): any {
    return { [name]: class {} }[name];
}

class TestIntegrationsRoute extends (BaseIntegrationsRoute as any) {
    protected integrationSettingsClass: any = model("SettingsModel");
    protected auditLogClass: any = model("AuditModel");
}

const admin: any = { uid: "admin", roles: ["admin"], elevated: Date.now() };

/** A settings repository in memory with `RepoUtils`' optimistic lock; `beforeUpdate` runs before each update applies (how a test stages a race). */
function memoryRepo(): any {
    const rows: Map<string, any> = new Map();
    const repo: any = {
        rows,
        beforeUpdate: undefined as undefined | ((call: number) => Promise<void>),
        afterUpdate: undefined as undefined | ((call: number) => Promise<void>),
        updates: 0,
        findOne: vi.fn(async (uid: string) => (rows.has(uid) ? structuredClone(rows.get(uid)) : undefined)),
        create: vi.fn(async (obj: any) => {
            rows.set(obj.uid, { ...structuredClone(obj), version: 0 });
            return structuredClone(rows.get(obj.uid));
        }),
        update: vi.fn(async (obj: any) => {
            repo.updates++;
            await repo.beforeUpdate?.(repo.updates);
            const row: any = rows.get(obj.uid);
            if (row.version !== obj.version) {
                throw new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "stale");
            }
            rows.set(obj.uid, { ...row, ...structuredClone(obj), version: row.version + 1 });
            await repo.afterUpdate?.(repo.updates);
            return structuredClone(rows.get(obj.uid));
        }),
    };
    return repo;
}

/** A stand-in for `ConfigCipher` that seals a value as an envelope naming where it belongs (and which seal it was, so two seals of one value differ as
 * real ones do), so a test can read the value back without a keyring. */
function fakeCipher(): any {
    let seals = 0;
    return {
        encrypt: vi.fn((value: string, context: any) => ({ $enc: 1, kid: "k1", iv: "iv", ct: `${context.record}/${context.uid}/${context.field}=${value}#${++seals}`, tag: "tag" })),
    };
}

/** The value a `fakeCipher()` envelope holds. */
function sealed(envelope: any): string {
    return /=(.*)#\d+$/.exec(envelope.ct)![1];
}

function routeWith(cipher: any = fakeCipher(), repo: any = memoryRepo()): any {
    const route: any = new TestIntegrationsRoute();
    route.cipher = cipher;
    route.repo = repo;
    route.auditLogUtils = { record: vi.fn() };
    Object.defineProperty(route, "logger", { value: { warn: vi.fn(), error: vi.fn() }, configurable: true });
    return route;
}

describe("BaseIntegrationsRoute initialize()", () => {
    function withFactory(route: any): any {
        const factory: any = { newInstance: vi.fn(async (type: any, opts: any) => ({ type, opts })) };
        Object.defineProperty(route, "_objectFactory", { value: factory, writable: true, configurable: true });
        return factory;
    }

    it("throws when the objectFactory is not set", async () => {
        await expect((new TestIntegrationsRoute() as any).initialize()).rejects.toThrow("objectFactory is not set.");
    });

    it("builds the settings and audit repos and the audit service once", async () => {
        const route: any = new TestIntegrationsRoute();
        const factory = withFactory(route);
        await route.initialize();
        expect(factory.newInstance.mock.calls.map(([type, opts]: any) => [type, opts.name])).toEqual([
            [RepoUtils, "SettingsModel"],
            [RepoUtils, "AuditModel"],
            [AuditLogUtils, "AuditModel"],
        ]);
        await route.initialize();
        expect(factory.newInstance).toHaveBeenCalledTimes(3);
    });

    it("skips what has no model class", async () => {
        const route: any = new TestIntegrationsRoute();
        const factory = withFactory(route);
        Object.assign(route, { integrationSettingsClass: undefined, auditLogClass: undefined });
        await route.initialize();
        expect(factory.newInstance).not.toHaveBeenCalled();
    });
});

describe("BaseIntegrationsRoute", () => {
    it("reads the deployment's values from the config it was built with, and answers them before anything is saved", async () => {
        const route = routeWith();
        route.configDnsResolver = "doh-dnssec";
        route.configRegistryToken = "REGISTRY-TOKEN";
        const view = await route.get();
        expect(view.dnsResolver.values.mode).toBe("doh-dnssec");
        expect(view.pluginRegistry.defaults.token).toEqual({ secret: true });
        expect(JSON.stringify(view)).not.toContain("REGISTRY-TOKEN");
    });

    it("never answers the user name or password the deployment's registry URL carries", async () => {
        const route = routeWith();
        route.configRegistry = "https://ci:s3cret@npm.internal.example.com";
        const view = await route.get();
        expect(view.pluginRegistry.defaults.url).toBe("https://npm.internal.example.com");
        expect(JSON.stringify(view)).not.toContain("s3cret");
    });

    it("refuses to save a secret on a server that registers no cipher (503), saving nothing, while what needs none still saves", async () => {
        const route = routeWith(undefined, memoryRepo());
        route.cipher = undefined;
        await expect(route.update("giphy", { apiKey: "key" }, {}, admin)).rejects.toMatchObject({ status: 503, message: expect.stringContaining("Configuration encryption isn't available") });
        await expect(route.update("pluginRegistry", { namespaces: [{ name: "@acme", token: "t" }] }, {}, admin)).rejects.toMatchObject({ status: 503 });
        expect(route.repo.rows.size).toBe(0);
        expect(route.auditLogUtils.record).not.toHaveBeenCalled();
        expect((await route.update("giphy", { enabled: false }, {}, admin)).giphy.values.enabled).toBe(false);
        // Clearing and keeping need no cipher.
        expect((await route.update("pluginRegistry", { namespaces: ["@public"] }, {}, admin)).pluginRegistry.values.namespaces).toEqual([{ name: "@public" }]);
        expect((await route.update("giphy", { apiKey: null }, {}, admin)).giphy.source.apiKey).toBe("deployment");
    });

    it("seals each secret for the settings row and the field it is saved in, in the one write of the row", async () => {
        const cipher = fakeCipher();
        const route = routeWith(cipher);
        await route.update("giphy", { apiKey: " key " }, {}, admin);
        await route.update("pluginRegistry", { token: "reg", namespaces: [{ name: "@acme", token: "ns" }, "rapidmx"] }, {}, admin);
        expect(cipher.encrypt.mock.calls).toEqual([
            ["key", { record: "IntegrationSettings", uid: INTEGRATION_SETTINGS_UID, field: "giphy.apiKey" }],
            ["reg", { record: "IntegrationSettings", uid: INTEGRATION_SETTINGS_UID, field: "pluginRegistry.token" }],
            ["ns", { record: "IntegrationSettings", uid: INTEGRATION_SETTINGS_UID, field: "pluginRegistry.namespaces.@acme.token" }],
        ]);
        const row = route.repo.rows.get(INTEGRATION_SETTINGS_UID);
        expect(sealed(row.giphy.apiKey)).toBe("key");
        expect(sealed(row.pluginRegistry.token)).toBe("reg");
        expect(row.pluginRegistry.namespaces.map((namespace: any) => namespace.name)).toEqual(["@acme", "@rapidmx"]);
        expect(sealed(row.pluginRegistry.namespaces[0].token)).toBe("ns");
        expect(row.pluginRegistry.namespaces[1].token).toBeUndefined();
        // Two updates, one write each; there is no second store to write to.
        expect(route.repo.update).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(route.auditLogUtils.record.mock.calls)).not.toMatch(/"(key|reg|ns)"/);
    });

    it("takes a reset without a body as a reset of every field", async () => {
        const route = routeWith();
        await route.update("dnsResolver", { mode: "doh-dnssec" }, {}, admin);
        expect((await route.reset("dnsResolver", undefined, {}, admin)).dnsResolver.source.mode).toBe("deployment");
    });

    it("announces a saved change through integrationsChanged(), and only logs when that fails", async () => {
        const route = routeWith();
        const announced: any[] = [];
        route.integrationsChanged = vi.fn(async (settings: any) => {
            announced.push(settings);
            throw new Error("redis down");
        });
        const view = await route.update("stun", { urls: ["stun:stun.example.com"] }, {}, admin);
        expect(view.stun.values.urls).toEqual(["stun:stun.example.com"]);
        expect(announced).toEqual([expect.objectContaining({ uid: INTEGRATION_SETTINGS_UID, stun: { urls: ["stun:stun.example.com"] } })]);
        expect(route.logger.warn).toHaveBeenCalledWith(expect.stringContaining("redis down"));
        // The base hook does nothing.
        await expect(BaseIntegrationsRoute.prototype["integrationsChanged" as keyof BaseIntegrationsRoute<any>].call(route, {})).resolves.toBeUndefined();
    });

    it("merges a change to another section, and to another field, that lands before the row is written, sealing the secret once", async () => {
        const cipher = fakeCipher();
        const repo = memoryRepo();
        const route = routeWith(cipher, repo);
        await route.update("giphy", { enabled: true }, {}, admin);
        const other = routeWith(fakeCipher(), repo);
        repo.beforeUpdate = async (call: number) => {
            if (call === 2) {
                repo.beforeUpdate = undefined;
                await other.update("stun", { urls: ["stun:stun.example.com"] }, {}, admin);
                await other.update("giphy", { enabled: false }, {}, admin);
            }
        };
        const view = await route.update("giphy", { apiKey: "key" }, {}, admin);
        expect(view.giphy.values).toEqual({ enabled: false, apiKey: MASK });
        expect(view.stun.values.urls).toEqual(["stun:stun.example.com"]);
        const row = repo.rows.get(INTEGRATION_SETTINGS_UID);
        expect(sealed(row.giphy.apiKey)).toBe("key");
        expect(row.giphy.enabled).toBe(false);
        // The retry applied the same envelope to the newer row.
        expect(cipher.encrypt).toHaveBeenCalledTimes(1);
        expect(repo.update).toHaveBeenCalledTimes(5);
    });

    it("lets the write saved last win when two replace a secret at once", async () => {
        const repo = memoryRepo();
        const route = routeWith(fakeCipher(), repo);
        await route.update("giphy", { apiKey: "first" }, {}, admin);
        const other = routeWith(fakeCipher(), repo);
        repo.beforeUpdate = async (call: number) => {
            if (call === 2) {
                repo.beforeUpdate = undefined;
                await other.update("giphy", { apiKey: "racing" }, {}, admin);
            }
        };
        await route.update("giphy", { apiKey: "mine" }, {}, admin);
        expect(sealed(repo.rows.get(INTEGRATION_SETTINGS_UID).giphy.apiKey)).toBe("mine");
        expect(repo.update).toHaveBeenCalledTimes(4);
    });

    it("lets a clear win over a secret another write replaced meanwhile, as the last write to the field", async () => {
        const repo = memoryRepo();
        const route = routeWith(fakeCipher(), repo);
        await route.update("giphy", { enabled: true, apiKey: "first" }, {}, admin);
        const other = routeWith(fakeCipher(), repo);
        repo.beforeUpdate = async (call: number) => {
            if (call === 2) {
                repo.beforeUpdate = undefined;
                await other.update("giphy", { apiKey: "replaced" }, {}, admin);
            }
        };
        const view = await route.update("giphy", { apiKey: null }, {}, admin);
        expect(view.giphy.source).toEqual({ enabled: "admin", apiKey: "deployment" });
        expect(repo.rows.get(INTEGRATION_SETTINGS_UID).giphy).toEqual({ enabled: true });
    });

    it("settles on the cleared secret when another write cleared it first", async () => {
        const repo = memoryRepo();
        const route = routeWith(fakeCipher(), repo);
        await route.update("giphy", { enabled: true, apiKey: "first" }, {}, admin);
        const other = routeWith(fakeCipher(), repo);
        repo.beforeUpdate = async (call: number) => {
            if (call === 2) {
                repo.beforeUpdate = undefined;
                await other.update("giphy", { apiKey: null }, {}, admin);
            }
        };
        const view = await route.update("giphy", { apiKey: null }, {}, admin);
        expect(view.giphy.source).toEqual({ enabled: "admin", apiKey: "deployment" });
        expect(repo.rows.get(INTEGRATION_SETTINGS_UID).giphy).toEqual({ enabled: true });
    });

    it("refuses (409) a change to the plugin namespaces whose tokens another write changed meanwhile, never mixing one's list with the other's tokens", async () => {
        const repo = memoryRepo();
        const route = routeWith(fakeCipher(), repo);
        await route.update("pluginRegistry", { namespaces: [{ name: "@a", token: "a" }] }, {}, admin);
        const other = routeWith(fakeCipher(), repo);
        repo.beforeUpdate = async (call: number) => {
            if (call === 2) {
                repo.beforeUpdate = undefined;
                await other.update("pluginRegistry", { namespaces: [{ name: "@c", token: "c" }] }, {}, admin);
            }
        };
        await expect(route.update("pluginRegistry", { namespaces: [{ name: "@a", token: MASK }, { name: "@b", token: "b" }] }, {}, admin)).rejects.toMatchObject({
            code: ApiErrors.INVALID_OBJECT_VERSION,
        });
        const saved = repo.rows.get(INTEGRATION_SETTINGS_UID).pluginRegistry;
        expect(saved.namespaces.map((namespace: any) => [namespace.name, sealed(namespace.token)])).toEqual([["@c", "c"]]);
        expect(route.auditLogUtils.record).toHaveBeenCalledTimes(1);

        // A change of the list alone is refused the same way when the kept token was replaced underneath it.
        repo.beforeUpdate = async () => {
            repo.beforeUpdate = undefined;
            await other.update("pluginRegistry", { namespaces: [{ name: "@c", token: "c2" }] }, {}, admin);
        };
        await expect(route.update("pluginRegistry", { namespaces: [{ name: "@c", token: MASK }, "@d"] }, {}, admin)).rejects.toMatchObject({ status: 409 });
        expect(repo.rows.get(INTEGRATION_SETTINGS_UID).pluginRegistry.namespaces.map((namespace: any) => namespace.name)).toEqual(["@c"]);
    });

    it("lets the list saved last win when another write changed the namespaces but none of their tokens", async () => {
        const repo = memoryRepo();
        const route = routeWith(fakeCipher(), repo);
        await route.update("pluginRegistry", { namespaces: [{ name: "@a", token: "a" }] }, {}, admin);
        const other = routeWith(fakeCipher(), repo);
        repo.beforeUpdate = async (call: number) => {
            if (call === 2) {
                repo.beforeUpdate = undefined;
                await other.update("pluginRegistry", { namespaces: [{ name: "@a", token: MASK }, "@x"] }, {}, admin);
            }
        };
        await route.update("pluginRegistry", { namespaces: [{ name: "@a", token: MASK }, "@d"] }, {}, admin);
        const saved = repo.rows.get(INTEGRATION_SETTINGS_UID).pluginRegistry.namespaces;
        expect(saved.map((namespace: any) => namespace.name)).toEqual(["@a", "@d"]);
        expect(sealed(saved[0].token)).toBe("a");
    });

    it("gives up with the 409 after losing the race to other writes again and again", async () => {
        const repo = memoryRepo();
        const route = routeWith(fakeCipher(), repo);
        repo.beforeUpdate = async () => {
            // Every attempt: another write bumps the row first.
            const row = repo.rows.get(INTEGRATION_SETTINGS_UID);
            repo.rows.set(INTEGRATION_SETTINGS_UID, { ...row, version: row.version + 1 });
        };
        await expect(route.update("giphy", { apiKey: "key" }, {}, admin)).rejects.toMatchObject({ code: ApiErrors.INVALID_OBJECT_VERSION });
        expect(repo.update).toHaveBeenCalledTimes(3);
        expect(repo.rows.get(INTEGRATION_SETTINGS_UID).giphy ?? null).toBeNull();
        expect(route.auditLogUtils.record).not.toHaveBeenCalled();
    });

    it("leaves the row as it was when it can't be saved, so nothing changes unaudited or announced", async () => {
        const repo = memoryRepo();
        const route = routeWith(fakeCipher(), repo);
        route.integrationsChanged = vi.fn();
        await route.update("giphy", { apiKey: "first" }, {}, admin);
        const before = structuredClone(repo.rows.get(INTEGRATION_SETTINGS_UID));
        repo.beforeUpdate = async () => {
            throw new Error("datastore down");
        };
        await expect(route.update("giphy", { apiKey: "second" }, {}, admin)).rejects.toThrow("datastore down");
        expect(repo.rows.get(INTEGRATION_SETTINGS_UID)).toEqual(before);
        expect(route.auditLogUtils.record).toHaveBeenCalledTimes(1);
        expect(route.integrationsChanged).toHaveBeenCalledTimes(1);
        expect(route.logger.error).not.toHaveBeenCalled();
    });

    it("passes on a failure to create the row", async () => {
        const repo = memoryRepo();
        repo.create.mockImplementation(async () => Promise.reject(new Error("datastore down")));
        const route = routeWith(fakeCipher(), repo);
        await expect(route.update("stun", { urls: ["stun:stun.example.com"] }, {}, admin)).rejects.toThrow("datastore down");
        expect(route.auditLogUtils.record).not.toHaveBeenCalled();
    });
});
