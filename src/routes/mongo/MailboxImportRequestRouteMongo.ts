///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntryMongo, FolderMongo, MailboxImportRequestMongo, MailboxMongo } from "../../mongo.js";
import { BaseMailboxImportRoute } from "../BaseMailboxImportRoute.js";

export class MailboxImportRequestRouteMongo extends BaseMailboxImportRoute<MailboxImportRequestMongo, MailboxMongo, FolderMongo> {
    protected mailboxImportRequestClass: any = MailboxImportRequestMongo;
    protected mailboxClass: any = MailboxMongo;
    protected folderClass: any = FolderMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
