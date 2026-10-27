///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntrySQL, ConfigKeyStateSQL } from "../../sql.js";
import { BaseConfigKeyRoute } from "../BaseConfigKeyRoute.js";

export class ConfigKeyRouteSQL extends BaseConfigKeyRoute<ConfigKeyStateSQL> {
    protected configKeyStateClass: any = ConfigKeyStateSQL;
    protected auditLogClass: any = AuditLogEntrySQL;
}
