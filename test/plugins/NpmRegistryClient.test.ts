///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { DEFAULT_PLUGIN_REGISTRY, DEFAULT_REGISTRY_TIMEOUT_MS, NpmRegistryClient, RegistryRequestError } from "../../src/plugins/NpmRegistryClient.js";
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

/** A real `Response` with a JSON body (or `null` for none). */
function json(body: unknown, status: number = 200): Response {
    return new Response(body === null ? null : JSON.stringify(body), { status });
}

function mockFetch(response: Response | Error | (() => Response)) {
    const fn = vi.fn(async (..._args: any[]) => {
        if (response instanceof Error) {
            throw response;
        }
        return typeof response === "function" ? response() : response;
    });
    vi.stubGlobal("fetch", fn);
    return fn;
}

describe("NpmRegistryClient", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("requests the scoped packument from the default registry without auth, with a timeout", async () => {
        const fetchMock = mockFetch(() => json(packument));
        await new NpmRegistryClient().getPackage("@rapidmx/activesync");
        expect(fetchMock).toHaveBeenCalledWith(`${DEFAULT_PLUGIN_REGISTRY}/@rapidmx%2factivesync`, {
            headers: { Accept: "application/json" },
            signal: expect.any(AbortSignal),
        });
        expect(DEFAULT_REGISTRY_TIMEOUT_MS).toBe(15_000);
    });

    it("sends a bearer token to a configured registry", async () => {
        const fetchMock = mockFetch(() => json({ ...packument, name: "plain" }));
        await new NpmRegistryClient("https://npm.example.com/", "tok").getPackage("plain");
        expect(fetchMock).toHaveBeenCalledWith("https://npm.example.com/plain", {
            headers: { Accept: "application/json", Authorization: "Bearer tok" },
            signal: expect.any(AbortSignal),
        });
    });

    it("encodes each part of the name, so it can't add a query, fragment or path to the URL", async () => {
        const fetchMock = mockFetch(() => json({ name: "@a?b/c#d" }));
        await new NpmRegistryClient("https://npm.example.com").getPackage("@a?b/c#d");
        expect((fetchMock.mock.calls[0] as any[])[0]).toBe("https://npm.example.com/@a%3Fb%2fc%23d");
        mockFetch(() => json({ name: "x?y" }));
        await new NpmRegistryClient("https://npm.example.com").getPackage("x?y");
    });

    it("refuses a packument for a different package than the one requested", async () => {
        mockFetch(() => json({ ...packument, name: "@rapidmx/other" }));
        const err = await new NpmRegistryClient().getPackage("@rapidmx/activesync").catch((e) => e);
        expect(err).toBeInstanceOf(RegistryRequestError);
        expect(err.message).toMatch(/answered with package "@rapidmx\/other" for @rapidmx\/activesync/);
        mockFetch(() => json({ versions: {} }));
        await expect(new NpmRegistryClient().getVersion("x")).rejects.toThrow(/answered with package undefined for x/);
    });

    it("lists versions newest first with the latest tag", async () => {
        mockFetch(() => json(packument));
        expect(await new NpmRegistryClient().getPackage("@rapidmx/activesync")).toEqual({
            name: "@rapidmx/activesync",
            latest: "1.1.0",
            versions: ["2.0.0-beta.1", "1.1.0", "1.0.0"],
        });
    });

    it("tolerates a packument without versions, times or tags", async () => {
        mockFetch(() => json({ name: "x", versions: { "1.0.0": {}, "0.9.0": {} } }));
        expect(await new NpmRegistryClient().getPackage("x")).toEqual({ name: "x", latest: undefined, versions: ["1.0.0", "0.9.0"] });
        mockFetch(() => json({ name: "x" }));
        expect(await new NpmRegistryClient().getPackage("x")).toEqual({ name: "x", latest: undefined, versions: [] });
    });

    it("resolves dist-tags and exact versions to their details, fetching the packument once", async () => {
        const fetchMock = mockFetch(() => json(packument));
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
        expect((await client.getPackage("@rapidmx/activesync"))!.latest).toBe("1.1.0");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("fetches again after a failed request rather than remembering the failure", async () => {
        const fetchMock = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET")).mockImplementation(async () => json(packument));
        vi.stubGlobal("fetch", fetchMock);
        const client = new NpmRegistryClient();
        await expect(client.getPackage("@rapidmx/activesync")).rejects.toThrow(/ECONNRESET/);
        expect((await client.getPackage("@rapidmx/activesync"))!.latest).toBe("1.1.0");
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("resolves a version from a packument with no tags or versions as missing", async () => {
        mockFetch(() => json({ name: "x" }));
        expect(await new NpmRegistryClient().getVersion("x", "1.0.0")).toBeUndefined();
    });

    it("resolves undefined for an unknown package", async () => {
        mockFetch(() => json(null, 404));
        expect(await new NpmRegistryClient().getPackage("nope")).toBeUndefined();
        expect(await new NpmRegistryClient().getVersion("nope")).toBeUndefined();
    });

    it("throws a RegistryRequestError for HTTP and network failures", async () => {
        mockFetch(() => json(null, 503));
        const httpError = await new NpmRegistryClient().getPackage("x").catch((err) => err);
        expect(httpError).toBeInstanceOf(RegistryRequestError);
        expect(httpError.status).toBe(503);

        mockFetch(new Error("ECONNREFUSED"));
        const networkError = await new NpmRegistryClient().getVersion("x").catch((err) => err);
        expect(networkError).toBeInstanceOf(RegistryRequestError);
        expect(networkError.message).toMatch(/ECONNREFUSED/);
        expect(networkError.status).toBeUndefined();
    });

    it("gives up on a registry that doesn't answer in time", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(
                (_url: string, init: RequestInit) =>
                    new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))),
            ),
        );
        const err = await new NpmRegistryClient(undefined, undefined, { timeoutMs: 20 }).getPackage("x").catch((e) => e);
        expect(err).toBeInstanceOf(RegistryRequestError);
        expect(err.message).toBe("The plugin registry didn't respond within 20 ms.");
    });

    it("refuses a body larger than the limit, whether or not it declares its length", async () => {
        const big = { name: "x", description: "y".repeat(2000) };
        mockFetch(() => json(big));
        await expect(new NpmRegistryClient(undefined, undefined, { maxBodyBytes: 1000 }).getPackage("x")).rejects.toThrow(/larger than 1000 bytes/);

        mockFetch(() => new Response(JSON.stringify(big), { headers: { "content-length": "999999" } }));
        await expect(new NpmRegistryClient(undefined, undefined, { maxBodyBytes: 1000 }).getPackage("x")).rejects.toThrow(/larger than 1000 bytes/);

        // A stream without a declared length, delivered in several chunks.
        const chunks = [JSON.stringify(big).slice(0, 800), JSON.stringify(big).slice(800)];
        mockFetch(
            () =>
                new Response(
                    new ReadableStream({
                        pull(controller) {
                            const chunk = chunks.shift();
                            if (chunk === undefined) {
                                controller.close();
                            } else {
                                controller.enqueue(new TextEncoder().encode(chunk));
                            }
                        },
                    }),
                ),
        );
        await expect(new NpmRegistryClient(undefined, undefined, { maxBodyBytes: 1000 }).getPackage("x")).rejects.toThrow(/larger than 1000 bytes/);
    });

    it("reports a body that isn't JSON, or is missing", async () => {
        mockFetch(() => new Response("<html>"));
        await expect(new NpmRegistryClient().getPackage("x")).rejects.toThrow(/something other than JSON/);
        mockFetch(() => new Response(null, { status: 200 }));
        await expect(new NpmRegistryClient().getPackage("x")).rejects.toThrow(/something other than JSON/);
    });
});

describe("NpmRegistryClient.searchPlugins", () => {
    afterEach(() => vi.unstubAllGlobals());

    function page(names: string[], extra: Record<string, unknown> = {}) {
        return { objects: names.map((name) => ({ package: { name, version: "1.0.0", description: `${name} desc`, date: "2026-09-01T00:00:00.000Z", ...extra } })) };
    }

    it("keeps only packages in the scope whose names end in -plugin and have a version, sorted by name", async () => {
        const fetchMock = vi.fn(async (..._args: any[]) =>
            json({
                objects: [
                    ...page(["@rapidmx/mapi-plugin", "@rapidmx/restapi", "@other/x-plugin", "@rapidmx/activesync-plugin"]).objects,
                    { package: { name: "@rapidmx/unversioned-plugin" } },
                    { package: { version: "1.0.0" } },
                    {},
                ],
            }),
        );
        vi.stubGlobal("fetch", fetchMock);
        const results = await new NpmRegistryClient("https://npm.example.com/", "tok").searchPlugins("rapidmx");
        expect(results.map((r) => r.name)).toEqual(["@rapidmx/activesync-plugin", "@rapidmx/mapi-plugin"]);
        expect(results[0]).toEqual({ name: "@rapidmx/activesync-plugin", version: "1.0.0", description: "@rapidmx/activesync-plugin desc", date: "2026-09-01T00:00:00.000Z" });
        expect(fetchMock).toHaveBeenCalledWith("https://npm.example.com/-/v1/search?text=scope%3Arapidmx&size=250&from=0", {
            headers: { Accept: "application/json", Authorization: "Bearer tok" },
            signal: expect.any(AbortSignal),
        });
    });

    it("pages through full result pages, stops at a short one, and treats a missing body as no results", async () => {
        const full = page(Array.from({ length: 250 }, (_, i) => `@acme/p${String(i).padStart(3, "0")}-plugin`));
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(json(full))
            .mockResolvedValueOnce(json(page(["@acme/zz-plugin"])));
        vi.stubGlobal("fetch", fetchMock);
        expect(await new NpmRegistryClient().searchPlugins("@acme")).toHaveLength(251);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect((fetchMock.mock.calls[1] as any[])[0]).toContain("from=250");

        vi.stubGlobal("fetch", vi.fn(async () => json(null, 404)));
        expect(await new NpmRegistryClient().searchPlugins("@acme")).toEqual([]);
    });

    it("stops paging at the result cap even if the registry keeps returning full pages", async () => {
        const full = page(Array.from({ length: 250 }, (_, i) => `@acme/p${i}-plugin`));
        const fetchMock = vi.fn(async () => json(full));
        vi.stubGlobal("fetch", fetchMock);
        await new NpmRegistryClient().searchPlugins("@acme");
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });
});
