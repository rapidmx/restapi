///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntrySQL } from "../../models/sql/AuditLogEntrySQL.js";
import { ConfigKeyStateSQL } from "../../models/sql/ConfigKeyStateSQL.js";
import { PluginSQL } from "../../models/sql/PluginSQL.js";
import { PluginSecretEncryptor } from "../PluginSecretEncryptor.js";

/** The `PluginSecretEncryptor` for a SQL deployment. */
export class PluginSecretEncryptorSQL extends PluginSecretEncryptor<PluginSQL, ConfigKeyStateSQL> {
    protected pluginClass: any = PluginSQL;
    protected auditLogClass: any = AuditLogEntrySQL;
    protected configKeyStateClass: any = ConfigKeyStateSQL;
}
