///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { ConfigEnvelope, IntegrationPluginNamespace, IntegrationSettings } from "../models/types.js";
import { isConfigEnvelope } from "../secrets/ConfigCipher.js";
import type { ConfigEnvelopeRef, ConfigEnvelopeSource } from "../secrets/ConfigEnvelopeSource.js";
import { GIPHY_API_KEY_FIELD, INTEGRATION_SETTINGS_RECORD, PLUGIN_REGISTRY_TOKEN_FIELD, pluginNamespaceTokenField } from "./IntegrationSettingsUtils.js";

/**
 * Where `ConfigKeyRotationJob` finds the envelopes of the Integrations settings row (spec 5.5): the Giphy key, the plugin registry token and each plugin
 * namespace's token, under the field paths their associated data names. Replacing some of them saves the whole of each section that holds one (`giphy`,
 * `pluginRegistry`), since a row is replaced, not patched, and nothing else: the plaintext is the same, so the server's integrations layer has nothing to
 * rebuild.
 *
 * @param modelClass The datastore's entity class (`IntegrationSettingsMongo`, `IntegrationSettingsSQL`).
 */
export function integrationSettingsEnvelopeSource(modelClass: any): ConfigEnvelopeSource<IntegrationSettings> {
    return {
        record: INTEGRATION_SETTINGS_RECORD,
        modelClass,
        envelopes: (row) => {
            const found: ConfigEnvelopeRef[] = [];
            const add = (field: string, envelope: unknown): void => {
                if (isConfigEnvelope(envelope)) {
                    found.push({ field, envelope });
                }
            };
            add(GIPHY_API_KEY_FIELD, row.giphy?.apiKey);
            add(PLUGIN_REGISTRY_TOKEN_FIELD, row.pluginRegistry?.token);
            for (const namespace of row.pluginRegistry?.namespaces ?? []) {
                add(pluginNamespaceTokenField(namespace.name), namespace.token);
            }
            return found;
        },
        replace: (row, replacements) => {
            const changes: Record<string, unknown> = {};
            /** The envelope that replaces the one at `field`, when `current` is an envelope and a replacement was made for it. */
            const replaced = (field: string, current: unknown): ConfigEnvelope | undefined => (isConfigEnvelope(current) ? replacements[field] : undefined);

            const apiKey: ConfigEnvelope | undefined = replaced(GIPHY_API_KEY_FIELD, row.giphy?.apiKey);
            if (row.giphy && apiKey) {
                changes.giphy = { ...row.giphy, apiKey };
            }

            const token: ConfigEnvelope | undefined = replaced(PLUGIN_REGISTRY_TOKEN_FIELD, row.pluginRegistry?.token);
            const namespaces: IntegrationPluginNamespace[] | undefined = row.pluginRegistry?.namespaces?.map((namespace) => {
                const next: ConfigEnvelope | undefined = replaced(pluginNamespaceTokenField(namespace.name), namespace.token);
                return next ? { ...namespace, token: next } : namespace;
            });
            if (row.pluginRegistry && (token || namespaces?.some((namespace, index) => namespace !== row.pluginRegistry!.namespaces![index]))) {
                changes.pluginRegistry = { ...row.pluginRegistry, ...(token ? { token } : {}), ...(namespaces ? { namespaces } : {}) };
            }
            return changes;
        },
    };
}
