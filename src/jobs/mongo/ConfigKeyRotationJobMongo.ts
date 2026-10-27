///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { dnsProviderEnvelopeSource } from "../../dns/DnsProviderEnvelopeSource.js";
import { pluginEnvelopeSource } from "../../plugins/PluginEnvelopeSource.js";
import type { ConfigEnvelopeSourceRegistry } from "../../secrets/ConfigEnvelopeSource.js";
import { integrationSettingsEnvelopeSource } from "../../util/IntegrationSettingsEnvelopeSource.js";
import { ConfigKeyRotationJob } from "../ConfigKeyRotationJob.js";
import { AuditLogEntryMongo, ConfigKeyStateMongo, DnsProviderMongo, IntegrationSettingsMongo, PluginMongo } from "../../mongo.js";

export class ConfigKeyRotationJobMongo extends ConfigKeyRotationJob<ConfigKeyStateMongo> {
    protected configKeyStateClass: any = ConfigKeyStateMongo;
    protected auditLogClass: any = AuditLogEntryMongo;

    /** The record types that hold envelopes in this datastore: the credentials of the DNS provider configs, the Integrations settings' secrets and a plugin's secret settings. */
    protected registerSources(registry: ConfigEnvelopeSourceRegistry): void {
        registry.register(dnsProviderEnvelopeSource(DnsProviderMongo));
        registry.register(integrationSettingsEnvelopeSource(IntegrationSettingsMongo));
        registry.register(pluginEnvelopeSource(PluginMongo));
    }
}
