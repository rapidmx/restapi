///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntryMongo, IntegrationSettingsMongo } from "../../mongo.js";
import { BaseIntegrationsRoute } from "../BaseIntegrationsRoute.js";

export class IntegrationsRouteMongo extends BaseIntegrationsRoute<IntegrationSettingsMongo> {
    protected integrationSettingsClass: any = IntegrationSettingsMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
