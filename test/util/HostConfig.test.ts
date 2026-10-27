///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import nconf from "nconf";
import { HostConfig, HostConfigSource, HostConfigUninstall } from "../../src/util/HostConfig.js";

/** A live configuration like the server's: a layer written at run time (as the integrations layer is) over the defaults. */
function liveConfig(defaults: Record<string, unknown>): nconf.Provider {
    const config = new nconf.Provider();
    config.use("memory");
    config.defaults(defaults);
    return config;
}

describe("HostConfig", () => {
    let uninstall: HostConfigUninstall | undefined;

    /** Installs `source` the way the host does, keeping the handle so each test leaves nothing installed. */
    function install(source: HostConfigSource): HostConfigUninstall {
        uninstall = HostConfig.install(source);
        return uninstall;
    }

    afterEach(() => {
        uninstall?.();
        uninstall = undefined;
    });

    it("reads nothing before the host installs its configuration", () => {
        expect(HostConfig.isInstalled()).toBe(false);
        expect(HostConfig.get("integrations:stun:urls")).toBeUndefined();
    });

    it("reads the installed configuration by nconf key", () => {
        install(liveConfig({ integrations: { stun: { urls: ["stun:stun.example.com:3478"] } }, giphy: { api_key: "k" } }));
        expect(HostConfig.isInstalled()).toBe(true);
        expect(HostConfig.get<string[]>("integrations:stun:urls")).toEqual(["stun:stun.example.com:3478"]);
        expect(HostConfig.get("giphy:api_key")).toBe("k");
        expect(HostConfig.get("integrations:missing")).toBeUndefined();
    });

    it("reads at use time, so a value changed after installation is seen at once", () => {
        const config = liveConfig({ integrations: { stun: { urls: ["stun:a.example.com"] } } });
        install(config);
        config.set("integrations:stun:urls", ["stun:b.example.com"]);
        expect(HostConfig.get("integrations:stun:urls")).toEqual(["stun:b.example.com"]);
    });

    it("is read-only: changing what it returned never changes the configuration", () => {
        const config = liveConfig({ integrations: { stun: { urls: ["stun:a.example.com"] } } });
        install(config);
        HostConfig.get<string[]>("integrations:stun:urls")!.push("stun:evil.example.com");
        HostConfig.get<any>("integrations")!.stun.urls = [];
        expect(config.get("integrations:stun:urls")).toEqual(["stun:a.example.com"]);
        expect(HostConfig.get("integrations:stun:urls")).toEqual(["stun:a.example.com"]);
    });

    it("has no way to write through it", () => {
        expect((HostConfig as any).set).toBeUndefined();
    });

    it("refuses a second installation, so a plugin can't swap what every other consumer reads", () => {
        install(liveConfig({ integrations: { stun: { urls: ["stun:a.example.com"] } } }));
        const attacker: HostConfigSource = { get: () => ["stun:attacker.example"] };
        expect(() => HostConfig.install(attacker)).toThrow(/already/);
        expect(HostConfig.get("integrations:stun:urls")).toEqual(["stun:a.example.com"]);
    });

    it("can be uninstalled only through the handle its installation returned", () => {
        expect((HostConfig as any).uninstall).toBeUndefined();
        const remove = install(liveConfig({ a: 1 }));
        remove();
        expect(HostConfig.isInstalled()).toBe(false);
        expect(HostConfig.get("a")).toBeUndefined();

        // A handle from an earlier installation never removes a later one.
        install(liveConfig({ a: 2 }));
        remove();
        expect(HostConfig.get("a")).toBe(2);
    });

    it("keeps the installed source out of reach and can't have its reader replaced", () => {
        install(liveConfig({ a: 1 }));
        expect(Object.keys(HostConfig)).toEqual([]);
        expect((HostConfig as any).source).toBeUndefined();
        expect(Object.isFrozen(HostConfig)).toBe(true);
        expect(() => {
            (HostConfig as any).get = () => "swapped";
        }).toThrow(TypeError);
        expect(HostConfig.get("a")).toBe(1);
    });

    it("takes any source with a get(key), not only nconf", () => {
        const source: HostConfigSource = { get: (key: string) => (key === "x:y" ? 5 : undefined) };
        install(source);
        expect(HostConfig.get("x:y")).toBe(5);
    });

    it("refuses a source without get() and a key that isn't a non-empty string", () => {
        expect(() => HostConfig.install({} as any)).toThrow(TypeError);
        expect(() => HostConfig.install(undefined as any)).toThrow(TypeError);
        install(liveConfig({ a: 1 }));
        expect(() => HostConfig.get("")).toThrow(TypeError);
        expect(() => HostConfig.get(undefined as any)).toThrow(TypeError);
    });
});
