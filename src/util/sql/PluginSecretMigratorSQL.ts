///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntrySQL } from "../../models/sql/AuditLogEntrySQL.js";
import { PluginSQL } from "../../models/sql/PluginSQL.js";
import { PluginSecretMigrator } from "../PluginSecretMigrator.js";

export class PluginSecretMigratorSQL extends PluginSecretMigrator<PluginSQL> {
    protected pluginClass: any = PluginSQL;
    protected auditLogClass: any = AuditLogEntrySQL;
}
