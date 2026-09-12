///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MailboxImportJob } from "../MailboxImportJob.js";
import { AttachmentSQL, AuditLogEntrySQL, FolderSQL, MailboxImportRequestSQL, MailboxSQL, MessageSQL } from "../../sql.js";

export class MailboxImportJobSQL extends MailboxImportJob<MailboxImportRequestSQL, MailboxSQL, FolderSQL, MessageSQL> {
    protected mailboxImportRequestClass: any = MailboxImportRequestSQL;
    protected mailboxClass: any = MailboxSQL;
    protected folderClass: any = FolderSQL;
    protected messageClass: any = MessageSQL;
    protected attachmentClass: any = AttachmentSQL;
    protected auditLogClass: any = AuditLogEntrySQL;
}
