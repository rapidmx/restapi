///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The Redis and registry-client paths the HTTP suites replace with test doubles.
import { Readable } from "stream";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";

const redis = vi.hoisted(() => ({
    connect: vi.fn(),
    publish: vi.fn(),
    hGetAll: vi.fn(),
    disconnect: vi.fn(),
    createClient: vi.fn(),
}));
vi.mock("redis", () => ({ createClient: redis.createClient }));

import { PluginRouteMongo } from "../../src/routes/mongo/PluginRouteMongo.js";
import { NpmRegistryClient } from "../../src/plugins/NpmRegistryClient.js";
import { PLUGIN_CHANGED_EVENT, PLUGIN_EVENTS_CHANNEL, PLUGIN_STATUS_KEY } from "../../src/plugins/PluginUtils.js";

/** A route with the given injected fields set directly - `initialize: false` skips config injection. */
async function newRoute(fields: Record<string, any>): Promise<any> {
    const objectFactory = new ObjectFactory(undefined, Logger());
    const route: any = await objectFactory.newInstance(PluginRouteMongo, { name: "default", initialize: false });
    return Object.assign(route, fields);
}

describe("BasePluginRoute (Redis and registry wiring)", () => {
    beforeEach(() => {
        redis.connect.mockReset().mockResolvedValue(undefined);
        redis.publish.mockReset().mockResolvedValue(1);
        redis.hGetAll.mockReset().mockResolvedValue({});
        redis.disconnect.mockReset().mockResolvedValue(undefined);
        redis.createClient.mockReset().mockImplementation(() => ({
            connect: redis.connect,
            publish: redis.publish,
            hGetAll: redis.hGetAll,
            disconnect: redis.disconnect,
        }));
    });

    it("builds a registry client from config", async () => {
        const route = await newRoute({ registryUrl: "https://npm.example.com", registryToken: "tok" });
        const client: NpmRegistryClient = route.createRegistryClient();
        expect(client).toBeInstanceOf(NpmRegistryClient);
        expect((client as any).registryUrl).toBe("https://npm.example.com");
        expect((client as any).authToken).toBe("tok");
        const defaults: NpmRegistryClient = (await newRoute({})).createRegistryClient();
        expect((defaults as any).authToken).toBeUndefined();
    });

    it("publishes a change message on the events datastore", async () => {
        const route = await newRoute({ eventsConfig: { url: "redis://events" } });
        await route.publishChange("abc");
        expect(redis.createClient).toHaveBeenCalledWith({ url: "redis://events" });
        expect(redis.publish).toHaveBeenCalledWith(PLUGIN_EVENTS_CHANNEL, JSON.stringify({ type: PLUGIN_CHANGED_EVENT, hash: "abc" }));
        expect(redis.disconnect).toHaveBeenCalled();
    });

    it("skips publishing without an events datastore, and only logs a Redis failure", async () => {
        await (await newRoute({})).publishChange("abc");
        expect(redis.createClient).not.toHaveBeenCalled();

        redis.connect.mockRejectedValue(new Error("down"));
        redis.disconnect.mockRejectedValue(new Error("not connected"));
        const route = await newRoute({ eventsConfig: { url: "redis://events" } });
        await expect(route.publishChange("abc")).resolves.toBeUndefined();
    });

    it("reads instance statuses from the cache datastore, skipping unreadable entries", async () => {
        redis.hGetAll.mockResolvedValue({ a: JSON.stringify({ instance: "a" }), b: "{not json" });
        const route = await newRoute({ cacheConfig: { url: "redis://cache" } });
        expect(await route.readInstanceStatuses()).toEqual([{ instance: "a" }]);
        expect(redis.createClient).toHaveBeenCalledWith({ url: "redis://cache" });
        expect(redis.hGetAll).toHaveBeenCalledWith(PLUGIN_STATUS_KEY);
    });

    it("reads no statuses without a cache datastore or when Redis fails", async () => {
        expect(await (await newRoute({})).readInstanceStatuses()).toEqual([]);
        redis.hGetAll.mockRejectedValue(new Error("down"));
        redis.disconnect.mockRejectedValue(new Error("not connected"));
        expect(await (await newRoute({ cacheConfig: { url: "redis://cache" } })).readInstanceStatuses()).toEqual([]);
    });
});

describe("BasePluginRoute namespaces", () => {
    it("routes registry requests to a namespace's own registry, else the default", async () => {
        const route = await newRoute({
            registryUrl: "https://registry.default.test",
            registryToken: "",
            namespacesConfig: ["@rapidmx", { name: "@acme", registry: "https://npm.acme.test", token: "secret" }],
            allowedPackagesConfig: ["left-pad"],
        });
        const acme: any = route.createRegistryClient("@acme/crm-plugin");
        expect([acme.registryUrl, acme.authToken]).toEqual(["https://npm.acme.test", "secret"]);
        const acmeScope: any = route.createRegistryClient("@acme");
        expect(acmeScope.registryUrl).toBe("https://npm.acme.test");
        const rapidmx: any = route.createRegistryClient("@rapidmx/mapi-plugin");
        expect([rapidmx.registryUrl, rapidmx.authToken]).toEqual(["https://registry.default.test", undefined]);
        expect(route.allowedPackages).toEqual(["left-pad", "@rapidmx/*", "@acme/*"]);

        // A namespace with a token but no registry of its own uses that token on the default registry; one with its own
        // registry and no token never gets the default registry's token.
        const tokens = await newRoute({
            registryUrl: "https://registry.default.test",
            registryToken: "global",
            namespacesConfig: ["@rapidmx", { name: "@tok", token: "ns-token" }, { name: "@own", registry: "https://npm.own.test" }],
        });
        const tok: any = tokens.createRegistryClient("@tok/x-plugin");
        expect([tok.registryUrl, tok.authToken]).toEqual(["https://registry.default.test", "ns-token"]);
        expect(tokens.createRegistryClient("@rapidmx/x-plugin").authToken).toBe("global");
        const own: any = tokens.createRegistryClient("@own/x-plugin");
        expect([own.registryUrl, own.authToken]).toEqual(["https://npm.own.test", undefined]);
        expect(route.listNamespaces()).toEqual([{ name: "@rapidmx", registry: undefined }, { name: "@acme", registry: "https://npm.acme.test" }]);
    });

    it("reads string config (as an environment variable sets it) as a list, warning once about entries it drops", async () => {
        const logger = { warn: vi.fn() };
        const route = await newRoute({ namespacesConfig: "@rapidmx, Bad Scope", allowedPackagesConfig: "@acme/*, *", logger });
        expect(route.allowedPackages).toEqual(["@acme/*", "@rapidmx/*"]);
        expect(route.allowedPackages).toEqual(["@acme/*", "@rapidmx/*"]);
        expect(logger.warn).toHaveBeenCalledTimes(2);
    });
});

describe("BasePluginRoute rollback", () => {
    it("tries every undo step, newest first, logging the ones that fail", async () => {
        const logger = { error: vi.fn() };
        const route = await newRoute({ logger });
        const order: string[] = [];
        await route.rollback([
            async () => {
                order.push("first");
            },
            async () => {
                order.push("second");
                throw new Error("row gone");
            },
        ]);
        expect(order).toEqual(["second", "first"]);
        expect(logger.error).toHaveBeenCalledWith("Could not undo part of a failed plugin change: row gone");
    });

    it("logs, rather than throws, a failure to announce a change, so it can't replace the change's outcome", async () => {
        const logger = { error: vi.fn() };
        const route = await newRoute({ logger, pluginRepo: { find: vi.fn().mockRejectedValue(new Error("db down")) } });
        await expect(route.announce()).resolves.toBeUndefined();
        expect(logger.error).toHaveBeenCalledWith("Could not announce a plugin change: db down");
    });
});

describe("BasePluginRoute configured settings", () => {
    it("adds what the deployment's configuration says about a plugin's settings to a response, leaving the row alone", async () => {
        const stores = { env: { get: (key: string) => (key === "mail:videoconf:turn:url" ? "turn:mail.example.com:3478" : undefined) } };
        const route = await newRoute({ config: { stores } });
        const row = { uid: "1", name: "@rapidmx/meet", settings: {}, manifest: { apiVersion: 1, displayName: "Meet", settings: [{ key: "mail:videoconf:turn:url", label: "TURN", type: "string" }] } };
        const shown = route.withConfigured(row);
        expect(shown.configured).toEqual({ "mail:videoconf:turn:url": { value: "turn:mail.example.com:3478", secret: false } });
        expect(shown).toEqual({ ...row, configured: shown.configured });
        expect(row).not.toHaveProperty("configured");
    });
});

describe("BasePluginRoute uploads", () => {
    const admin: any = { uid: "admin-1", roles: ["admin"], elevated: Date.now() };
    const res = (): any => ({ status: vi.fn(), json: vi.fn() });

    it("reads the switch and the size limit from config, falling back to the defaults", async () => {
        const defaults = await newRoute({});
        expect([defaults.uploadsEnabled, defaults.uploadMaxBytes]).toEqual([true, 50 * 1024 * 1024]);
        for (const off of [false, "false", " FALSE ", "0", 0]) {
            expect((await newRoute({ uploadsEnabledConfig: off })).uploadsEnabled).toBe(false);
        }
        expect((await newRoute({ uploadsEnabledConfig: "true" })).uploadsEnabled).toBe(true);
        expect((await newRoute({ uploadMaxBytesConfig: "1000" })).uploadMaxBytes).toBe(1000);
        for (const bad of ["lots", -5, 0, NaN]) {
            expect((await newRoute({ uploadMaxBytesConfig: bad })).uploadMaxBytes).toBe(50 * 1024 * 1024);
        }
    });

    it("refuses with a 403 when uploads are switched off, and with a 500 without a blob store", async () => {
        const off = await newRoute({ pluginRepo: {}, uploadsEnabledConfig: "false", blobStore: {} });
        await expect(off.upload({ headers: {} }, res(), undefined, undefined, admin)).rejects.toMatchObject({
            status: 403,
            message: expect.stringContaining("system:plugins:uploads:enabled"),
        });
        const none = await newRoute({ pluginRepo: {} });
        await expect(none.upload({ headers: {} }, res(), undefined, undefined, admin)).rejects.toMatchObject({ status: 500 });
        // An unelevated administrator never gets as far as the switch.
        await expect(off.upload({ headers: {} }, res(), undefined, undefined, { uid: "a", roles: ["admin"] })).rejects.toMatchObject({ status: 403 });
    });

    it("stops reading a body that has no declared length once it passes the limit", async () => {
        const route = await newRoute({ pluginRepo: {}, blobStore: {}, uploadMaxBytesConfig: 10 });
        const stream = Readable.from([Buffer.alloc(6), "abcdef", Buffer.alloc(6)]);
        const err: any = await route.upload({ headers: {}, bodyStream: stream }, res(), undefined, undefined, admin).catch((e: any) => e);
        expect([err.status, err.message]).toEqual([413, "The uploaded pack is larger than the 10 bytes allowed."]);
        expect(stream.destroyed).toBe(true);
    });

    it("logs, rather than fails on, a pack it can't delete", async () => {
        const warn = vi.fn();
        const blobStore = { delete: vi.fn().mockRejectedValue(new Error("disk")) };
        const route = await newRoute({ pluginRepo: { find: async () => [{ uploadBlobKey: "k1", removed: true }] }, blobStore, logger: { warn } });
        await route.dropUnreferencedBlob(undefined);
        await route.dropUnreferencedBlob("k1");
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("Could not delete the unused plugin pack 'k1': disk"));
        // A pack a live row still names stays.
        route.pluginRepo = { find: async () => [{ uploadBlobKey: "k1" }] };
        blobStore.delete.mockClear();
        await route.dropUnreferencedBlob("k1");
        expect(blobStore.delete).not.toHaveBeenCalled();
    });
});
