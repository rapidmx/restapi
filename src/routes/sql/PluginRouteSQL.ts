///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntrySQL, PluginSQL } from "../../sql.js";
import { BasePluginRoute } from "../BasePluginRoute.js";

export class PluginRouteSQL extends BasePluginRoute<PluginSQL> {
    protected pluginClass: any = PluginSQL;
    protected auditLogClass: any = AuditLogEntrySQL;
}
