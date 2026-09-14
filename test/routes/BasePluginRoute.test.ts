///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The Redis and registry-client paths the HTTP suites replace with test doubles.
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
        expect(route.listNamespaces()).toEqual([{ name: "@rapidmx", registry: undefined }, { name: "@acme", registry: "https://npm.acme.test" }]);
    });
});
