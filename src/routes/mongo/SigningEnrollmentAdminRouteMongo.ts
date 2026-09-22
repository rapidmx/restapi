///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntryMongo } from "../../mongo.js";
import { BaseSigningEnrollmentAdminRoute } from "../BaseSigningEnrollmentAdminRoute.js";

export class SigningEnrollmentAdminRouteMongo extends BaseSigningEnrollmentAdminRoute {
    protected auditLogClass: any = AuditLogEntryMongo;
}
