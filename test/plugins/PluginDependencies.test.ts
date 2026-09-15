///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { PluginManifest } from "../../src/models/types.js";
import {
    findDependents,
    findUnmetRequirements,
    orderByDependencies,
    PlannerInstalledPlugin,
    PlannerPackageVersion,
    PlannerRegistry,
    planPluginChange,
    pruneUnmetRequirements,
} from "../../src/plugins/PluginDependencies.js";

const manifest = (displayName: string, requires?: Record<string, string>): PluginManifest => ({ apiVersion: 1, displayName, settings: [], requires });

/** An in-memory registry: package -> version -> manifest (or the reason it isn't a plugin). */
function registry(packages: Record<string, Record<string, PluginManifest | string>>): PlannerRegistry {
    return {
        versions: async (name) => (packages[name] ? Object.keys(packages[name]) : undefined),
        version: async (name, version): Promise<PlannerPackageVersion | undefined> =>
            packages[name]?.[version] === undefined ? undefined : { version, integrity: `sha-${name}@${version}`, manifest: packages[name][version] },
    };
}

const EAS = "@rapidmx/activesync-plugin";
const MAPI = "@rapidmx/mapi-plugin";
const AUTODISCOVER = "@rapidmx/autodiscover-plugin";
const AUTODISCOVER_MANIFEST = manifest("Autodiscover", { [EAS]: "^1.0.0-beta.2", [MAPI]: "^1.0.0" });

const REGISTRY = registry({
    [EAS]: { "1.0.0-beta.1": manifest("Exchange ActiveSync"), "1.0.0-beta.2": manifest("Exchange ActiveSync"), "1.0.0": manifest("Exchange ActiveSync"), "2.0.0": manifest("Exchange ActiveSync") },
    [MAPI]: { "1.0.0": manifest("MAPI over HTTP", { [EAS]: "^1.0.0" }), "1.4.0": manifest("MAPI over HTTP", { [EAS]: "^1.0.0" }) },
});

const row = (name: string, packageVersion: string, enabled: boolean, m?: PluginManifest): PlannerInstalledPlugin => ({ name, packageVersion, enabled, manifest: m });

describe("planPluginChange", () => {
    it("installs missing requirements at the highest version in range, requirements of requirements first", async () => {
        const plan = await planPluginChange([], { name: AUTODISCOVER, version: "1.0.0", manifest: AUTODISCOVER_MANIFEST }, REGISTRY);
        expect(plan.conflicts).toEqual([]);
        expect(plan.enable).toEqual([]);
        expect(plan.install.map((i) => `${i.name}@${i.version}`)).toEqual([`${EAS}@1.0.0`, `${MAPI}@1.4.0`]);
        expect(plan.install[1]).toEqual(expect.objectContaining({ integrity: `sha-${MAPI}@1.4.0`, manifest: expect.objectContaining({ displayName: "MAPI over HTTP" }) }));
    });

    it("installs a prerelease the range asks for", async () => {
        const reg = registry({ [EAS]: { "1.0.0-beta.1": manifest("EAS"), "1.0.0-beta.3": manifest("EAS") } });
        const plan = await planPluginChange([], { name: "x", version: "1.0.0", manifest: manifest("X", { [EAS]: "^1.0.0-beta.2" }) }, reg);
        expect(plan.install.map((i) => i.version)).toEqual(["1.0.0-beta.3"]);
    });

    it("leaves enabled requirements in range alone, and enables disabled ones along with what they require", async () => {
        const installed = [row(EAS, "1.0.0", false), row(MAPI, "1.0.0", false, manifest("MAPI over HTTP", { [EAS]: "^1.0.0" })), row("@rapidmx/other", "1.0.0", true)];
        const plan = await planPluginChange(installed, { name: AUTODISCOVER, version: "1.0.0", manifest: AUTODISCOVER_MANIFEST }, REGISTRY);
        expect(plan).toEqual({ install: [], enable: [EAS, MAPI], conflicts: [] });

        const enabled = await planPluginChange([row(EAS, "1.0.0", true), row(MAPI, "1.4.0", true)], { name: AUTODISCOVER, version: "1.0.0", manifest: AUTODISCOVER_MANIFEST }, REGISTRY);
        expect(enabled).toEqual({ install: [], enable: [], conflicts: [] });
    });

    it("enables a disabled requirement that has no stored manifest", async () => {
        const plan = await planPluginChange([row(EAS, "1.0.0", false)], { name: "x", version: "1.0.0", manifest: manifest("X", { [EAS]: "1" }) }, REGISTRY);
        expect(plan.enable).toEqual([EAS]);
    });

    it("refuses an installed requirement out of range instead of changing its version", async () => {
        const plan = await planPluginChange(
            [row(EAS, "2.0.0", true, manifest("Exchange ActiveSync"))],
            { name: AUTODISCOVER, version: "1.0.0", manifest: AUTODISCOVER_MANIFEST },
            REGISTRY,
        );
        expect(plan.conflicts).toEqual([
            "Autodiscover requires Exchange ActiveSync ^1.0.0-beta.2, but 2.0.0 is installed.",
            "MAPI over HTTP requires Exchange ActiveSync ^1.0.0, but 2.0.0 is installed.",
        ]);
        expect(plan.install.map((i) => i.name)).toEqual([MAPI]);
    });

    it("refuses when two requirements need incompatible versions of the same plugin", async () => {
        const plan = await planPluginChange([], { name: "x", version: "1.0.0", manifest: manifest("X", { [EAS]: "^2.0.0", [MAPI]: "^1.0.0" }) }, REGISTRY);
        expect(plan.conflicts).toEqual([`MAPI over HTTP requires ${EAS} ^1.0.0, but 2.0.0 is being installed.`]);
    });

    it("refuses a version change outside an enabled dependent's range, ignoring disabled and removed dependents", async () => {
        const installed = [
            row(EAS, "1.0.0", true, manifest("Exchange ActiveSync")),
            row(AUTODISCOVER, "1.0.0", true, AUTODISCOVER_MANIFEST),
            row("@rapidmx/off", "1.0.0", false, manifest("Off", { [EAS]: "^1.0.0" })),
            { ...row("@rapidmx/gone", "1.0.0", true, manifest("Gone", { [EAS]: "^1.0.0" })), removed: true },
        ];
        const plan = await planPluginChange(installed, { name: EAS, version: "2.0.0", manifest: manifest("Exchange ActiveSync") }, REGISTRY);
        expect(plan.conflicts).toEqual([`Autodiscover requires ${EAS} ^1.0.0-beta.2, which 2.0.0 doesn't satisfy.`]);

        const fine = await planPluginChange(installed, { name: EAS, version: "1.0.0-beta.2", manifest: manifest("Exchange ActiveSync") }, REGISTRY);
        expect(fine.conflicts).toEqual([]);
    });

    it("reports circular requirements", async () => {
        const reg = registry({ b: { "1.0.0": manifest("B", { a: "1" }) } });
        const plan = await planPluginChange([], { name: "a", version: "1.0.0", manifest: manifest("A", { b: "1" }) }, reg);
        expect(plan.conflicts).toEqual(["a requires b requires a, which is a circular requirement."]);
    });

    it.each<[string, Record<string, Record<string, PluginManifest | string>>, RegExp]>([
        ["isn't in the registry", {}, /requires dep, which isn't in the plugin registry/],
        ["has no version in range", { dep: { "2.0.0": manifest("Dep") } }, /requires dep \^1\.0\.0, but no published version satisfies it/],
        ["isn't a loadable plugin", { dep: { "1.0.0": "This package is not a RapidMX plugin." } }, /requires dep, which can't be installed: This package is not/],
    ])("refuses a requirement that %s", async (_label, packages, message) => {
        const plan = await planPluginChange([], { name: "x", version: "1.0.0", manifest: manifest("X", { dep: "^1.0.0" }) }, registry(packages));
        expect(plan.conflicts).toEqual([expect.stringMatching(message)]);
        expect(plan.install).toEqual([]);
    });

    it("refuses a requirement that isn't allowed, without asking the registry", async () => {
        const reg = registry({});
        const versions = vi.spyOn(reg, "versions");
        const plan = await planPluginChange([], { name: "x", version: "1.0.0", manifest: manifest("X", { [EAS]: "1" }) }, reg, { allowed: () => false });
        expect(plan.conflicts).toEqual([`X requires ${EAS}, which isn't an allowed plugin package on this server.`]);
        expect(versions).not.toHaveBeenCalled();
    });

    it("treats an invalid or unnormalized installed version as out of range", async () => {
        const plan = await planPluginChange([row(EAS, "not-semver", true)], { name: "x", version: "1.0.0", manifest: manifest("X", { [EAS]: "*" }) }, REGISTRY);
        expect(plan.conflicts).toEqual([`X requires ${EAS} *, but not-semver is installed.`]);
        const prefixed = await planPluginChange([row(EAS, "v1.0.0", true)], { name: "x", version: "1.0.0", manifest: manifest("X", { [EAS]: "*" }) }, REGISTRY);
        expect(prefixed.conflicts).toEqual([`X requires ${EAS} *, but v1.0.0 is installed.`]);
    });

    it("never installs an unnormalized published version", async () => {
        const reg = registry({ [EAS]: { "1.0.0": manifest("EAS"), "v1.5.0": manifest("EAS") } });
        const plan = await planPluginChange([], { name: "x", version: "1.0.0", manifest: manifest("X", { [EAS]: "^1.0.0" }) }, reg);
        expect(plan.install.map((i) => i.version)).toEqual(["1.0.0"]);
    });

    it("refuses to enable an installed requirement that isn't allowed", async () => {
        const plan = await planPluginChange([row(EAS, "1.0.0", false)], { name: "x", version: "1.0.0", manifest: manifest("X", { [EAS]: "1" }) }, REGISTRY, {
            allowed: (name) => name !== EAS,
        });
        expect(plan).toEqual({ install: [], enable: [], conflicts: [`X requires ${EAS}, which isn't an allowed plugin package on this server.`] });
    });

    it("refuses to install or enable a requirement whose required settings have no default or saved value", async () => {
        const needsKey = (displayName: string): PluginManifest => ({
            apiVersion: 1,
            displayName,
            settings: [
                { key: "k", label: "API key", type: "string", required: true },
                { key: "r", label: "Region", type: "string", required: true },
                { key: "d", label: "Defaulted", type: "string", required: true, default: "x" },
            ],
        });
        const reg = registry({ [EAS]: { "1.0.0": needsKey("EAS") } });
        const install = await planPluginChange([], { name: "x", version: "1.0.0", manifest: manifest("X", { [EAS]: "1" }) }, reg);
        expect(install).toEqual({ install: [], enable: [], conflicts: ["EAS requires settings: API key, Region."] });

        const disabled = { ...row(EAS, "1.0.0", false, needsKey("EAS")), settings: { k: "saved" } };
        const enable = await planPluginChange([disabled], { name: "x", version: "1.0.0", manifest: manifest("X", { [EAS]: "1" }) }, reg);
        expect(enable.conflicts).toEqual(["EAS requires settings: Region."]);
        const configured = await planPluginChange([{ ...disabled, settings: { k: "saved", r: "eu" } }], { name: "x", version: "1.0.0", manifest: manifest("X", { [EAS]: "1" }) }, reg);
        expect(configured).toEqual({ install: [], enable: [EAS], conflicts: [] });
    });

    describe("UI mount conflicts", () => {
        const withUi = (displayName: string, mounts: string[], requires?: Record<string, string>): PluginManifest => ({
            ...manifest(displayName, requires),
            ui: { apps: mounts.map((mount, i) => ({ id: `app${i}`, host: "www", mount, dir: `apps/app${i}` })) },
        });
        const BOOKING = "@rapidmx/booking-plugin";

        it("refuses a plugin that mounts pages where an enabled plugin already does, and only an enabled one", async () => {
            const change = { name: "@rapidmx/other-booking-plugin", version: "1.0.0", manifest: withUi("Other Booking", ["/book", "/notes"]) };
            const enabledRow = row(BOOKING, "1.0.0", true, withUi("Booking", ["/book"]));
            expect(await planPluginChange([enabledRow], change, REGISTRY)).toEqual({ install: [], enable: [], conflicts: ["Other Booking and Booking both serve pages at /book."] });
            expect((await planPluginChange([{ ...enabledRow, enabled: false }], change, REGISTRY)).conflicts).toEqual([]);
            expect((await planPluginChange([{ ...enabledRow, removed: true }], change, REGISTRY)).conflicts).toEqual([]);
            // A plugin with no UI, or with UI elsewhere, is fine.
            expect((await planPluginChange([enabledRow, row(EAS, "1.0.0", true)], { ...change, manifest: withUi("Other Booking", ["/notes"]) }, REGISTRY)).conflicts).toEqual([]);
        });

        it("refuses a plan whose installed or enabled requirement overlaps an enabled plugin's pages", async () => {
            const reg = registry({ [EAS]: { "1.0.0": withUi("EAS", ["/sync"]) } });
            const syncRow = row("@rapidmx/sync-plugin", "1.0.0", true, withUi("Sync", ["/sync"]));
            const install = await planPluginChange([syncRow], { name: "x", version: "1.0.0", manifest: manifest("X", { [EAS]: "1" }) }, reg);
            expect(install.install.map((i) => i.name)).toEqual([EAS]);
            expect(install.conflicts).toEqual(["EAS and Sync both serve pages at /sync."]);

            const enable = await planPluginChange([syncRow, row(EAS, "1.0.0", false, withUi("EAS", ["/sync"]))], { name: "x", version: "1.0.0", manifest: manifest("X", { [EAS]: "1" }) }, reg);
            expect(enable.enable).toEqual([EAS]);
            expect(enable.conflicts).toEqual(["EAS and Sync both serve pages at /sync."]);

            // The plugin itself against what it brings in.
            const own = await planPluginChange([], { name: "x", version: "1.0.0", manifest: withUi("X", ["/sync"], { [EAS]: "1" }) }, reg);
            expect(own.conflicts).toEqual(["X and EAS both serve pages at /sync."]);
        });

        it("compares a version change against the other plugins, not the version it replaces, and ignores unrelated overlaps", async () => {
            const current = row(BOOKING, "1.0.0", true, withUi("Booking", ["/book"]));
            const brokenPair = [row("@rapidmx/a-plugin", "1.0.0", true, withUi("A", ["/same"])), row("@rapidmx/b-plugin", "1.0.0", true, withUi("B", ["/same"]))];
            const plan = await planPluginChange([current, ...brokenPair], { name: BOOKING, version: "2.0.0", manifest: withUi("Booking", ["/book"]) }, REGISTRY);
            expect(plan.conflicts).toEqual([]);
            const moved = await planPluginChange([current, ...brokenPair], { name: BOOKING, version: "2.0.0", manifest: withUi("Booking", ["/book", "/same"]) }, REGISTRY);
            expect(moved.conflicts).toEqual(["Booking and A both serve pages at /same.", "Booking and B both serve pages at /same."]);
        });
    });
});

describe("findUnmetRequirements", () => {
    it("reports enabled plugins whose requirements are disabled, removed, missing or out of range", () => {
        const installed = [
            row(EAS, "2.0.0", true, manifest("EAS")),
            row(MAPI, "1.0.0", true, manifest("MAPI", { [EAS]: "^1.0.0" })),
            row(AUTODISCOVER, "1.0.0", true, manifest("Autodiscover", { off: "*", gone: "*", ghost: "*" })),
            row("off", "1.0.0", false),
            { ...row("gone", "1.0.0", true), removed: true },
            row("disabled-dependent", "1.0.0", false, manifest("Disabled", { ghost: "*" })),
        ];
        expect(findUnmetRequirements(installed)).toEqual([
            "MAPI requires EAS ^1.0.0, but 2.0.0 is installed.",
            "Autodiscover requires off *, which isn't enabled.",
            "Autodiscover requires gone *, which isn't enabled.",
            "Autodiscover requires ghost *, which isn't enabled.",
        ]);
        expect(findUnmetRequirements(installed, [EAS])).toEqual(["MAPI requires EAS ^1.0.0, but 2.0.0 is installed."]);
        expect(findUnmetRequirements(installed, ["off"])).toEqual(["Autodiscover requires off *, which isn't enabled."]);
        // A required row without a stored manifest is named by its package.
        expect(findUnmetRequirements([row("bare", "2.0.0", true), row("x", "1.0.0", true, manifest("X", { bare: "^1.0.0" }))])).toEqual([
            "X requires bare ^1.0.0, but 2.0.0 is installed.",
        ]);
        expect(findUnmetRequirements([row("plain", "1.0.0", true, { apiVersion: 1, displayName: "Plain" })], ["plain"])).toEqual([]);
    });
});

describe("findDependents", () => {
    it("returns the enabled, non-removed plugins that require a plugin", () => {
        const installed = [
            row(EAS, "1.0.0", true),
            row(AUTODISCOVER, "1.0.0", true, AUTODISCOVER_MANIFEST),
            row("off", "1.0.0", false, manifest("Off", { [EAS]: "*" })),
            { ...row("gone", "1.0.0", true, manifest("Gone", { [EAS]: "*" })), removed: true },
        ];
        expect(findDependents(installed, EAS).map((p) => p.name)).toEqual([AUTODISCOVER]);
        expect(findDependents(installed, AUTODISCOVER)).toEqual([]);
    });

    it("only counts a manifest's own requirements, not Object.prototype members", async () => {
        const installed = [row("constructor", "1.0.0", true), row("dependent", "1.0.0", true, manifest("Dependent", {})), row("bare", "1.0.0", true, manifest("Bare"))];
        expect(findDependents(installed, "constructor")).toEqual([]);
        expect(findDependents(installed, "toString")).toEqual([]);
        const plan = await planPluginChange(installed, { name: "toString", version: "1.0.0", manifest: manifest("To String") }, REGISTRY);
        expect(plan.conflicts).toEqual([]);
    });
});

describe("orderByDependencies", () => {
    it("puts each plugin after what it requires, otherwise keeping the order, and tolerates cycles", () => {
        const plugins = [
            { name: AUTODISCOVER, manifest: AUTODISCOVER_MANIFEST },
            { name: "unrelated" },
            { name: MAPI, manifest: manifest("MAPI", { [EAS]: "*", missing: "*" }) },
            { name: EAS, manifest: manifest("EAS") },
        ];
        expect(orderByDependencies(plugins).map((p) => p.name)).toEqual([EAS, MAPI, AUTODISCOVER, "unrelated"]);
        const cycle = [
            { name: "a", manifest: manifest("A", { b: "*" }) },
            { name: "b", manifest: manifest("B", { a: "*" }) },
        ];
        expect(orderByDependencies(cycle).map((p) => p.name)).toEqual(["b", "a"]);
    });
});

describe("pruneUnmetRequirements", () => {
    it("drops plugins whose requirements are missing or out of range, cascading to their dependents", () => {
        const plugins = [
            { name: EAS, version: "2.0.0", manifest: manifest("EAS") },
            { name: MAPI, version: "1.0.0", manifest: manifest("MAPI", { [EAS]: "^1.0.0" }) },
            { name: AUTODISCOVER, version: "1.0.0", manifest: manifest("Autodiscover", { [MAPI]: "^1.0.0" }) },
            { name: "needs-ghost", version: "1.0.0", manifest: manifest("Ghost", { ghost: "*" }) },
            { name: "plain", version: "1.0.0" },
        ];
        const { kept, dropped } = pruneUnmetRequirements(plugins);
        expect(kept.map((p) => p.name)).toEqual([EAS, "plain"]);
        expect(dropped).toEqual([
            { name: MAPI, message: `It requires ${EAS} ^1.0.0, but 2.0.0 is loaded.` },
            { name: "needs-ghost", message: "It requires ghost *, which isn't loaded." },
            { name: AUTODISCOVER, message: `It requires ${MAPI} ^1.0.0, which isn't loaded.` },
        ]);
    });
});
