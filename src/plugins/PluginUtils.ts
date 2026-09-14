///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import crypto from "crypto";
import semver from "semver";
import { Plugin, PluginManifest, PluginSettingDefinition } from "../models/types.js";

/** The plugin contract version this library implements. A plugin whose manifest declares any other
 * `apiVersion` is refused, both when an administrator adds it and when a server copy loads it. */
export const PLUGIN_API_VERSION = 1;

/** The Redis pub/sub channel (on `datastores:events`) a `plugins.changed` message is published to after any
 * change to the installed plugin set, so every server copy re-checks its loaded state. */
export const PLUGIN_EVENTS_CHANNEL = "plugins";

/** The `type` of the message published on `PLUGIN_EVENTS_CHANNEL`. */
export const PLUGIN_CHANGED_EVENT = "plugins.changed";

/** The Redis hash (on `datastores:cache`) each server copy writes its `PluginInstanceStatus` into, keyed by
 * its instance id. */
export const PLUGIN_STATUS_KEY = "plugins:status";

/** How old a `PluginInstanceStatus` may be before it's treated as a server copy that no longer exists. */
export const PLUGIN_STATUS_MAX_AGE_MS = 2 * 60 * 1000;

/** The package allow-list used when `system:plugins:allowed_packages` isn't configured. Packages in a configured
 * namespace (`system:plugins:namespaces`) are allowed as well. */
export const DEFAULT_ALLOWED_PLUGIN_PACKAGES = ["@rapidmx/*"];

/** The namespaces searched for plugins when `system:plugins:namespaces` isn't configured. */
export const DEFAULT_PLUGIN_NAMESPACES = ["@rapidmx"];

/**
 * An npm scope plugins are published under, as configured in `system:plugins:namespaces`. Either a bare scope
 * (`"@my-company"`) using the default registry, or an object naming the registry (and optional auth token) that scope
 * is published to - the same idea as an `.npmrc` `@scope:registry=` line.
 */
export interface PluginNamespace {
    /** The scope, always with its leading `@`. */
    name: string;
    registry?: string;
    token?: string;
}

/** Where a config normalizer reports the entries it ignores. */
export interface PluginConfigLogger {
    warn(message: string): void;
}

/** npm's naming rule for new packages: lowercase and URL-safe, optionally scoped. */
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** npm's maximum package name length. */
const MAX_PACKAGE_NAME_LENGTH = 214;

/** Keys that reach `Object.prototype` when used on a plain object, so a manifest may not declare them. */
const RESERVED_KEYS: Set<string> = new Set(["__proto__", "constructor", "prototype"]);

/** Whether `name` is a valid npm package name. Anything else (`?`, `#`, whitespace, uppercase...) could be read
 * differently by the registry, npm and this server, so it's never looked up or stored. */
export function isValidPackageName(name: unknown): name is string {
    return typeof name === "string" && name.length <= MAX_PACKAGE_NAME_LENGTH && PACKAGE_NAME_PATTERN.test(name);
}

/** A list-valued config setting's entries. An environment variable arrives as a plain string, which is read as a
 * JSON list when it looks like one and as a comma-separated list otherwise. */
function configListEntries(value: unknown, key: string, logger?: PluginConfigLogger): unknown[] {
    if (Array.isArray(value)) {
        return value;
    }
    if (typeof value === "string") {
        const text: string = value.trim();
        if (text.startsWith("[")) {
            try {
                const parsed: unknown = JSON.parse(text);
                if (Array.isArray(parsed)) {
                    return parsed;
                }
            } catch {
                // Not JSON after all - read it as a comma-separated list below.
            }
        }
        return text
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry !== "");
    }
    if (value !== undefined && value !== null) {
        logger?.warn(`Ignoring ${key}: it must be a list or a comma-separated string.`);
    }
    return [];
}

/**
 * Normalizes the `system:plugins:allowed_packages` config into a list of patterns, dropping (with a warning) any entry
 * that isn't a package name or a wildcard inside one scope. A `*` pattern must name its scope (`@acme/*`), so a bare
 * `*` or an unscoped wildcard can't allow every package on the registry.
 */
export function normalizeAllowedPackages(value: unknown, logger?: PluginConfigLogger): string[] {
    const result: string[] = [];
    for (const entry of configListEntries(value, "system:plugins:allowed_packages", logger)) {
        const pattern: string = typeof entry === "string" ? entry.trim() : "";
        const valid: boolean = pattern.includes("*") ? /^@[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-._~*]+$/.test(pattern) : isValidPackageName(pattern);
        if (!valid) {
            logger?.warn(`Ignoring system:plugins:allowed_packages entry ${JSON.stringify(entry)}: it must be a package name or a scoped wildcard such as @acme/*.`);
        } else if (!result.includes(pattern)) {
            result.push(pattern);
        }
    }
    return result;
}

/** Normalizes the `system:plugins:namespaces` config (strings and/or objects, or a comma-separated string) into
 * `PluginNamespace`s, dropping anything that isn't a usable scope and de-duplicating by name (the first entry wins). */
export function normalizePluginNamespaces(value: unknown, logger?: PluginConfigLogger): PluginNamespace[] {
    const entries: unknown[] = configListEntries(value, "system:plugins:namespaces", logger);
    const result: Map<string, PluginNamespace> = new Map();
    for (const entry of entries) {
        const raw: any = typeof entry === "string" ? { name: entry } : entry;
        const scope: string = typeof raw?.name === "string" ? raw.name.trim() : "";
        if (!/^@?[a-z0-9][a-z0-9._~-]*$/.test(scope)) {
            logger?.warn(`Ignoring system:plugins:namespaces entry ${JSON.stringify(entry)}: it must be an npm scope such as @acme.`);
            continue;
        }
        const name: string = scope.startsWith("@") ? scope : `@${scope}`;
        if (!result.has(name)) {
            result.set(name, {
                name,
                registry: typeof raw.registry === "string" && raw.registry ? raw.registry : undefined,
                token: typeof raw.token === "string" && raw.token ? raw.token : undefined,
            });
        }
    }
    return [...result.values()];
}

/** The configured namespace a package (e.g. `@my-company/foo-plugin`) belongs to, if any. */
export function findPluginNamespace(packageName: string, namespaces: PluginNamespace[]): PluginNamespace | undefined {
    return namespaces.find((namespace) => packageName.startsWith(`${namespace.name}/`));
}

/**
 * Whether version `candidate` is newer than `current`, comparing `major.minor.patch` numerically and treating a
 * prerelease (`1.0.0-beta.2`) as older than its release (`1.0.0`), with prerelease identifiers compared numerically
 * where both are numbers. Anything that isn't a version compares as not newer.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
    const parse = (version: unknown) => {
        const match: RegExpMatchArray | null = typeof version === "string" ? /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version.trim()) : null;
        return match ? { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4]?.split(".") ?? [] } : undefined;
    };
    const a = parse(candidate);
    const b = parse(current);
    if (!a || !b) {
        return false;
    }
    for (let i = 0; i < 3; i++) {
        if (a.core[i] !== b.core[i]) {
            return a.core[i] > b.core[i];
        }
    }
    if (a.pre.length === 0 || b.pre.length === 0) {
        return a.pre.length === 0 && b.pre.length > 0;
    }
    for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
        const x: string | undefined = a.pre[i];
        const y: string | undefined = b.pre[i];
        if (x === undefined || y === undefined) {
            return x !== undefined;
        }
        if (x !== y) {
            const bothNumeric: boolean = /^\d+$/.test(x) && /^\d+$/.test(y);
            return bothNumeric ? Number(x) > Number(y) : x > y;
        }
    }
    return false;
}

/** What one server copy reports about the plugins it loaded. */
export interface PluginInstanceStatus {
    /** The server copy's identity (its hostname). */
    instance: string;
    /** `computePluginStateHash()` of the plugin set this copy loaded - compare with the desired hash to tell
     * whether a copy is still waiting to restart. */
    hash: string;
    loaded: { name: string; version: string }[];
    errors: { name: string; message: string }[];
    /** `true` when this copy started without any plugins because recent starts kept failing. */
    safeMode: boolean;
    updatedAt: string;
}

/** Extracts and validates the `rapidmx.plugin` block of a package's `package.json`. Returns an error message
 * instead of a manifest when the package isn't a loadable plugin. */
export function parsePluginManifest(pkg: any): PluginManifest | string {
    const manifest: any = pkg?.rapidmx?.plugin;
    if (!manifest || typeof manifest !== "object") {
        return "This package is not a RapidMX plugin (its package.json has no rapidmx.plugin block).";
    }
    if (manifest.apiVersion !== PLUGIN_API_VERSION) {
        return `This plugin targets plugin API version ${manifest.apiVersion}, but this server supports version ${PLUGIN_API_VERSION}.`;
    }
    if (typeof manifest.displayName !== "string" || manifest.displayName.trim() === "") {
        return "This plugin's manifest has no displayName.";
    }
    const settings: unknown = manifest.settings ?? [];
    if (!Array.isArray(settings)) {
        return "This plugin's manifest settings must be a list.";
    }
    const keys: Set<string> = new Set();
    for (const setting of settings) {
        const problem: string | undefined = checkSettingDefinition(setting) ?? (keys.has(setting.key) ? `'${setting.key}' is declared more than once.` : undefined);
        if (problem) {
            return `This plugin's manifest has an invalid setting: ${problem}`;
        }
        keys.add(setting.key);
    }
    const requires: unknown = manifest.requires ?? {};
    if (typeof requires !== "object" || requires === null || Array.isArray(requires)) {
        return "This plugin's manifest requires must map plugin package names to version ranges.";
    }
    for (const [name, range] of Object.entries(requires)) {
        if (!isValidPackageName(name) || RESERVED_KEYS.has(name)) {
            return `This plugin's manifest requires ${JSON.stringify(name)}, which isn't a valid package name.`;
        }
        if (name === pkg.name) {
            return "This plugin's manifest requires itself.";
        }
        if (typeof range !== "string" || semver.validRange(range) === null) {
            return `This plugin's manifest requires ${name} with an invalid version range.`;
        }
    }
    return {
        apiVersion: manifest.apiVersion,
        displayName: manifest.displayName,
        description: typeof manifest.description === "string" ? manifest.description : undefined,
        settings: settings as PluginSettingDefinition[],
        ...(Object.keys(requires).length > 0 ? { requires: requires as Record<string, string> } : {}),
    };
}

function checkSettingDefinition(setting: any): string | undefined {
    if (!setting || typeof setting.key !== "string" || setting.key === "" || typeof setting.label !== "string") {
        return "every setting needs a key and a label.";
    }
    if (RESERVED_KEYS.has(setting.key)) {
        return `'${setting.key}' is a reserved key.`;
    }
    if (!["string", "number", "boolean", "select"].includes(setting.type)) {
        return `'${setting.key}' has an unknown type '${setting.type}'.`;
    }
    if (setting.type === "select") {
        if (!Array.isArray(setting.options) || setting.options.length === 0) {
            return `'${setting.key}' is a select with no options.`;
        }
        if (!setting.options.every((option: any) => typeof option?.value === "string" && typeof option.label === "string")) {
            return `'${setting.key}' has an option without a value and a label.`;
        }
    }
    if (setting.default !== undefined) {
        // A default has to be a value an administrator could have saved.
        try {
            checkSettingValue(setting, setting.default);
        } catch (err: any) {
            return `'${setting.key}' has an invalid default: ${err.message}`;
        }
    }
    return undefined;
}

/** Whether `name` matches one of `patterns`. A `*` matches any run of characters except `/`, so `@rapidmx/*`
 * allows every package in the `@rapidmx` scope and nothing else. A name that isn't a valid package name never
 * matches. */
export function matchesAllowedPackage(name: string, patterns: string[]): boolean {
    return isValidPackageName(name) && patterns.some((pattern) => {
        const source: string = pattern
            .split("*")
            .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
            .join("[^/]*");
        return new RegExp(`^${source}$`).test(name);
    });
}

/** The value each of `manifest`'s settings starts with: its declared default, where it has one. */
export function defaultPluginSettings(manifest: PluginManifest): Record<string, string | number | boolean> {
    const result: Record<string, string | number | boolean> = {};
    for (const setting of manifest.settings ?? []) {
        if (setting.default !== undefined) {
            result[setting.key] = setting.default;
        }
    }
    return result;
}

/**
 * Checks `values` against `manifest`'s setting definitions and returns only the declared keys. Throws an
 * `Error` whose message names the first invalid setting. A `null` value removes a saved value so the
 * plugin's own default applies.
 */
export function validatePluginSettings(
    manifest: PluginManifest,
    values: Record<string, unknown>,
): Record<string, string | number | boolean> {
    const definitions: Map<string, PluginSettingDefinition> = new Map((manifest.settings ?? []).map((s) => [s.key, s]));
    const result: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(values)) {
        const definition: PluginSettingDefinition | undefined = definitions.get(key);
        if (!definition) {
            throw new Error(`'${key}' is not a setting of this plugin.`);
        }
        if (value === null || value === undefined || value === "") {
            if (definition.required) {
                throw new Error(`'${definition.label}' is required.`);
            }
            continue;
        }
        result[key] = checkSettingValue(definition, value);
    }
    for (const definition of definitions.values()) {
        if (definition.required && result[definition.key] === undefined && definition.default === undefined) {
            throw new Error(`'${definition.label}' is required.`);
        }
    }
    return result;
}

function checkSettingValue(definition: PluginSettingDefinition, value: unknown): string | number | boolean {
    switch (definition.type) {
        case "number": {
            if (typeof value !== "number" || !Number.isFinite(value)) {
                throw new Error(`'${definition.label}' must be a number.`);
            }
            if (definition.min !== undefined && value < definition.min) {
                throw new Error(`'${definition.label}' must be at least ${definition.min}.`);
            }
            if (definition.max !== undefined && value > definition.max) {
                throw new Error(`'${definition.label}' must be at most ${definition.max}.`);
            }
            return value;
        }
        case "boolean":
            if (typeof value !== "boolean") {
                throw new Error(`'${definition.label}' must be true or false.`);
            }
            return value;
        case "select":
            if (typeof value !== "string" || !definition.options!.some((option) => option.value === value)) {
                throw new Error(`'${definition.label}' must be one of: ${definition.options!.map((o) => o.value).join(", ")}.`);
            }
            return value;
        default:
            if (typeof value !== "string") {
                throw new Error(`'${definition.label}' must be text.`);
            }
            return value;
    }
}

/**
 * A stable fingerprint of what a server copy should have loaded: every enabled plugin's name, version and
 * settings, independent of row order and key order. Two copies with the same hash loaded the same plugins
 * with the same settings, so a change message whose hash matches a copy's own is a no-op for it.
 */
export function computePluginStateHash(plugins: Pick<Plugin, "name" | "packageVersion" | "enabled" | "settings">[]): string {
    const normalized = plugins
        .filter((plugin) => plugin.enabled)
        .map((plugin) => [
            plugin.name,
            plugin.packageVersion,
            Object.keys(plugin.settings ?? {})
                .sort()
                .map((key) => [key, plugin.settings[key]]),
        ])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
