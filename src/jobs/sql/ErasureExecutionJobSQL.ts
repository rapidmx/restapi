///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ErasureExecutionJob } from "../ErasureExecutionJob.js";
import {
    AttachmentSQL,
    AuditLogEntrySQL,
    BookingSQL,
    BookingTypeSQL,
    CalendarShareLinkSQL,
    CalendarEventSQL,
    ContactListSQL,
    ContactSQL,
    DataExportRequestSQL,
    DataSubjectErasureRequestSQL,
    FocusedInboxOverrideSQL,
    FolderSQL,
    IngestQueueEntrySQL,
    KeyVaultSQL,
    LabelSQL,
    MailboxImportRequestSQL,
    MailboxSQL,
    MailFilterRuleSQL,
    MailSignatureSQL,
    MatterSQL,
    MessageSQL,
    NoteSQL,
    OofReplySuppressionSQL,
    PluginSQL,
    QuarantineEntrySQL,
    TaskListSQL,
    TaskSQL,
} from "../../sql.js";

export class ErasureExecutionJobSQL extends ErasureExecutionJob<DataSubjectErasureRequestSQL, MailboxSQL> {
    protected dataSubjectErasureRequestClass: any = DataSubjectErasureRequestSQL;
    protected mailboxClass: any = MailboxSQL;
    protected folderClass: any = FolderSQL;
    protected messageClass: any = MessageSQL;
    protected contactClass: any = ContactSQL;
    protected contactListClass: any = ContactListSQL;
    protected calendarEventClass: any = CalendarEventSQL;
    protected taskClass: any = TaskSQL;
    protected noteClass: any = NoteSQL;
    protected attachmentClass: any = AttachmentSQL;
    protected focusedInboxOverrideClass: any = FocusedInboxOverrideSQL;
    protected taskListClass: any = TaskListSQL;
    protected labelClass: any = LabelSQL;
    protected mailFilterRuleClass: any = MailFilterRuleSQL;
    protected mailSignatureClass: any = MailSignatureSQL;
    protected bookingTypeClass: any = BookingTypeSQL;
    protected bookingClass: any = BookingSQL;
    protected oofReplySuppressionClass: any = OofReplySuppressionSQL;
    protected quarantineEntryClass: any = QuarantineEntrySQL;
    protected ingestQueueEntryClass: any = IngestQueueEntrySQL;
    protected dataExportRequestClass: any = DataExportRequestSQL;
    protected mailboxImportRequestClass: any = MailboxImportRequestSQL;
    protected keyVaultClass: any = KeyVaultSQL;
    protected calendarShareLinkClass: any = CalendarShareLinkSQL;
    protected pluginClass: any = PluginSQL;
    protected matterClass: any = MatterSQL;
    protected auditLogClass: any = AuditLogEntrySQL;
}
