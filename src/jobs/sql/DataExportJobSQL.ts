///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { DataExportJob } from "../DataExportJob.js";
import {
    AttachmentSQL,
    AuditLogEntrySQL,
    CalendarEventSQL,
    ContactListSQL,
    ContactSQL,
    DataExportRequestSQL,
    MailboxSQL,
    MessageSQL,
    NoteSQL,
    TaskSQL,
} from "../../sql.js";

export class DataExportJobSQL extends DataExportJob<DataExportRequestSQL, MailboxSQL> {
    protected dataExportRequestClass: any = DataExportRequestSQL;
    protected mailboxClass: any = MailboxSQL;
    protected messageClass: any = MessageSQL;
    protected contactClass: any = ContactSQL;
    protected contactListClass: any = ContactListSQL;
    protected calendarEventClass: any = CalendarEventSQL;
    protected taskClass: any = TaskSQL;
    protected noteClass: any = NoteSQL;
    protected attachmentClass: any = AttachmentSQL;
    protected auditLogClass: any = AuditLogEntrySQL;
}
