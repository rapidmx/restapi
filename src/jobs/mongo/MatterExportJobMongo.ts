///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MatterExportJob } from "../MatterExportJob.js";
import {
    AttachmentMongo,
    AuditLogEntryMongo,
    CalendarEventMongo,
    ContactListMongo,
    ContactMongo,
    EscrowAuditLogEntryMongo,
    MailboxMongo,
    MatterExportRequestMongo,
    MatterMongo,
    MessageMongo,
    NoteMongo,
    TaskMongo,
} from "../../mongo.js";

export class MatterExportJobMongo extends MatterExportJob<MatterExportRequestMongo, MatterMongo, MailboxMongo> {
    protected matterExportRequestClass: any = MatterExportRequestMongo;
    protected matterClass: any = MatterMongo;
    protected mailboxClass: any = MailboxMongo;
    protected messageClass: any = MessageMongo;
    protected contactClass: any = ContactMongo;
    protected contactListClass: any = ContactListMongo;
    protected calendarEventClass: any = CalendarEventMongo;
    protected taskClass: any = TaskMongo;
    protected noteClass: any = NoteMongo;
    protected attachmentClass: any = AttachmentMongo;
    protected escrowAuditLogClass: any = EscrowAuditLogEntryMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
