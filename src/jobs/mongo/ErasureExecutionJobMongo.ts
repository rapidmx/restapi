///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ErasureExecutionJob } from "../ErasureExecutionJob.js";
import {
    AttachmentMongo,
    AuditLogEntryMongo,
    CalendarEventMongo,
    ContactListMongo,
    ContactMongo,
    DataSubjectErasureRequestMongo,
    FolderMongo,
    MailboxMongo,
    MatterMongo,
    MessageMongo,
    NoteMongo,
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
    protected matterClass: any = MatterMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
