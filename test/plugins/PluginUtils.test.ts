///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import { PluginManifest } from "../../src/models/types.js";
import {
    computePluginStateHash,
    defaultPluginSettings,
    findPluginNamespace,
    isExactVersion,
    isNewerVersion,
    missingRequiredSettings,
    isValidPackageName,
    normalizeAllowedPackages,
    normalizePluginNamespaces,
    matchesAllowedPackage,
    parsePluginManifest,
    PLUGIN_API_VERSION,
    validatePluginSettings,
} from "../../src/plugins/PluginUtils.js";
import { isMailboxScopedData, MailboxScopedData, PluginRegistry } from "../../src/plugins/PluginRegistry.js";

const manifest: PluginManifest = {
    apiVersion: PLUGIN_API_VERSION,
    displayName: "Test",
    settings: [
        { key: "a:number", label: "Number", type: "number", default: 5, min: 1, max: 10 },
        { key: "a:bool", label: "Bool", type: "boolean" },
        { key: "a:text", label: "Text", type: "string" },
        { key: "a:pick", label: "Pick", type: "select", options: [{ value: "x", label: "X" }] },
        { key: "a:required", label: "Required", type: "string", required: true, default: "dflt" },
    ],
};

describe("parsePluginManifest", () => {
    it("returns the manifest for a valid plugin package", () => {
        const parsed = parsePluginManifest({ rapidmx: { plugin: { ...manifest, description: "Desc", extra: true } } });
        expect(parsed).toEqual({ ...manifest, description: "Desc" });
    });

    it("defaults settings to an empty list and ignores a non-string description", () => {
        expect(parsePluginManifest({ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X", description: 3 } } })).toEqual({
            apiVersion: PLUGIN_API_VERSION,
            displayName: "X",
            description: undefined,
            settings: [],
        });
    });

    it("keeps a non-empty requires map", () => {
        const requires = { "@rapidmx/a": "^1.0.0-beta.2", "@rapidmx/b": "1.x" };
        expect(parsePluginManifest({ name: "@rapidmx/x", rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X", requires } } })).toEqual(
            expect.objectContaining({ requires }),
        );
        expect(parsePluginManifest({ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X", requires: {} } } })).not.toHaveProperty("requires");
    });

    it("keeps mailboxScopedData when declared", () => {
        for (const mailboxScopedData of [true, false]) {
            expect(parsePluginManifest({ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X", mailboxScopedData } } })).toEqual(
                expect.objectContaining({ mailboxScopedData }),
            );
        }
        expect(parsePluginManifest({ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X" } } })).not.toHaveProperty("mailboxScopedData");
    });

    it.each([
        [undefined, /not a RapidMX plugin/],
        [{ rapidmx: { plugin: "nope" } }, /not a RapidMX plugin/],
        [{ rapidmx: { plugin: { apiVersion: 99, displayName: "X" } } }, /plugin API version 99/],
        [{ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: " " } } }, /no displayName/],
        [{ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X", settings: {} } } }, /must be a list/],
        [{ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X", settings: [null] } } }, /key and a label/],
        [{ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X", settings: [{ key: "k", label: "L", type: "date" }] } } }, /unknown type 'date'/],
        [{ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X", settings: [{ key: "k", label: "L", type: "select" }] } } }, /select with no options/],
        [{ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X", requires: ["@rapidmx/a"] } } }, /requires must map/],
        [{ name: "@rapidmx/x", rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X", requires: { "@rapidmx/x": "^1.0.0" } } } }, /requires itself/],
        [{ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X", requires: { "@rapidmx/a": "not a range!" } } } }, /@rapidmx\/a with an invalid version range/],
        [{ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X", requires: { "@rapidmx/a": 1 } } } }, /invalid version range/],
        [{ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X", requires: { "@rapidmx/a?x": "1" } } } }, /requires "@rapidmx\/a\?x", which isn't a valid package name/],
        [{ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X", requires: { constructor: "1" } } } }, /requires "constructor", which isn't a valid/],
        [JSON.parse('{"rapidmx": {"plugin": {"apiVersion": 1, "displayName": "X", "requires": {"__proto__": "1"}}}}'), /requires "__proto__"/],
        [{ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X", settings: [{ key: "k", label: "L", type: "string" }, { key: "k", label: "M", type: "number" }] } } }, /'k' is declared more than once/],
        [{ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X", settings: [{ key: "prototype", label: "L", type: "string" }] } } }, /'prototype' is a reserved key/],
        [{ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X", settings: [{ key: "k", label: "L", type: "select", options: [null] }] } } }, /option without a value and a label/],
        [{ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X", settings: [{ key: "k", label: "L", type: "select", options: [{ value: 1, label: "One" }] }] } } }, /option without a value/],
        [{ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X", settings: [{ key: "k", label: "L", type: "number", default: "5" }] } } }, /'k' has an invalid default: 'L' must be a number/],
        [{ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X", settings: [{ key: "k", label: "L", type: "number", default: 50, max: 10 }] } } }, /invalid default: 'L' must be at most 10/],
        [{ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X", settings: [{ key: "k", label: "L", type: "boolean", default: "true" }] } } }, /invalid default/],
        [{ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X", settings: [{ key: "k", label: "L", type: "select", options: [{ value: "a", label: "A" }], default: "b" }] } } }, /invalid default: 'L' must be one of: a/],
        [{ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X", mailboxScopedData: "yes" } } }, /mailboxScopedData must be true or false/],
    ])("rejects %j", (pkg, message) => {
        expect(parsePluginManifest(pkg)).toMatch(message);
    });
});

describe("matchesAllowedPackage", () => {
    it("matches scope wildcards without crossing a slash, and exact names", () => {
        expect(matchesAllowedPackage("@rapidmx/activesync", ["@rapidmx/*"])).toBe(true);
        expect(matchesAllowedPackage("@rapidmx.evil/x", ["@rapidmx/*"])).toBe(false);
        expect(matchesAllowedPackage("@other/x", ["@rapidmx/*"])).toBe(false);
        expect(matchesAllowedPackage("left-pad", ["@rapidmx/*", "left-pad"])).toBe(true);
        expect(matchesAllowedPackage("left-pad2", ["left-pad"])).toBe(false);
        expect(matchesAllowedPackage("anything", [])).toBe(false);
    });

    it("never matches a name that isn't a valid package name", () => {
        expect(matchesAllowedPackage("@rapidmx/activesync-plugin?x", ["@rapidmx/*"])).toBe(false);
        expect(matchesAllowedPackage("@rapidmx/a#b", ["@rapidmx/*"])).toBe(false);
    });
});

describe("isValidPackageName", () => {
    it.each([
        ["@rapidmx/activesync-plugin", true],
        ["left-pad", true],
        ["a.b_c~d", true],
        ["constructor", true],
        ["@rapidmx/activesync-plugin?x", false],
        ["@rapidmx/a#b", false],
        ["@rapidmx/a\tb", false],
        ["@rapidmx/a\nb", false],
        ["Upper", false],
        ["_private", false],
        ["@scope/", false],
        ["a/b", false],
        ["", false],
        ["a".repeat(215), false],
        [5, false],
    ])("%j valid: %s", (name, expected) => {
        expect(isValidPackageName(name)).toBe(expected);
    });
});

describe("normalizeAllowedPackages", () => {
    it("keeps package names and scoped wildcards from a list, de-duplicated", () => {
        const logger = { warn: vi.fn() };
        expect(normalizeAllowedPackages(["@rapidmx/*", " left-pad ", "@acme/crm-*", "@rapidmx/*"], logger)).toEqual(["@rapidmx/*", "left-pad", "@acme/crm-*"]);
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it("reads a comma-separated or JSON string rather than spreading it into characters", () => {
        expect(normalizeAllowedPackages("@acme/*")).toEqual(["@acme/*"]);
        expect(normalizeAllowedPackages("@acme/*, left-pad")).toEqual(["@acme/*", "left-pad"]);
        expect(normalizeAllowedPackages('["@acme/*"]')).toEqual(["@acme/*"]);
        expect(normalizeAllowedPackages('{"not": "a list"}')).toEqual([]);
    });

    it("drops, with a warning, wildcards that aren't inside one scope and anything that isn't a package name", () => {
        const logger = { warn: vi.fn() };
        const value = ["*", "left-*", "@*/x", "@acme*/x", "@acme/*/x", "Bad Name", 7, null, "[not json", "@ok/*"];
        expect(normalizeAllowedPackages(value, logger)).toEqual(["@ok/*"]);
        expect(logger.warn).toHaveBeenCalledTimes(9);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/allowed_packages entry "\*"/));
        expect(normalizeAllowedPackages("[not json, *", logger)).toEqual([]);
        expect(normalizeAllowedPackages({ a: 1 }, logger)).toEqual([]);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Ignoring system:plugins:allowed_packages: it must be a list/));
        expect(normalizeAllowedPackages(undefined)).toEqual([]);
    });
});

describe("defaultPluginSettings", () => {
    it("collects declared defaults", () => {
        expect(defaultPluginSettings(manifest)).toEqual({ "a:number": 5, "a:required": "dflt" });
        expect(defaultPluginSettings({ apiVersion: 1, displayName: "X" })).toEqual({});
    });
});

describe("validatePluginSettings", () => {
    it("returns only valid, non-empty values", () => {
        expect(validatePluginSettings(manifest, { "a:number": 3, "a:bool": false, "a:text": "", "a:pick": "x" })).toEqual({
            "a:number": 3,
            "a:bool": false,
            "a:pick": "x",
        });
    });

    it.each([
        [{ unknown: 1 }, /not a setting/],
        [{ "a:number": "3" }, /must be a number/],
        [{ "a:number": 0 }, /at least 1/],
        [{ "a:number": 11 }, /at most 10/],
        [{ "a:bool": "true" }, /true or false/],
        [{ "a:pick": "y" }, /one of: x/],
        [{ "a:text": 5 }, /must be text/],
        [{ "a:required": null }, /'Required' is required/],
    ])("rejects %j", (values, message) => {
        expect(() => validatePluginSettings(manifest, values)).toThrow(message);
    });

    it("requires a required setting with no default to be supplied", () => {
        const strict: PluginManifest = { apiVersion: 1, displayName: "X", settings: [{ key: "k", label: "Key", type: "string", required: true }] };
        expect(() => validatePluginSettings(strict, {})).toThrow(/'Key' is required/);
        expect(validatePluginSettings(strict, { k: "v" })).toEqual({ k: "v" });
        expect(validatePluginSettings({ apiVersion: 1, displayName: "X" }, {})).toEqual({});
    });
});

describe("computePluginStateHash", () => {
    it("ignores order and disabled plugins, and changes with version or settings", () => {
        const a = { name: "a", packageVersion: "1.0.0", enabled: true, settings: { x: 1, y: 2 } };
        const b = { name: "b", packageVersion: "1.0.0", enabled: true, settings: {} };
        const off = { name: "c", packageVersion: "1.0.0", enabled: false, settings: {} };
        const base = computePluginStateHash([a, b]);
        expect(computePluginStateHash([b, off, { ...a, settings: { y: 2, x: 1 } }])).toBe(base);
        expect(computePluginStateHash([{ ...a, packageVersion: "1.0.1" }, b])).not.toBe(base);
        expect(computePluginStateHash([{ ...a, settings: { x: 3, y: 2 } }, b])).not.toBe(base);
        expect(computePluginStateHash([{ ...b, settings: undefined as any }])).toBe(computePluginStateHash([b]));
        expect(computePluginStateHash([])).toMatch(/^[0-9a-f]{64}$/);
    });

    it("changes with the recorded integrity, treating an unset one (undefined or SQL's null) alike", () => {
        const a = { name: "a", packageVersion: "1.0.0", enabled: true, settings: {} };
        const base = computePluginStateHash([a]);
        expect(computePluginStateHash([{ ...a, integrity: null }])).toBe(base);
        expect(computePluginStateHash([{ ...a, integrity: "sha512-x" }])).not.toBe(base);
        expect(computePluginStateHash([{ ...a, integrity: "sha512-x" }])).not.toBe(computePluginStateHash([{ ...a, integrity: "sha512-y" }]));
    });
});

describe("isExactVersion", () => {
    it("accepts only a normalized semver version", () => {
        for (const version of ["1.0.0", "2.3.4-beta.1"]) {
            expect(isExactVersion(version)).toBe(true);
        }
        for (const version of ["v1.0.0", " 1.0.0", "1.0.0+build", "=1.0.0", "latest", "github:x/y", 1, undefined]) {
            expect(isExactVersion(version)).toBe(false);
        }
    });
});

describe("missingRequiredSettings", () => {
    it("lists required settings with neither a default nor a saved value", () => {
        const strict: PluginManifest = {
            apiVersion: 1,
            displayName: "X",
            settings: [
                { key: "a", label: "A", type: "string", required: true },
                { key: "b", label: "B", type: "string", required: true, default: "x" },
                { key: "c", label: "C", type: "string" },
                { key: "d", label: "D", type: "number", required: true },
            ],
        };
        expect(missingRequiredSettings(strict).map((setting) => setting.key)).toEqual(["a", "d"]);
        expect(missingRequiredSettings(strict, { a: "", d: 0 }).map((setting) => setting.key)).toEqual(["a"]);
        expect(missingRequiredSettings(strict, { a: "v", d: null } as any).map((setting) => setting.key)).toEqual(["d"]);
        expect(missingRequiredSettings(undefined)).toEqual([]);
        expect(missingRequiredSettings({ apiVersion: 1, displayName: "X" })).toEqual([]);
    });
});

describe("PluginRegistry", () => {
    afterEach(() => PluginRegistry.setLoaded([]));

    it("reports loaded plugins without exposing its own state", () => {
        expect(PluginRegistry.list()).toEqual([]);
        const loaded = [{ name: "@rapidmx/activesync", version: "1.0.0" }];
        PluginRegistry.setLoaded(loaded);
        loaded[0].version = "mutated";
        expect(PluginRegistry.isActive("@rapidmx/activesync")).toBe(true);
        expect(PluginRegistry.isActive("@rapidmx/mapi")).toBe(false);
        const listed = PluginRegistry.list();
        listed[0].version = "mutated";
        expect(PluginRegistry.list()).toEqual([{ name: "@rapidmx/activesync", version: "1.0.0" }]);
    });

    it("marks mailbox-scoped models", () => {
        @MailboxScopedData()
        class Marked {}
        class Unmarked {}
        expect(isMailboxScopedData(Marked)).toBe(true);
        expect(isMailboxScopedData(Unmarked)).toBe(false);
        expect(isMailboxScopedData({})).toBe(false);
    });
});

describe("plugin namespaces", () => {
    it("normalizes strings and objects, dropping invalid entries and duplicates", () => {
        expect(
            normalizePluginNamespaces([
                "@rapidmx",
                "other",
                { name: "@acme", registry: "https://npm.acme.test", token: "t" },
                { name: "@rapidmx", registry: "https://ignored.test" },
                { name: "Bad Scope" },
                { registry: "https://no-name.test" },
                { name: "@empty", registry: "", token: "" },
                5,
                null,
            ]),
        ).toEqual([
            { name: "@rapidmx", registry: undefined, token: undefined },
            { name: "@other", registry: undefined, token: undefined },
            { name: "@acme", registry: "https://npm.acme.test", token: "t" },
            { name: "@empty", registry: undefined, token: undefined },
        ]);
    });

    it("reads a comma-separated or JSON string, as an environment variable gives it, and warns about what it drops", () => {
        const logger = { warn: vi.fn() };
        expect(normalizePluginNamespaces("@rapidmx, acme,,", logger).map((ns) => ns.name)).toEqual(["@rapidmx", "@acme"]);
        expect(normalizePluginNamespaces('["@one", {"name": "@two", "registry": "https://two.test"}]', logger)).toEqual([
            { name: "@one", registry: undefined, token: undefined },
            { name: "@two", registry: "https://two.test", token: undefined },
        ]);
        expect(logger.warn).not.toHaveBeenCalled();
        expect(normalizePluginNamespaces("@ok, Bad Scope", logger).map((ns) => ns.name)).toEqual(["@ok"]);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/namespaces entry "Bad Scope"/));
        expect(normalizePluginNamespaces(42, logger)).toEqual([]);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Ignoring system:plugins:namespaces: it must be a list/));
        expect(normalizePluginNamespaces(undefined)).toEqual([]);
        expect(normalizePluginNamespaces(null)).toEqual([]);
    });

    it("finds the namespace a package belongs to", () => {
        const namespaces = normalizePluginNamespaces(["@rapidmx", "@acme"]);
        expect(findPluginNamespace("@acme/crm-plugin", namespaces)?.name).toBe("@acme");
        expect(findPluginNamespace("@acmeish/crm-plugin", namespaces)).toBeUndefined();
    });
});

describe("isNewerVersion", () => {
    it.each([
        ["1.0.1", "1.0.0", true],
        ["1.1.0", "1.0.9", true],
        ["2.0.0", "1.99.99", true],
        ["1.0.0", "1.0.0", false],
        ["1.0.0", "1.0.1", false],
        ["1.0.0", "1.0.0-beta.3", true],
        ["1.0.0-beta.3", "1.0.0", false],
        ["1.0.0-beta.10", "1.0.0-beta.9", true],
        ["1.0.0-beta.2", "1.0.0-beta.2", false],
        ["1.0.0-beta.2.1", "1.0.0-beta.2", true],
        ["1.0.0-beta.2", "1.0.0-beta.2.1", false],
        ["1.0.0-rc", "1.0.0-beta", true],
        ["v1.2.0+build", "1.1.0", true],
        ["latest", "1.0.0", false],
        ["1.0.0", "nope", false],
        [undefined as any, "1.0.0", false],
    ])("%s newer than %s: %s", (candidate, current, expected) => {
        expect(isNewerVersion(candidate, current)).toBe(expected);
    });
});
