///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntrySQL, BrandingSQL } from "../../sql.js";
import { BaseBrandingRoute } from "../BaseBrandingRoute.js";

export class BrandingRouteSQL extends BaseBrandingRoute<BrandingSQL> {
    protected brandingClass: any = BrandingSQL;
    protected auditLogClass: any = AuditLogEntrySQL;
}
