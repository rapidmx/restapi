///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntryMongo, ConfigKeyStateMongo } from "../../mongo.js";
import { BaseConfigKeyRoute } from "../BaseConfigKeyRoute.js";

export class ConfigKeyRouteMongo extends BaseConfigKeyRoute<ConfigKeyStateMongo> {
    protected configKeyStateClass: any = ConfigKeyStateMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
