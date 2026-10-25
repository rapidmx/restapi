///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ErasureExecutionJob } from "../ErasureExecutionJob.js";
import {
    AttachmentMongo,
    AuditLogEntryMongo,
    CalendarEventAttendeeLinkMongo,
    CalendarEventMongo,
    CalendarShareLinkMongo,
    ContactListMongo,
    ContactMongo,
    CorrespondentMongo,
    DataExportRequestMongo,
    DataSubjectErasureRequestMongo,
    FocusedInboxOverrideMongo,
    FolderMongo,
    IngestQueueEntryMongo,
    KeyVaultMongo,
    LabelMongo,
    MailFilterRuleMongo,
    MailSignatureMongo,
    MailboxImportRequestMongo,
    MailboxMongo,
    MatterMongo,
    MessageMongo,
    NoteMongo,
    OofReplySuppressionMongo,
    PluginMongo,
    QuarantineEntryMongo,
    TaskListMongo,
    TaskMongo,
    ZeroAccessIndexEntryMongo,
    ZeroAccessIndexSegmentMongo,
} from "../../mongo.js";

export class ErasureExecutionJobMongo extends ErasureExecutionJob<DataSubjectErasureRequestMongo, MailboxMongo> {
    protected dataSubjectErasureRequestClass: any = DataSubjectErasureRequestMongo;
    protected mailboxClass: any = MailboxMongo;
    protected folderClass: any = FolderMongo;
    protected messageClass: any = MessageMongo;
    protected contactClass: any = ContactMongo;
    protected contactListClass: any = ContactListMongo;
    protected calendarEventClass: any = CalendarEventMongo;
    protected calendarEventAttendeeLinkClass: any = CalendarEventAttendeeLinkMongo;
    protected taskClass: any = TaskMongo;
    protected noteClass: any = NoteMongo;
    protected attachmentClass: any = AttachmentMongo;
    protected focusedInboxOverrideClass: any = FocusedInboxOverrideMongo;
    protected taskListClass: any = TaskListMongo;
    protected labelClass: any = LabelMongo;
    protected correspondentClass: any = CorrespondentMongo;
    protected mailFilterRuleClass: any = MailFilterRuleMongo;
    protected mailSignatureClass: any = MailSignatureMongo;
    protected oofReplySuppressionClass: any = OofReplySuppressionMongo;
    protected quarantineEntryClass: any = QuarantineEntryMongo;
    protected ingestQueueEntryClass: any = IngestQueueEntryMongo;
    protected dataExportRequestClass: any = DataExportRequestMongo;
    protected mailboxImportRequestClass: any = MailboxImportRequestMongo;
    protected keyVaultClass: any = KeyVaultMongo;
    protected zeroAccessIndexEntryClass: any = ZeroAccessIndexEntryMongo;
    protected zeroAccessIndexSegmentClass: any = ZeroAccessIndexSegmentMongo;
    protected calendarShareLinkClass: any = CalendarShareLinkMongo;
    protected pluginClass: any = PluginMongo;
    protected matterClass: any = MatterMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
