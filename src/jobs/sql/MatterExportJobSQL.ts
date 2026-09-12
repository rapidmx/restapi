///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MatterExportJob } from "../MatterExportJob.js";
import {
    AttachmentSQL,
    AuditLogEntrySQL,
    CalendarEventSQL,
    ContactListSQL,
    ContactSQL,
    EscrowAuditLogEntrySQL,
    MailboxSQL,
    MatterExportRequestSQL,
    MatterSQL,
    MessageSQL,
    NoteSQL,
    TaskSQL,
} from "../../sql.js";

export class MatterExportJobSQL extends MatterExportJob<MatterExportRequestSQL, MatterSQL, MailboxSQL> {
    protected matterExportRequestClass: any = MatterExportRequestSQL;
    protected matterClass: any = MatterSQL;
    protected mailboxClass: any = MailboxSQL;
    protected messageClass: any = MessageSQL;
    protected contactClass: any = ContactSQL;
    protected contactListClass: any = ContactListSQL;
    protected calendarEventClass: any = CalendarEventSQL;
    protected taskClass: any = TaskSQL;
    protected noteClass: any = NoteSQL;
    protected attachmentClass: any = AttachmentSQL;
    protected escrowAuditLogClass: any = EscrowAuditLogEntrySQL;
    protected auditLogClass: any = AuditLogEntrySQL;
}
