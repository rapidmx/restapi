///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntrySQL, DomainSQL, SetupStateSQL } from "../../sql.js";
import { BaseSetupRoute } from "../BaseSetupRoute.js";

export class SetupRouteSQL extends BaseSetupRoute<SetupStateSQL> {
    protected setupStateClass: any = SetupStateSQL;
    protected domainClass: any = DomainSQL;
    protected auditLogClass: any = AuditLogEntrySQL;
}
