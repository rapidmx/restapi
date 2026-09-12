///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ErasureExecutionJob } from "../ErasureExecutionJob.js";
import {
    AttachmentSQL,
    AuditLogEntrySQL,
    CalendarEventSQL,
    ContactListSQL,
    ContactSQL,
    DataSubjectErasureRequestSQL,
    FolderSQL,
    MailboxSQL,
    MatterSQL,
    MessageSQL,
    NoteSQL,
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
    protected matterClass: any = MatterSQL;
    protected auditLogClass: any = AuditLogEntrySQL;
}
