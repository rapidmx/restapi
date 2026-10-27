///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for what HTTP can't reach on `BaseIntegrationsRoute`: its `@Init` hook, a server without a secret store, the change hook failing,
// and the races and failures around saving the row after the secret store was written. The route itself is tested over HTTP on both backends in
// test/routes/integrationsSuite.ts.
import { ApiError } from "@rapidrest/core";
import { ApiErrors, RepoUtils } from "@rapidrest/service-core";
import { NO_SECRET_STORE_MESSAGE } from "../../src/secrets/NullSecretStore.js";
import { BaseIntegrationsRoute } from "../../src/routes/BaseIntegrationsRoute.js";
import { AuditLogUtils } from "../../src/util/AuditLogUtils.js";
import { INTEGRATION_SETTINGS_UID, pluginNamespaceTokenKey } from "../../src/util/IntegrationSettingsUtils.js";
import { InMemorySecretStore } from "../testDoubles.js";

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

function routeWith(store: InMemorySecretStore | undefined, repo: any = memoryRepo()): any {
    const route: any = new TestIntegrationsRoute();
    route.secretStore = store;
    route.repo = repo;
    route.auditLogUtils = { record: vi.fn() };
    Object.defineProperty(route, "logger", { value: { warn: vi.fn(), error: vi.fn() }, configurable: true });
    return route;
}

/** The paths the store holds under `base` (each write has one of its own). */
function pathsUnder(store: InMemorySecretStore, base: string): string[] {
    return [...store.secrets.keys()].filter((path) => path.startsWith(`${base}-`));
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
        const route = routeWith(new InMemorySecretStore());
        route.configDnsResolver = "doh-dnssec";
        route.configRegistryToken = "REGISTRY-TOKEN";
        const view = await route.get();
        expect(view.dnsResolver.values.mode).toBe("doh-dnssec");
        expect(view.pluginRegistry.defaults.token).toEqual({ secret: true });
        expect(JSON.stringify(view)).not.toContain("REGISTRY-TOKEN");
    });

    it("never answers the user name or password the deployment's registry URL carries", async () => {
        const route = routeWith(new InMemorySecretStore());
        route.configRegistry = "https://ci:s3cret@npm.internal.example.com";
        const view = await route.get();
        expect(view.pluginRegistry.defaults.url).toBe("https://npm.internal.example.com");
        expect(JSON.stringify(view)).not.toContain("s3cret");
    });

    it("refuses to save a secret on a server that registers no secret store, as NullSecretStore does (400)", async () => {
        const route = routeWith(undefined);
        await expect(route.update("giphy", { apiKey: "key" }, {}, admin)).rejects.toMatchObject({ status: 400, message: NO_SECRET_STORE_MESSAGE });
        expect((await route.update("giphy", { enabled: false }, {}, admin)).giphy.values.enabled).toBe(false);
    });

    it("takes a reset without a body as a reset of every field", async () => {
        const route = routeWith(new InMemorySecretStore());
        await route.update("dnsResolver", { mode: "doh-dnssec" }, {}, admin);
        expect((await route.reset("dnsResolver", undefined, {}, admin)).dnsResolver.source.mode).toBe("deployment");
    });

    it("announces a saved change through integrationsChanged(), and only logs when that fails", async () => {
        const route = routeWith(new InMemorySecretStore());
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

    it("lets the write saved last win when two replace a secret at once, removing the other's from the store", async () => {
        const store = new InMemorySecretStore();
        const repo = memoryRepo();
        const route = routeWith(store, repo);
        await route.update("giphy", { apiKey: "first" }, {}, admin);
        const other = routeWith(store, repo);
        repo.beforeUpdate = async (call: number) => {
            // Lands between this request's store write and its row write: the other write is saved first.
            if (call === 2) {
                repo.beforeUpdate = undefined;
                await other.update("giphy", { apiKey: "racing" }, {}, admin);
            }
        };
        await route.update("giphy", { apiKey: "mine" }, {}, admin);
        const ref = repo.rows.get(INTEGRATION_SETTINGS_UID).giphy.apiKeyRef;
        expect(store.secrets.get(ref.path)).toEqual({ apiKey: "mine" });
        // "first" was removed by the other write, "racing" by this one: nothing is left that no row names.
        expect(pathsUnder(store, "server/giphy")).toEqual([ref.path]);
        expect(repo.update).toHaveBeenCalledTimes(4);
    });

    it("never removes the new secret of a write that replaced the one this request was clearing", async () => {
        const store = new InMemorySecretStore();
        const repo = memoryRepo();
        const route = routeWith(store, repo);
        await route.update("giphy", { apiKey: "first" }, {}, admin);
        const other = routeWith(store, repo);
        repo.beforeUpdate = async (call: number) => {
            if (call === 2) {
                repo.beforeUpdate = undefined;
                await other.update("giphy", { apiKey: "replaced" }, {}, admin);
            }
        };
        await route.update("giphy", { apiKey: null }, {}, admin);
        const ref = repo.rows.get(INTEGRATION_SETTINGS_UID).giphy.apiKeyRef;
        expect(store.secrets.get(ref.path)).toEqual({ apiKey: "replaced" });
        expect(pathsUnder(store, "server/giphy")).toEqual([ref.path]);
    });

    it("never removes the new secret of a write that lands while this one clears it from the store after saving the row", async () => {
        const store = new InMemorySecretStore();
        const repo = memoryRepo();
        const route = routeWith(store, repo);
        await route.update("giphy", { apiKey: "first" }, {}, admin);
        const other = routeWith(store, repo);
        // Inside this request's store delete, after its row was saved without the key: the other write saves a new key, which must survive.
        store.duringChange = async () => {
            await other.update("giphy", { apiKey: "k2" }, {}, admin);
        };
        const view = await route.update("giphy", { apiKey: null }, {}, admin);
        expect(view.giphy.source.apiKey).toBe("deployment");
        const ref = repo.rows.get(INTEGRATION_SETTINGS_UID).giphy.apiKeyRef;
        expect(store.secrets.get(ref.path)).toEqual({ apiKey: "k2" });
        expect(pathsUnder(store, "server/giphy")).toEqual([ref.path]);
    });

    it("clears nothing more when another write cleared the same secret first", async () => {
        const store = new InMemorySecretStore();
        const repo = memoryRepo();
        const route = routeWith(store, repo);
        await route.update("giphy", { enabled: true, apiKey: "first" }, {}, admin);
        const other = routeWith(store, repo);
        repo.beforeUpdate = async (call: number) => {
            if (call === 2) {
                repo.beforeUpdate = undefined;
                await other.update("giphy", { apiKey: null }, {}, admin);
            }
        };
        const deleted = vi.spyOn(store, "delete");
        const view = await route.update("giphy", { apiKey: null }, {}, admin);
        expect(view.giphy.source).toEqual({ enabled: "admin", apiKey: "deployment" });
        expect(deleted).toHaveBeenCalledTimes(1);
    });

    it("refuses (409) a change to the plugin namespaces whose tokens another write changed meanwhile, never mixing one's list with the other's tokens", async () => {
        const store = new InMemorySecretStore();
        const repo = memoryRepo();
        const route = routeWith(store, repo);
        await route.update("pluginRegistry", { namespaces: [{ name: "@a", token: "a" }] }, {}, admin);
        const other = routeWith(store, repo);
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
        expect(saved.namespaces).toEqual([{ name: "@c" }]);
        expect(store.secrets.get(saved.namespaceTokensRef.path)).toEqual({ [pluginNamespaceTokenKey("@c")]: "c" });
        // This request's secret is gone again, and so is the one the other write replaced.
        expect(pathsUnder(store, "server/plugin-namespaces")).toEqual([saved.namespaceTokensRef.path]);
        expect(route.auditLogUtils.record).toHaveBeenCalledTimes(1);

        // A change of the list alone is refused the same way when the tokens moved underneath it.
        repo.beforeUpdate = async () => {
            repo.beforeUpdate = undefined;
            await other.update("pluginRegistry", { namespaces: [{ name: "@c", token: "c2" }] }, {}, admin);
        };
        await expect(route.update("pluginRegistry", { namespaces: [{ name: "@c", token: MASK }, "@d"] }, {}, admin)).rejects.toMatchObject({ status: 409 });
    });

    it("carries over only the kept tokens the store still holds", async () => {
        const store = new InMemorySecretStore();
        const repo = memoryRepo();
        const route = routeWith(store, repo);
        await route.update("pluginRegistry", { namespaces: [{ name: "@a", token: "a" }, { name: "@b", token: "b" }] }, {}, admin);
        const first = repo.rows.get(INTEGRATION_SETTINGS_UID).pluginRegistry.namespaceTokensRef;
        // The store lost @b's token (edited by hand); keeping both carries @a's only.
        delete store.secrets.get(first.path)![pluginNamespaceTokenKey("@b")];
        const view = await route.update("pluginRegistry", { namespaces: [{ name: "@a", token: MASK }, { name: "@b", token: MASK }, { name: "@c", token: "c" }] }, {}, admin);
        const ref = repo.rows.get(INTEGRATION_SETTINGS_UID).pluginRegistry.namespaceTokensRef;
        expect(store.secrets.get(ref.path)).toEqual({ [pluginNamespaceTokenKey("@a")]: "a", [pluginNamespaceTokenKey("@c")]: "c" });
        expect(view.pluginRegistry.values.namespaces).toEqual([{ name: "@a", token: MASK }, { name: "@b" }, { name: "@c", token: MASK }]);
        expect(store.secrets.has(first.path)).toBe(false);
    });

    it("gives up with the 409 after losing the race to other writes again and again, removing the secret it wrote", async () => {
        const store = new InMemorySecretStore();
        const repo = memoryRepo();
        const route = routeWith(store, repo);
        repo.beforeUpdate = async () => {
            // Every attempt: another write bumps the row first.
            const row = repo.rows.get(INTEGRATION_SETTINGS_UID);
            repo.rows.set(INTEGRATION_SETTINGS_UID, { ...row, version: row.version + 1 });
        };
        await expect(route.update("giphy", { apiKey: "key" }, {}, admin)).rejects.toMatchObject({ code: ApiErrors.INVALID_OBJECT_VERSION });
        expect(repo.update).toHaveBeenCalledTimes(3);
        expect(store.secrets.size).toBe(0);
        expect(route.auditLogUtils.record).not.toHaveBeenCalled();
    });

    it("leaves the secret in use untouched when the row can't be saved, so nothing changes unaudited", async () => {
        const store = new InMemorySecretStore();
        const repo = memoryRepo();
        const route = routeWith(store, repo);
        await route.update("giphy", { apiKey: "first" }, {}, admin);
        const before = repo.rows.get(INTEGRATION_SETTINGS_UID);
        repo.beforeUpdate = async () => {
            throw new Error("datastore down");
        };
        await expect(route.update("giphy", { apiKey: "second" }, {}, admin)).rejects.toThrow("datastore down");
        expect(repo.update).toHaveBeenCalledTimes(2);
        // The row still names the first key, which the store still holds; the second is gone again.
        expect(repo.rows.get(INTEGRATION_SETTINGS_UID)).toEqual(before);
        expect(store.secrets.get(before.giphy.apiKeyRef.path)).toEqual({ apiKey: "first" });
        expect(pathsUnder(store, "server/giphy")).toEqual([before.giphy.apiKeyRef.path]);
        expect(route.auditLogUtils.record).toHaveBeenCalledTimes(1);
        expect(route.logger.error).not.toHaveBeenCalled();

        // A secret that can't be removed again is logged.
        store.failDelete = true;
        await expect(route.update("pluginRegistry", { token: "token" }, {}, admin)).rejects.toThrow("datastore down");
        expect(route.logger.warn).toHaveBeenCalledWith(expect.stringContaining("Could not remove the integration secret at 'server/plugin-registry-"));
    });

    it("leaves what it wrote in the store while the row can't be read back, logging it", async () => {
        const store = new InMemorySecretStore();
        const repo = memoryRepo();
        const route = routeWith(store, repo);
        await route.update("giphy", { enabled: true }, {}, admin);
        repo.beforeUpdate = async () => {
            throw new Error("datastore down");
        };
        repo.findOne.mockImplementationOnce(async () => structuredClone(repo.rows.get(INTEGRATION_SETTINGS_UID))).mockImplementationOnce(async () => {
            throw new Error("datastore gone");
        });
        await expect(route.update("giphy", { apiKey: "key" }, {}, admin)).rejects.toThrow("datastore down");
        expect(pathsUnder(store, "server/giphy")).toHaveLength(1);
        expect(route.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/'server\/giphy-[0-9a-f]+' were left in the secret store: datastore gone/));
    });

    it("keeps a secret the row names after all when the save reported a failure after it was applied", async () => {
        const store = new InMemorySecretStore();
        const repo = memoryRepo();
        const route = routeWith(store, repo);
        await route.update("giphy", { enabled: true }, {}, admin);
        repo.afterUpdate = async () => {
            repo.afterUpdate = undefined;
            throw new Error("connection reset");
        };
        await expect(route.update("giphy", { apiKey: "key" }, {}, admin)).rejects.toThrow("connection reset");
        const ref = repo.rows.get(INTEGRATION_SETTINGS_UID).giphy.apiKeyRef;
        expect(store.secrets.get(ref.path)).toEqual({ apiKey: "key" });
        expect(route.logger.error).toHaveBeenCalledWith(expect.stringContaining(`'${ref.path}' was saved with the settings`));
    });

    it("removes the secret it wrote when the next store write of the same request fails", async () => {
        const store = new InMemorySecretStore();
        const route = routeWith(store);
        const write = store.write.bind(store);
        vi.spyOn(store, "write").mockImplementation(async (path: string, values: Record<string, string>) => {
            if (path.startsWith("server/plugin-namespaces-")) {
                throw new ApiError(ApiErrors.INTERNAL_ERROR, 503, "secret store unavailable");
            }
            return await write(path, values);
        });
        await expect(route.update("pluginRegistry", { token: "token", namespaces: [{ name: "@acme", token: "ns" }] }, {}, admin)).rejects.toMatchObject({ status: 503 });
        expect(store.secrets.size).toBe(0);
        expect(route.repo.rows.size).toBe(0);
    });

    it("passes on a failure to create the row, with nothing written to the store", async () => {
        const store = new InMemorySecretStore();
        const repo = memoryRepo();
        repo.create.mockImplementation(async () => Promise.reject(new Error("datastore down")));
        const route = routeWith(store, repo);
        await expect(route.update("stun", { urls: ["stun:stun.example.com"] }, {}, admin)).rejects.toThrow("datastore down");
        expect(store.secrets.size).toBe(0);
    });
});
