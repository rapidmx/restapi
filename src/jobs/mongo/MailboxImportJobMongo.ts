///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MailboxImportJob } from "../MailboxImportJob.js";
import { AttachmentMongo, AuditLogEntryMongo, EncryptionPolicyMongo, FolderMongo, MailboxImportRequestMongo, MailboxMongo, MessageMongo, ZeroAccessIndexEntryMongo } from "../../mongo.js";

export class MailboxImportJobMongo extends MailboxImportJob<MailboxImportRequestMongo, MailboxMongo, FolderMongo, MessageMongo> {
    protected mailboxImportRequestClass: any = MailboxImportRequestMongo;
    protected mailboxClass: any = MailboxMongo;
    protected folderClass: any = FolderMongo;
    protected messageClass: any = MessageMongo;
    protected attachmentClass: any = AttachmentMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
    protected encryptionPolicyClass: any = EncryptionPolicyMongo;
    protected zeroAccessIndexEntryClass: any = ZeroAccessIndexEntryMongo;
}
