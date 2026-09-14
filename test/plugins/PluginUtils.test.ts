///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import { PluginManifest } from "../../src/models/types.js";
import {
    computePluginStateHash,
    defaultPluginSettings,
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

    it.each([
        [undefined, /not a RapidMX plugin/],
        [{ rapidmx: { plugin: "nope" } }, /not a RapidMX plugin/],
        [{ rapidmx: { plugin: { apiVersion: 99, displayName: "X" } } }, /plugin API version 99/],
        [{ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: " " } } }, /no displayName/],
        [{ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X", settings: {} } } }, /must be a list/],
        [{ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X", settings: [null] } } }, /key and a label/],
        [{ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X", settings: [{ key: "k", label: "L", type: "date" }] } } }, /unknown type 'date'/],
        [{ rapidmx: { plugin: { apiVersion: PLUGIN_API_VERSION, displayName: "X", settings: [{ key: "k", label: "L", type: "select" }] } } }, /select with no options/],
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
