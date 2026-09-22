///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntrySQL } from "../../sql.js";
import { BaseSigningEnrollmentAdminRoute } from "../BaseSigningEnrollmentAdminRoute.js";

export class SigningEnrollmentAdminRouteSQL extends BaseSigningEnrollmentAdminRoute {
    protected auditLogClass: any = AuditLogEntrySQL;
}
