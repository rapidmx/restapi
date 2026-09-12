///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { DataExportJob } from "../DataExportJob.js";
import {
    AttachmentMongo,
    AuditLogEntryMongo,
    CalendarEventMongo,
    ContactListMongo,
    ContactMongo,
    DataExportRequestMongo,
    MailboxMongo,
    MessageMongo,
    NoteMongo,
    TaskMongo,
} from "../../mongo.js";

export class DataExportJobMongo extends DataExportJob<DataExportRequestMongo, MailboxMongo> {
    protected dataExportRequestClass: any = DataExportRequestMongo;
    protected mailboxClass: any = MailboxMongo;
    protected messageClass: any = MessageMongo;
    protected contactClass: any = ContactMongo;
    protected contactListClass: any = ContactListMongo;
    protected calendarEventClass: any = CalendarEventMongo;
    protected taskClass: any = TaskMongo;
    protected noteClass: any = NoteMongo;
    protected attachmentClass: any = AttachmentMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
