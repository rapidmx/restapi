///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { dnsProviderEnvelopeSource } from "../../dns/DnsProviderEnvelopeSource.js";
import { pluginEnvelopeSource } from "../../plugins/PluginEnvelopeSource.js";
import type { ConfigEnvelopeSourceRegistry } from "../../secrets/ConfigEnvelopeSource.js";
import { integrationSettingsEnvelopeSource } from "../../util/IntegrationSettingsEnvelopeSource.js";
import { ConfigKeyRotationJob } from "../ConfigKeyRotationJob.js";
import { AuditLogEntrySQL, ConfigKeyStateSQL, DnsProviderSQL, IntegrationSettingsSQL, PluginSQL } from "../../sql.js";

export class ConfigKeyRotationJobSQL extends ConfigKeyRotationJob<ConfigKeyStateSQL> {
    protected configKeyStateClass: any = ConfigKeyStateSQL;
    protected auditLogClass: any = AuditLogEntrySQL;

    /** The record types that hold envelopes in this datastore: the credentials of the DNS provider configs, the Integrations settings' secrets and a plugin's secret settings. */
    protected registerSources(registry: ConfigEnvelopeSourceRegistry): void {
        registry.register(dnsProviderEnvelopeSource(DnsProviderSQL));
        registry.register(integrationSettingsEnvelopeSource(IntegrationSettingsSQL));
        registry.register(pluginEnvelopeSource(PluginSQL));
    }
}
