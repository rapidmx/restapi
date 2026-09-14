///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ErasureExecutionJob } from "../ErasureExecutionJob.js";
import {
    AttachmentMongo,
    AuditLogEntryMongo,
    BookingMongo,
    BookingTypeMongo,
    CalendarShareLinkMongo,
    CalendarEventMongo,
    ContactListMongo,
    ContactMongo,
    DataExportRequestMongo,
    DataSubjectErasureRequestMongo,
    FocusedInboxOverrideMongo,
    FolderMongo,
    IngestQueueEntryMongo,
    KeyVaultMongo,
    LabelMongo,
    MailboxImportRequestMongo,
    MailboxMongo,
    MailFilterRuleMongo,
    MailSignatureMongo,
    MatterMongo,
    MessageMongo,
    NoteMongo,
    OofReplySuppressionMongo,
    PluginMongo,
    QuarantineEntryMongo,
    TaskListMongo,
    TaskMongo,
} from "../../mongo.js";

export class ErasureExecutionJobMongo extends ErasureExecutionJob<DataSubjectErasureRequestMongo, MailboxMongo> {
    protected dataSubjectErasureRequestClass: any = DataSubjectErasureRequestMongo;
    protected mailboxClass: any = MailboxMongo;
    protected folderClass: any = FolderMongo;
    protected messageClass: any = MessageMongo;
    protected contactClass: any = ContactMongo;
    protected contactListClass: any = ContactListMongo;
    protected calendarEventClass: any = CalendarEventMongo;
    protected taskClass: any = TaskMongo;
    protected noteClass: any = NoteMongo;
    protected attachmentClass: any = AttachmentMongo;
    protected focusedInboxOverrideClass: any = FocusedInboxOverrideMongo;
    protected taskListClass: any = TaskListMongo;
    protected labelClass: any = LabelMongo;
    protected mailFilterRuleClass: any = MailFilterRuleMongo;
    protected mailSignatureClass: any = MailSignatureMongo;
    protected bookingTypeClass: any = BookingTypeMongo;
    protected bookingClass: any = BookingMongo;
    protected oofReplySuppressionClass: any = OofReplySuppressionMongo;
    protected quarantineEntryClass: any = QuarantineEntryMongo;
    protected ingestQueueEntryClass: any = IngestQueueEntryMongo;
    protected dataExportRequestClass: any = DataExportRequestMongo;
    protected mailboxImportRequestClass: any = MailboxImportRequestMongo;
    protected keyVaultClass: any = KeyVaultMongo;
    protected calendarShareLinkClass: any = CalendarShareLinkMongo;
    protected pluginClass: any = PluginMongo;
    protected matterClass: any = MatterMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
