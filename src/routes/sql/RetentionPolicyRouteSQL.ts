///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntrySQL, RetentionPolicySQL } from "../../sql.js";
import { BaseRetentionPolicyRoute } from "../BaseRetentionPolicyRoute.js";

export class RetentionPolicyRouteSQL extends BaseRetentionPolicyRoute<RetentionPolicySQL> {
    protected retentionPolicyClass: any = RetentionPolicySQL;
    protected auditLogClass: any = AuditLogEntrySQL;
}
