///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ConfigEnvelope, Plugin, PluginManifest, PluginSettingDefinition, PluginSettingValue } from "../models/types.js";
import { ConfigSecretUnavailableError, isConfigEnvelope, type ConfigCipher, type ConfigSecretValue } from "../secrets/ConfigCipher.js";
import { isSecretSetting, pluginSecretContext, validatePluginSettings } from "./PluginUtils.js";

/** A plugin and one of its settings, as the encryption run and Diagnostics name a secret (never with its value). */
export interface PluginSecretKey {
    name: string;
    key: string;
}

/** Whether `value` is a secret setting's value still held in plaintext: text that isn't empty (an empty value is no value), a number or a flag. An envelope,
 * `null` and anything else are not. */
export function isPlaintextSecretValue(value: unknown): value is string | number | boolean {
    return (typeof value === "string" && value !== "") || typeof value === "number" || typeof value === "boolean";
}

/**
 * `settings` with the plaintext value of each secret setting (`isSecretSetting()` against `manifest`) encrypted for the plugin row `uid` and its setting
 * (`pluginSecretContext()`): what every save of a plugin's settings does once the first encryption run has completed (spec 5.7), the route's saves and the
 * server's seeding of default plugins alike. An envelope the row already holds, an empty value and every setting that isn't a secret come back as they are;
 * the settings it was given are not changed. A 503 (the cipher's) without a keyring.
 */
export function sealPluginSecretSettings(
    cipher: Pick<ConfigCipher, "encrypt">,
    uid: string,
    manifest: Pick<PluginManifest, "settings"> | undefined,
    settings: Record<string, PluginSettingValue>,
): Record<string, PluginSettingValue> {
    const result: Record<string, PluginSettingValue> = { ...settings };
    for (const [key, value] of Object.entries(settings)) {
        if (isPlaintextSecretValue(value) && isSecretSetting(key, manifest)) {
            result[key] = cipher.encrypt(value, pluginSecretContext(uid, key));
        }
    }
    return result;
}

/** A kept secret `checkKeptPluginSecrets()` couldn't decrypt to check it. The value is never in the message. */
export class PluginSecretUnreadableError extends Error {}

/** What of a setting's definition its value is checked against (`validatePluginSettings()`): two definitions that differ only in their label,
 * description or default take the same values. */
function valueRule(definition: PluginSettingDefinition): string {
    return JSON.stringify([definition.type, definition.min ?? null, definition.max ?? null, (definition.options ?? []).map((option) => option.value)]);
}

/** The value `envelope` of setting `key` of the row `uid` holds, or `undefined` when it can't be read: no cipher, a key that isn't in the ring, an envelope
 * from another row or setting. Anything but a secret that can't be read is a bug and is thrown. */
function decryptKept(cipher: Pick<ConfigCipher, "decrypt"> | undefined, uid: string, key: string, envelope: ConfigEnvelope): ConfigSecretValue | undefined {
    try {
        return cipher?.decrypt(envelope, pluginSecretContext(uid, key));
    } catch (err) {
        if (!(err instanceof ConfigSecretUnavailableError)) {
            throw err;
        }
        return undefined;
    }
}

/**
 * Checks the envelopes a plugin keeps across a change of version (`kept`: carried from the row `uid`, or sent back as the mask) against `manifest`, the new
 * version's. An envelope leaves the value sealed, so without this a value the new version types or bounds differently would be carried unchecked, where the
 * same value held in plaintext is refused. A setting whose definition takes the same values as in `previous` (the row's manifest) is kept unread; any other's
 * value is decrypted and checked as a saved value is, throwing the `Error` `validatePluginSettings()` does (naming the setting, never the value). A value
 * that can't be decrypted (a key that isn't in the ring, an envelope from another row, no `cipher`) throws a `PluginSecretUnreadableError`: refused rather than
 * carried unchecked.
 */
export function checkKeptPluginSecrets(
    cipher: Pick<ConfigCipher, "decrypt"> | undefined,
    uid: string,
    previous: Pick<PluginManifest, "settings"> | undefined,
    manifest: PluginManifest,
    kept: Record<string, ConfigEnvelope>,
): void {
    for (const [key, envelope] of Object.entries(kept)) {
        const definition: PluginSettingDefinition | undefined = manifest.settings?.find((setting) => setting.key === key);
        const before: PluginSettingDefinition | undefined = previous?.settings?.find((setting) => setting.key === key);
        if (!definition || (before && valueRule(before) === valueRule(definition))) {
            // A setting the version doesn't declare is refused by `validatePluginSettings()` itself.
            continue;
        }
        const value: ConfigSecretValue | undefined = decryptKept(cipher, uid, key, envelope);
        if (value === undefined) {
            throw new PluginSecretUnreadableError(`The saved value of '${definition.label}' can't be read to check it against this version. Save a new value for it.`);
        }
        validatePluginSettings({ ...manifest, settings: [definition] }, { [key]: value });
    }
}

/** The secret settings `plugin` still holds the value of on its row (`isSecretSetting()` and `isPlaintextSecretValue()`), in the row's order. */
export function plaintextSecretKeys(plugin: Pick<Plugin, "settings" | "manifest">): string[] {
    return Object.entries(plugin.settings ?? {})
        .filter(([key, value]) => isPlaintextSecretValue(value) && isSecretSetting(key, plugin.manifest))
        .map(([key]) => key);
}

/** Every secret setting `plugins` still hold in plaintext: what the encryption run encrypts and, until it has run, what Diagnostics may warn about. */
export function plaintextPluginSecrets(plugins: Pick<Plugin, "name" | "settings" | "manifest">[]): PluginSecretKey[] {
    return plugins.flatMap((plugin) => plaintextSecretKeys(plugin).map((key) => ({ name: plugin.name, key })));
}

/** `settings` without any secret setting, envelope or value: what an uninstalled plugin's row keeps (adding it again starts from its defaults). */
export function withoutSecretSettings(
    settings: Record<string, PluginSettingValue> | undefined,
    manifest: Plugin["manifest"] | undefined,
): Record<string, PluginSettingValue> {
    return Object.fromEntries(Object.entries(settings ?? {}).filter(([key, value]) => !isConfigEnvelope(value) && !isSecretSetting(key, manifest)));
}
