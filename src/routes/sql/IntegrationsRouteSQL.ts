///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntrySQL, IntegrationSettingsSQL } from "../../sql.js";
import { BaseIntegrationsRoute } from "../BaseIntegrationsRoute.js";

export class IntegrationsRouteSQL extends BaseIntegrationsRoute<IntegrationSettingsSQL> {
    protected integrationSettingsClass: any = IntegrationSettingsSQL;
    protected auditLogClass: any = AuditLogEntrySQL;
}
