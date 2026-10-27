///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntryMongo } from "../../models/mongo/AuditLogEntryMongo.js";
import { PluginMongo } from "../../models/mongo/PluginMongo.js";
import { PluginSecretMigrator } from "../PluginSecretMigrator.js";

export class PluginSecretMigratorMongo extends PluginSecretMigrator<PluginMongo> {
    protected pluginClass: any = PluginMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
