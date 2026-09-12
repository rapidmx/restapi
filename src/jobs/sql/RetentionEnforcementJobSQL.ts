///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RetentionEnforcementJob } from "../RetentionEnforcementJob.js";
import { AttachmentSQL, AuditLogEntrySQL, MatterSQL, MessageSQL, RetentionPolicySQL } from "../../sql.js";

export class RetentionEnforcementJobSQL extends RetentionEnforcementJob<RetentionPolicySQL, MessageSQL, AuditLogEntrySQL, AttachmentSQL> {
    protected retentionPolicyClass: any = RetentionPolicySQL;
    protected messageClass: any = MessageSQL;
    protected auditLogClass: any = AuditLogEntrySQL;
    protected attachmentClass: any = AttachmentSQL;
    protected matterClass: any = MatterSQL;
}
