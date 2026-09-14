///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { DEFAULT_PLUGIN_REGISTRY, NpmRegistryClient, RegistryRequestError } from "../../src/plugins/NpmRegistryClient.js";
import { PLUGIN_API_VERSION } from "../../src/plugins/PluginUtils.js";

const packument = {
    name: "@rapidmx/activesync",
    "dist-tags": { latest: "1.1.0", beta: "2.0.0-beta.1" },
    time: { "1.0.0": "2026-01-01T00:00:00Z", "1.1.0": "2026-02-01T00:00:00Z", "2.0.0-beta.1": "2026-03-01T00:00:00Z" },
    versions: {
        "1.0.0": { name: "@rapidmx/activesync", version: "1.0.0" },
        "1.1.0": {
            name: "@rapidmx/activesync",
            version: "1.1.0",
            description: "EAS",
            dist: { integrity: "sha512-abc" },
            peerDependencies: { "@rapidmx/restapi": "0.8.x" },
            rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "Exchange ActiveSync" } },
        },
        "2.0.0-beta.1": { version: "2.0.0-beta.1" },
    },
};

function mockFetch(response: Partial<Response> | Error) {
    const fn = vi.fn(async () => {
        if (response instanceof Error) {
            throw response;
        }
        return response as Response;
    });
    vi.stubGlobal("fetch", fn);
    return fn;
}

describe("NpmRegistryClient", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("requests the scoped packument from the default registry without auth", async () => {
        const fetchMock = mockFetch({ status: 200, ok: true, json: async () => packument });
        await new NpmRegistryClient().getPackage("@rapidmx/activesync");
        expect(fetchMock).toHaveBeenCalledWith(`${DEFAULT_PLUGIN_REGISTRY}/@rapidmx%2factivesync`, { headers: { Accept: "application/json" } });
    });

    it("sends a bearer token to a configured registry", async () => {
        const fetchMock = mockFetch({ status: 200, ok: true, json: async () => packument });
        await new NpmRegistryClient("https://npm.example.com/", "tok").getPackage("plain");
        expect(fetchMock).toHaveBeenCalledWith("https://npm.example.com/plain", {
            headers: { Accept: "application/json", Authorization: "Bearer tok" },
        });
    });

    it("lists versions newest first with the latest tag", async () => {
        mockFetch({ status: 200, ok: true, json: async () => packument });
        expect(await new NpmRegistryClient().getPackage("@rapidmx/activesync")).toEqual({
            name: "@rapidmx/activesync",
            latest: "1.1.0",
            versions: ["2.0.0-beta.1", "1.1.0", "1.0.0"],
        });
    });

    it("tolerates a packument without versions, times or tags", async () => {
        mockFetch({ status: 200, ok: true, json: async () => ({ versions: { "1.0.0": {}, "0.9.0": {} } }) });
        expect(await new NpmRegistryClient().getPackage("x")).toEqual({ name: "x", latest: undefined, versions: ["1.0.0", "0.9.0"] });
        mockFetch({ status: 200, ok: true, json: async () => ({}) });
        expect(await new NpmRegistryClient().getPackage("x")).toEqual({ name: "x", latest: undefined, versions: [] });
    });

    it("resolves dist-tags and exact versions to their details", async () => {
        mockFetch({ status: 200, ok: true, json: async () => packument });
        const client = new NpmRegistryClient();
        expect(await client.getVersion("@rapidmx/activesync")).toEqual({
            name: "@rapidmx/activesync",
            version: "1.1.0",
            description: "EAS",
            integrity: "sha512-abc",
            peerDependencies: { "@rapidmx/restapi": "0.8.x" },
            manifest: { apiVersion: PLUGIN_API_VERSION, displayName: "Exchange ActiveSync", description: undefined, settings: [] },
        });
        const beta = await client.getVersion("@rapidmx/activesync", "beta");
        expect(beta).toEqual(expect.objectContaining({ name: "@rapidmx/activesync", version: "2.0.0-beta.1", integrity: undefined, peerDependencies: {} }));
        expect(beta!.manifest).toMatch(/not a RapidMX plugin/);
        expect(await client.getVersion("@rapidmx/activesync", "9.9.9")).toBeUndefined();
    });

    it("resolves a version from a packument with no tags or versions as missing", async () => {
        mockFetch({ status: 200, ok: true, json: async () => ({}) });
        expect(await new NpmRegistryClient().getVersion("x", "1.0.0")).toBeUndefined();
    });

    it("resolves undefined for an unknown package", async () => {
        mockFetch({ status: 404, ok: false });
        expect(await new NpmRegistryClient().getPackage("nope")).toBeUndefined();
        expect(await new NpmRegistryClient().getVersion("nope")).toBeUndefined();
    });

    it("throws a RegistryRequestError for HTTP and network failures", async () => {
        mockFetch({ status: 503, ok: false });
        const httpError = await new NpmRegistryClient().getPackage("x").catch((err) => err);
        expect(httpError).toBeInstanceOf(RegistryRequestError);
        expect(httpError.status).toBe(503);

        mockFetch(new Error("ECONNREFUSED"));
        const networkError = await new NpmRegistryClient().getVersion("x").catch((err) => err);
        expect(networkError).toBeInstanceOf(RegistryRequestError);
        expect(networkError.message).toMatch(/ECONNREFUSED/);
        expect(networkError.status).toBeUndefined();
    });
});

describe("NpmRegistryClient.searchPlugins", () => {
    afterEach(() => vi.unstubAllGlobals());

    function page(names: string[], extra: Record<string, unknown> = {}) {
        return { objects: names.map((name) => ({ package: { name, version: "1.0.0", description: `${name} desc`, date: "2026-09-01T00:00:00.000Z", ...extra } })) };
    }

    it("keeps only packages in the scope whose names end in -plugin, sorted by name", async () => {
        const fetchMock = vi.fn(async () => ({
            status: 200,
            ok: true,
            json: async () => ({
                objects: [
                    ...page(["@rapidmx/mapi-plugin", "@rapidmx/restapi", "@other/x-plugin", "@rapidmx/activesync-plugin"]).objects,
                    { package: { version: "1.0.0" } },
                    {},
                ],
            }),
        }));
        vi.stubGlobal("fetch", fetchMock);
        const results = await new NpmRegistryClient("https://npm.example.com/", "tok").searchPlugins("rapidmx");
        expect(results.map((r) => r.name)).toEqual(["@rapidmx/activesync-plugin", "@rapidmx/mapi-plugin"]);
        expect(results[0]).toEqual({ name: "@rapidmx/activesync-plugin", version: "1.0.0", description: "@rapidmx/activesync-plugin desc", date: "2026-09-01T00:00:00.000Z" });
        expect(fetchMock).toHaveBeenCalledWith("https://npm.example.com/-/v1/search?text=scope%3Arapidmx&size=250&from=0", {
            headers: { Accept: "application/json", Authorization: "Bearer tok" },
        });
    });

    it("pages through full result pages, stops at a short one, and treats a missing body as no results", async () => {
        const full = page(Array.from({ length: 250 }, (_, i) => `@acme/p${String(i).padStart(3, "0")}-plugin`));
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({ status: 200, ok: true, json: async () => full })
            .mockResolvedValueOnce({ status: 200, ok: true, json: async () => page(["@acme/zz-plugin"]) });
        vi.stubGlobal("fetch", fetchMock);
        expect(await new NpmRegistryClient().searchPlugins("@acme")).toHaveLength(251);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect((fetchMock.mock.calls[1] as any[])[0]).toContain("from=250");

        vi.stubGlobal("fetch", vi.fn(async () => ({ status: 404, ok: false })));
        expect(await new NpmRegistryClient().searchPlugins("@acme")).toEqual([]);
    });

    it("stops paging at the result cap even if the registry keeps returning full pages", async () => {
        const full = page(Array.from({ length: 250 }, (_, i) => `@acme/p${i}-plugin`));
        const fetchMock = vi.fn(async () => ({ status: 200, ok: true, json: async () => full }));
        vi.stubGlobal("fetch", fetchMock);
        await new NpmRegistryClient().searchPlugins("@acme");
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });
});
