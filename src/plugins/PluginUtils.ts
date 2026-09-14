///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import crypto from "crypto";
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

/** The package allow-list used when `system:plugins:allowed_packages` isn't configured. */
export const DEFAULT_ALLOWED_PLUGIN_PACKAGES = ["@rapidmx/*"];

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
    for (const setting of settings) {
        const problem: string | undefined = checkSettingDefinition(setting);
        if (problem) {
            return `This plugin's manifest has an invalid setting: ${problem}`;
        }
    }
    return {
        apiVersion: manifest.apiVersion,
        displayName: manifest.displayName,
        description: typeof manifest.description === "string" ? manifest.description : undefined,
        settings: settings as PluginSettingDefinition[],
    };
}

function checkSettingDefinition(setting: any): string | undefined {
    if (!setting || typeof setting.key !== "string" || setting.key === "" || typeof setting.label !== "string") {
        return "every setting needs a key and a label.";
    }
    if (!["string", "number", "boolean", "select"].includes(setting.type)) {
        return `'${setting.key}' has an unknown type '${setting.type}'.`;
    }
    if (setting.type === "select" && (!Array.isArray(setting.options) || setting.options.length === 0)) {
        return `'${setting.key}' is a select with no options.`;
    }
    return undefined;
}

/** Whether `name` matches one of `patterns`. A `*` matches any run of characters except `/`, so `@rapidmx/*`
 * allows every package in the `@rapidmx` scope and nothing else. */
export function matchesAllowedPackage(name: string, patterns: string[]): boolean {
    return patterns.some((pattern) => {
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
