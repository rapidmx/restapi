///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntryMongo, ConfigKeyStateMongo, PluginMongo } from "../../mongo.js";
import { BasePluginRoute } from "../BasePluginRoute.js";

export class PluginRouteMongo extends BasePluginRoute<PluginMongo> {
    protected pluginClass: any = PluginMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
    protected configKeyStateClass: any = ConfigKeyStateMongo;
}
