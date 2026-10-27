///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { ConfigEnvelope, Plugin, PluginSettingValue } from "../models/types.js";
import { isConfigEnvelope } from "../secrets/ConfigCipher.js";
import type { ConfigEnvelopeRef, ConfigEnvelopeSource } from "../secrets/ConfigEnvelopeSource.js";
import { PLUGIN_SECRET_RECORD, pluginSecretField } from "./PluginUtils.js";

/**
 * Where `ConfigKeyRotationJob` finds the envelopes of a plugin row (spec 5.5, 5.7): each secret setting that holds one, under the field path its associated data
 * names (`settings.<key>`). Replacing some of them saves the whole `settings` (a row is replaced, not patched) with every other setting as it is. The
 * plaintext is the same, so the plugin-state hash stays as it was and no plugin worker is rolled.
 *
 * @param modelClass The datastore's entity class (`PluginMongo`, `PluginSQL`).
 */
export function pluginEnvelopeSource(modelClass: any): ConfigEnvelopeSource<Plugin> {
    return {
        record: PLUGIN_SECRET_RECORD,
        modelClass,
        envelopes: (row) => {
            const found: ConfigEnvelopeRef[] = [];
            for (const [key, value] of Object.entries(row.settings ?? {})) {
                if (isConfigEnvelope(value)) {
                    found.push({ field: pluginSecretField(key), envelope: value });
                }
            }
            return found;
        },
        replace: (row, replacements) => {
            const settings: Record<string, PluginSettingValue> = { ...row.settings };
            let changed = false;
            for (const [key, value] of Object.entries(settings)) {
                const next: ConfigEnvelope | undefined = isConfigEnvelope(value) ? replacements[pluginSecretField(key)] : undefined;
                if (next) {
                    settings[key] = next;
                    changed = true;
                }
            }
            return changed ? { settings } : {};
        },
    };
}
