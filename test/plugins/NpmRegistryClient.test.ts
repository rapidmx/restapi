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
