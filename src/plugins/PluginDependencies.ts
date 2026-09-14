///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import semver from "semver";
import { PluginManifest } from "../models/types.js";
import { isExactVersion, missingRequiredSettings } from "./PluginUtils.js";

/** An installed plugin as the dependency planner sees it - a `Plugin` row satisfies this. */
export interface PlannerInstalledPlugin {
    name: string;
    packageVersion: string;
    enabled: boolean;
    removed?: boolean;
    manifest?: PluginManifest;
    settings?: Record<string, unknown>;
}

/** One published version of a package, with its parsed manifest or the reason it isn't a loadable plugin. */
export interface PlannerPackageVersion {
    version: string;
    integrity?: string;
    manifest: PluginManifest | string;
}

/** Where the planner reads published versions from. Both resolve `undefined` for an unknown package or version. */
export interface PlannerRegistry {
    versions(name: string): Promise<string[] | undefined>;
    version(name: string, version: string): Promise<PlannerPackageVersion | undefined>;
}

/** The plugin being added, or the version an installed plugin is changing to. */
export interface PlannedPluginChange {
    name: string;
    version: string;
    manifest: PluginManifest;
}

/** A dependency the change also installs. */
export interface PlannedPluginInstall {
    name: string;
    version: string;
    integrity?: string;
    manifest: PluginManifest;
}

/** What a change needs: dependencies to install (in install order, dependencies first), installed plugins to enable,
 * and why the change can't be made. A change with any `conflicts` must not be applied. */
export interface PluginChangePlan {
    install: PlannedPluginInstall[];
    enable: string[];
    conflicts: string[];
}

export interface PlanPluginChangeOptions {
    /** Whether a dependency may be installed on this server; one that may not is a conflict. Defaults to allowing all. */
    allowed?: (name: string) => boolean;
}

/** A plugin whose requirements are being checked or ordered. */
export interface PluginRequirementNode {
    name: string;
    version: string;
    manifest?: PluginManifest;
}

function requiresOf(manifest: PluginManifest | undefined): [string, string][] {
    return Object.entries(manifest?.requires ?? {});
}

/** The range `manifest` requires of `name`, if it requires it. Only the map's own keys count, so a plugin named after an
 * `Object.prototype` member (such as `constructor`) isn't mistaken for a requirement. */
function requiredRange(manifest: PluginManifest | undefined, name: string): string | undefined {
    const requires: Record<string, string> | undefined = manifest?.requires;
    return requires && Object.prototype.hasOwnProperty.call(requires, name) ? requires[name] : undefined;
}

function satisfies(version: string, range: string): boolean {
    return isExactVersion(version) && semver.satisfies(version, range);
}

/** A conflict naming the settings a dependency needs before it can be installed or enabled, if it needs any. */
function missingSettingsConflict(label: string, manifest: PluginManifest | undefined, values?: Record<string, unknown>): string | undefined {
    const missing: string[] = missingRequiredSettings(manifest, values).map((setting) => setting.label);
    return missing.length > 0 ? `${label} requires settings: ${missing.join(", ")}.` : undefined;
}

/**
 * Works out what adding a plugin, or changing an installed plugin's version, takes. Each requirement of the plugin is
 * resolved in turn, and so are the requirements of anything that brings in:
 * - installed, enabled and in range: nothing to do;
 * - installed, disabled and in range: it gets enabled;
 * - not installed: it gets installed at the highest published version in range;
 * - installed out of range, missing from the registry, or with no version in range: a conflict;
 * - to be installed or enabled, but not allowed or missing a required setting with no default or saved value: a conflict.
 *
 * Installed plugins are never upgraded or downgraded to make room. Changing a plugin's version is also a conflict when
 * the new version falls outside the range an enabled plugin requires of it.
 */
export async function planPluginChange(
    installed: PlannerInstalledPlugin[],
    change: PlannedPluginChange,
    registry: PlannerRegistry,
    options: PlanPluginChangeOptions = {},
): Promise<PluginChangePlan> {
    const rows: Map<string, PlannerInstalledPlugin> = new Map(installed.filter((row) => !row.removed).map((row) => [row.name, row]));
    const plan: PluginChangePlan = { install: [], enable: [], conflicts: [] };
    const planned: Map<string, string> = new Map([[change.name, change.version]]);
    const label = (name: string, manifest?: PluginManifest): string => manifest?.displayName ?? rows.get(name)?.manifest?.displayName ?? name;

    for (const row of rows.values()) {
        const range: string | undefined = requiredRange(row.manifest, change.name);
        if (row.name !== change.name && row.enabled && range !== undefined && !satisfies(change.version, range)) {
            plan.conflicts.push(`${label(row.name)} requires ${change.name} ${range}, which ${change.version} doesn't satisfy.`);
        }
    }

    const visit = async (name: string, manifest: PluginManifest, path: string[]): Promise<void> => {
        for (const [dependency, range] of requiresOf(manifest)) {
            const requirer: string = label(name, manifest);
            if (path.includes(dependency)) {
                plan.conflicts.push(`${[...path, dependency].join(" requires ")}, which is a circular requirement.`);
                continue;
            }
            const plannedVersion: string | undefined = planned.get(dependency);
            if (plannedVersion !== undefined) {
                if (!satisfies(plannedVersion, range)) {
                    plan.conflicts.push(`${requirer} requires ${dependency} ${range}, but ${plannedVersion} is being installed.`);
                }
                continue;
            }
            const row: PlannerInstalledPlugin | undefined = rows.get(dependency);
            if (row) {
                if (!satisfies(row.packageVersion, range)) {
                    plan.conflicts.push(`${requirer} requires ${label(dependency)} ${range}, but ${row.packageVersion} is installed.`);
                } else if (!row.enabled) {
                    // Enabling is as much a change as installing, so a narrowed allow-list stops it too.
                    if (options.allowed && !options.allowed(dependency)) {
                        plan.conflicts.push(`${requirer} requires ${dependency}, which isn't an allowed plugin package on this server.`);
                        continue;
                    }
                    const settingsConflict: string | undefined = missingSettingsConflict(label(dependency), row.manifest, row.settings);
                    if (settingsConflict) {
                        plan.conflicts.push(settingsConflict);
                        continue;
                    }
                    planned.set(dependency, row.packageVersion);
                    await visit(dependency, row.manifest ?? ({} as PluginManifest), [...path, dependency]);
                    plan.enable.push(dependency);
                }
                continue;
            }
            if (options.allowed && !options.allowed(dependency)) {
                plan.conflicts.push(`${requirer} requires ${dependency}, which isn't an allowed plugin package on this server.`);
                continue;
            }
            const versions: string[] | undefined = await registry.versions(dependency);
            if (!versions) {
                plan.conflicts.push(`${requirer} requires ${dependency}, which isn't in the plugin registry.`);
                continue;
            }
            const best: string | null = semver.maxSatisfying(versions.filter(isExactVersion), range);
            const found: PlannerPackageVersion | undefined = best ? await registry.version(dependency, best) : undefined;
            if (!found) {
                plan.conflicts.push(`${requirer} requires ${dependency} ${range}, but no published version satisfies it.`);
                continue;
            }
            if (typeof found.manifest === "string") {
                plan.conflicts.push(`${requirer} requires ${dependency}, which can't be installed: ${found.manifest}`);
                continue;
            }
            const settingsConflict: string | undefined = missingSettingsConflict(found.manifest.displayName, found.manifest);
            if (settingsConflict) {
                plan.conflicts.push(settingsConflict);
                continue;
            }
            planned.set(dependency, found.version);
            await visit(dependency, found.manifest, [...path, dependency]);
            plan.install.push({ name: dependency, version: found.version, integrity: found.integrity, manifest: found.manifest });
        }
    };
    await visit(change.name, change.manifest, [change.name]);
    return plan;
}

/**
 * Every requirement of an enabled plugin that the enabled plugins don't meet - its requirement is disabled, removed,
 * missing or out of range. With `involving`, only requirements where the requiring or the required plugin is one of
 * those names are reported, so an unrelated, already-broken pair doesn't block every change.
 */
export function findUnmetRequirements(installed: PlannerInstalledPlugin[], involving?: Iterable<string>): string[] {
    const names: Set<string> | undefined = involving ? new Set(involving) : undefined;
    const enabled: Map<string, PlannerInstalledPlugin> = new Map(installed.filter((row) => row.enabled && !row.removed).map((row) => [row.name, row]));
    const label = (row: PlannerInstalledPlugin): string => row.manifest?.displayName ?? row.name;
    const problems: string[] = [];
    for (const row of enabled.values()) {
        for (const [dependency, range] of requiresOf(row.manifest)) {
            if (names && !names.has(row.name) && !names.has(dependency)) {
                continue;
            }
            const required: PlannerInstalledPlugin | undefined = enabled.get(dependency);
            if (!required) {
                problems.push(`${label(row)} requires ${dependency} ${range}, which isn't enabled.`);
            } else if (!satisfies(required.packageVersion, range)) {
                problems.push(`${label(row)} requires ${label(required)} ${range}, but ${required.packageVersion} is installed.`);
            }
        }
    }
    return problems;
}

/** The enabled plugins that require `name`. */
export function findDependents<P extends PlannerInstalledPlugin>(installed: P[], name: string): P[] {
    return installed.filter((row) => row.enabled && !row.removed && row.name !== name && requiredRange(row.manifest, name) !== undefined);
}

/** `plugins` reordered so each comes after the plugins it requires, otherwise keeping their order. Requirements outside
 * the list are ignored, and a circular requirement is broken where it's found. */
export function orderByDependencies<P extends { name: string; manifest?: PluginManifest }>(plugins: P[]): P[] {
    const byName: Map<string, P> = new Map(plugins.map((plugin) => [plugin.name, plugin]));
    const ordered: P[] = [];
    const seen: Set<string> = new Set();
    const visit = (plugin: P): void => {
        if (seen.has(plugin.name)) {
            return;
        }
        seen.add(plugin.name);
        for (const [dependency] of requiresOf(plugin.manifest)) {
            const required: P | undefined = byName.get(dependency);
            if (required) {
                visit(required);
            }
        }
        ordered.push(plugin);
    };
    plugins.forEach(visit);
    return ordered;
}

/** Splits `plugins` into those whose requirements are all in the list and in range, and those that aren't, with the
 * reason. Dropping a plugin can leave others without a requirement, so this repeats until nothing more drops. */
export function pruneUnmetRequirements<P extends PluginRequirementNode>(plugins: P[]): { kept: P[]; dropped: { name: string; message: string }[] } {
    let kept: P[] = plugins;
    const dropped: { name: string; message: string }[] = [];
    for (;;) {
        const versions: Map<string, string> = new Map(kept.map((plugin) => [plugin.name, plugin.version]));
        const next: P[] = kept.filter((plugin) => {
            for (const [dependency, range] of requiresOf(plugin.manifest)) {
                const version: string | undefined = versions.get(dependency);
                if (version === undefined || !satisfies(version, range)) {
                    const detail: string = version === undefined ? "which isn't loaded" : `but ${version} is loaded`;
                    dropped.push({ name: plugin.name, message: `It requires ${dependency} ${range}, ${detail}.` });
                    return false;
                }
            }
            return true;
        });
        if (next.length === kept.length) {
            return { kept, dropped };
        }
        kept = next;
    }
}
