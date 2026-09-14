///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RetentionEnforcementJob } from "../RetentionEnforcementJob.js";
import { AttachmentMongo, AuditLogEntryMongo, IngestQueueEntryMongo, MatterMongo, MessageMongo, QuarantineEntryMongo, RetentionPolicyMongo } from "../../mongo.js";

export class RetentionEnforcementJobMongo extends RetentionEnforcementJob<RetentionPolicyMongo, MessageMongo, AuditLogEntryMongo, AttachmentMongo> {
    protected retentionPolicyClass: any = RetentionPolicyMongo;
    protected messageClass: any = MessageMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
    protected attachmentClass: any = AttachmentMongo;
    protected quarantineEntryClass: any = QuarantineEntryMongo;
    protected ingestQueueEntryClass: any = IngestQueueEntryMongo;
    protected matterClass: any = MatterMongo;
}
