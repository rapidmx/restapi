///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import crypto from "crypto";
import { Plugin, PluginManifest, PluginSecretSettingRef, PluginSettingDefinition, PluginSettingValue, SecretRef } from "../models/types.js";
import type { SecretStore } from "../secrets/SecretStore.js";
import { isPluginSecretRef, isSecretSetting, validatePluginSettings } from "./PluginUtils.js";

/** Where plugin secret settings are in the secret store (spec 5.1): `plugins/<package>/<key>-<random>`, one secret per setting and write. */
export const PLUGIN_SECRET_PATH_PREFIX = "plugins";

/** A plugin and one of its settings, as the migration and Diagnostics name a secret (never with its value). */
export interface PluginSecretKey {
    name: string;
    key: string;
}

/** The longest path `pluginSecretPath()` gives: a Kubernetes Secret's key takes at most 253 characters, and the path is one on that backend. */
export const MAX_PLUGIN_SECRET_PATH_LENGTH = 253;

/** The longest a setting key's segment of the path is before it is shortened, leaving the package name most of the room. */
const MAX_KEY_SEGMENT_LENGTH = 96;

/** `text` with nothing in it a path segment can't hold: only letters, digits, `.`, `_` and `-` (what a Kubernetes Secret's keys take), the
 * rest as `_`. */
function pathSegment(text: string): string {
    return text.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** `segment` (made from `original`) cut to at most `max` characters, a cut one ending in `_` and 8 hex digits of `original`'s hash, so two long names
 * that start alike still read apart. */
function shortened(segment: string, original: string, max: number): string {
    if (segment.length <= max) {
        return segment;
    }
    return `${segment.slice(0, max - 9)}_${crypto.createHash("sha256").update(original).digest("hex").slice(0, 8)}`;
}

/**
 * A new path for one write of a plugin's secret setting: `plugins/<package>/<key>-<16 random hex digits>`, the package without its `@` (its scope a level
 * of its own) and both with anything but letters, digits, `.`, `_` and `-` replaced, so every backend takes it. Every write goes to a path of its own, never
 * over the secret the row names (as Integrations does, `integrationSecretPath()`): a row that can't be saved afterwards leaves the secret in use untouched,
 * and two writes racing each other never share a store entry. The secret the row named before is removed once the row is saved.
 *
 * The path is never longer than `MAX_PLUGIN_SECRET_PATH_LENGTH`: a package name may be 214 characters and a key has no limit, so a key past 96
 * characters, and then a package name past the room left, is cut short and ends in a hash of its whole name (`shortened()`).
 */
export function pluginSecretPath(packageName: string, key: string): string {
    const suffix: string = `-${crypto.randomBytes(8).toString("hex")}`;
    const keySegment: string = shortened(pathSegment(key), key, MAX_KEY_SEGMENT_LENGTH);
    // The prefix and the two `/` around the package.
    const room: number = MAX_PLUGIN_SECRET_PATH_LENGTH - PLUGIN_SECRET_PATH_PREFIX.length - 2 - keySegment.length - suffix.length;
    const bare: string = packageName.replace(/^@/, "");
    const pkg: string = shortened(bare.split("/").map(pathSegment).join("/"), bare, room);
    return `${PLUGIN_SECRET_PATH_PREFIX}/${pkg}/${keySegment}${suffix}`;
}

/** Whether `value` is a secret setting's value still held in plaintext: text that isn't empty (an empty value is no value), a number or a flag. A
 * reference, `null` and anything else are not. */
export function isPlaintextSecretValue(value: unknown): value is string | number | boolean {
    return (typeof value === "string" && value !== "") || typeof value === "number" || typeof value === "boolean";
}

/**
 * Stores one secret setting's value in `store` at a new path (`pluginSecretPath()`) and returns what the row keeps in its place. Text is stored as it is,
 * under `value`; a number or a flag as its text, with its `type`, so the plugin host gives the plugin what it saved.
 */
export async function writePluginSecretSetting(
    store: Pick<SecretStore, "write">,
    packageName: string,
    key: string,
    value: string | number | boolean,
): Promise<PluginSecretSettingRef> {
    const values: Record<string, string> = typeof value === "string" ? { value } : { value: String(value), type: typeof value };
    return { $secretRef: await store.write(pluginSecretPath(packageName, key), values) };
}

/**
 * `settings` with the plaintext value of each secret setting (`isSecretSetting()` against `manifest`) written to `store` (`writePluginSecretSetting()`)
 * and its reference in its place: what every save of a plugin's settings does while the deployment has a store (spec 5.4), the route's saves and the
 * server's seeding of default plugins alike. Each reference is added to `written` as soon as it is written, so a caller whose change then fails (a later
 * write of this call included) removes exactly those. A store whose `backend` is `"none"` stores nothing: the settings come back as they are.
 */
export async function storePluginSecretSettings(
    store: Pick<SecretStore, "write" | "backend">,
    packageName: string,
    manifest: Pick<PluginManifest, "settings"> | undefined,
    settings: Record<string, PluginSettingValue>,
    written: SecretRef[] = [],
): Promise<Record<string, PluginSettingValue>> {
    if (store.backend === "none") {
        return settings;
    }
    const result: Record<string, PluginSettingValue> = { ...settings };
    for (const [key, value] of Object.entries(settings)) {
        if (isPlaintextSecretValue(value) && isSecretSetting(key, manifest)) {
            const ref: PluginSecretSettingRef = await writePluginSecretSetting(store, packageName, key, value);
            written.push(ref.$secretRef);
            result[key] = ref;
        }
    }
    return result;
}

/** The value a secret setting's stored secret holds, as the plugin saved it, or `undefined` when the store can't give it or it isn't one. */
async function readPluginSecretSetting(store: Pick<SecretStore, "read">, ref: SecretRef): Promise<string | number | boolean | undefined> {
    let stored: Record<string, string>;
    try {
        stored = await store.read(ref);
    } catch {
        return undefined;
    }
    const value: string | undefined = stored.value;
    if (typeof value !== "string") {
        return undefined;
    }
    switch (stored.type) {
        case undefined:
            return value;
        case "number": {
            const parsed: number = Number(value);
            return value.trim() !== "" && Number.isFinite(parsed) ? parsed : undefined;
        }
        case "boolean":
            return value === "true" ? true : value === "false" ? false : undefined;
        default:
            return undefined;
    }
}

/** A kept secret `checkKeptPluginSecrets()` couldn't read back from the store to check it. The value is never in the message. */
export class PluginSecretUnreadableError extends Error {}

/** What of a setting's definition its value is checked against (`validatePluginSettings()`): two definitions that differ only in their label,
 * description or default take the same values. */
function valueRule(definition: PluginSettingDefinition): string {
    return JSON.stringify([definition.type, definition.min ?? null, definition.max ?? null, (definition.options ?? []).map((option) => option.value)]);
}

/**
 * Checks the secret references a plugin keeps across a change of version (`kept`: carried from the row, or sent back as the mask) against `manifest`,
 * the new version's. A reference leaves the value where it is, so without this a value the new version types or bounds differently would be carried
 * unchecked, where the same value held in plaintext is refused. A setting whose definition takes the same values as in `previous` (the row's manifest) is
 * kept unread; any other's value is read back from `store` and checked as a saved value is, throwing the `Error` `validatePluginSettings()` does (naming
 * the setting, never the value). A value that can't be read back (the store unavailable, the secret gone, or in a backend the deployment doesn't use)
 * throws a `PluginSecretUnreadableError`: refused rather than carried unchecked.
 */
export async function checkKeptPluginSecrets(
    store: Pick<SecretStore, "read" | "backend">,
    previous: Pick<PluginManifest, "settings"> | undefined,
    manifest: PluginManifest,
    kept: Record<string, PluginSecretSettingRef>,
): Promise<void> {
    for (const [key, ref] of Object.entries(kept)) {
        const definition: PluginSettingDefinition | undefined = manifest.settings?.find((setting) => setting.key === key);
        const before: PluginSettingDefinition | undefined = previous?.settings?.find((setting) => setting.key === key);
        if (!definition || (before && valueRule(before) === valueRule(definition))) {
            // A setting the version doesn't declare is refused by `validatePluginSettings()` itself.
            continue;
        }
        const value: string | number | boolean | undefined =
            ref.$secretRef.backend === store.backend ? await readPluginSecretSetting(store, ref.$secretRef) : undefined;
        if (value === undefined) {
            throw new PluginSecretUnreadableError(
                `The saved value of '${definition.label}' couldn't be read from the secret store to check it against this version. Save a new value for it, or try again later.`,
            );
        }
        validatePluginSettings({ ...manifest, settings: [definition] }, { [key]: value });
    }
}

/** The settings the plugin host puts into the server's `plugins` config layer, and the keys whose secret couldn't be read. */
export interface ResolvedPluginSettings {
    /** Every setting as the plugin reads it, references replaced by their values: never persisted, logged or answered. */
    values: Record<string, string | number | boolean>;
    /** The settings whose secret the store couldn't give: left out, so the deployment's value or the plugin's default applies, for the caller to warn
     * about. */
    unresolved: string[];
}

/**
 * A plugin row's settings as its plugin reads them (spec 5.4): what the server's plugin host loads into the `plugins` config layer, so plugins see no
 * change. Each `$secretRef` is read from `store`; a secret the store can't give (gone, unreadable, no store) is left out and named in `unresolved`, and no
 * value ever appears in an error.
 */
export async function resolvePluginSecretSettings(
    settings: Record<string, PluginSettingValue> | undefined,
    store: Pick<SecretStore, "read">,
): Promise<ResolvedPluginSettings> {
    const result: ResolvedPluginSettings = { values: {}, unresolved: [] };
    for (const [key, value] of Object.entries(settings ?? {})) {
        if (!isPluginSecretRef(value)) {
            result.values[key] = value;
            continue;
        }
        const resolved: string | number | boolean | undefined = await readPluginSecretSetting(store, value.$secretRef);
        if (resolved === undefined) {
            result.unresolved.push(key);
        } else {
            result.values[key] = resolved;
        }
    }
    return result;
}

/** The secret settings `plugin` still holds the value of on its row (`isSecretSetting()` and `isPlaintextSecretValue()`), in the row's order. */
export function plaintextSecretKeys(plugin: Pick<Plugin, "settings" | "manifest">): string[] {
    return Object.entries(plugin.settings ?? {})
        .filter(([key, value]) => isPlaintextSecretValue(value) && isSecretSetting(key, plugin.manifest))
        .map(([key]) => key);
}

/** Every secret setting `plugins` still hold in plaintext: what the migration moves and, without a secret store, what Diagnostics warns about. */
export function plaintextPluginSecrets(plugins: Pick<Plugin, "name" | "settings" | "manifest">[]): PluginSecretKey[] {
    return plugins.flatMap((plugin) => plaintextSecretKeys(plugin).map((key) => ({ name: plugin.name, key })));
}

/** The secret references `settings` hold. */
export function pluginSecretRefs(settings: Record<string, unknown> | undefined): SecretRef[] {
    return Object.values(settings ?? {})
        .filter(isPluginSecretRef)
        .map((value) => value.$secretRef);
}

/** The secrets `before` referred to that `after` no longer does (replaced, cleared or dropped), to remove once `after` is saved. */
export function releasedPluginSecretRefs(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined): SecretRef[] {
    const named: Set<string> = new Set(pluginSecretRefs(after).map((ref) => `${ref.backend}:${ref.path}`));
    return pluginSecretRefs(before).filter((ref) => !named.has(`${ref.backend}:${ref.path}`));
}

/** `settings` without any secret setting, value or reference: what an uninstalled plugin's row keeps (adding it again starts from its defaults). */
export function withoutSecretSettings(
    settings: Record<string, PluginSettingValue> | undefined,
    manifest: Plugin["manifest"] | undefined,
): Record<string, PluginSettingValue> {
    return Object.fromEntries(Object.entries(settings ?? {}).filter(([key, value]) => !isPluginSecretRef(value) && !isSecretSetting(key, manifest)));
}
