///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntryMongo, RetentionPolicyMongo } from "../../mongo.js";
import { BaseRetentionPolicyRoute } from "../BaseRetentionPolicyRoute.js";

export class RetentionPolicyRouteMongo extends BaseRetentionPolicyRoute<RetentionPolicyMongo> {
    protected retentionPolicyClass: any = RetentionPolicyMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
