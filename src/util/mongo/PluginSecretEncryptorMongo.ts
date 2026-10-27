///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntryMongo } from "../../models/mongo/AuditLogEntryMongo.js";
import { ConfigKeyStateMongo } from "../../models/mongo/ConfigKeyStateMongo.js";
import { PluginMongo } from "../../models/mongo/PluginMongo.js";
import { PluginSecretEncryptor } from "../PluginSecretEncryptor.js";

/** The `PluginSecretEncryptor` for a MongoDB deployment. */
export class PluginSecretEncryptorMongo extends PluginSecretEncryptor<PluginMongo, ConfigKeyStateMongo> {
    protected pluginClass: any = PluginMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
    protected configKeyStateClass: any = ConfigKeyStateMongo;
}
