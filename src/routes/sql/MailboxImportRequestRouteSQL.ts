///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntrySQL, FolderSQL, MailboxImportRequestSQL, MailboxSQL } from "../../sql.js";
import { BaseMailboxImportRoute } from "../BaseMailboxImportRoute.js";

export class MailboxImportRequestRouteSQL extends BaseMailboxImportRoute<MailboxImportRequestSQL, MailboxSQL, FolderSQL> {
    protected mailboxImportRequestClass: any = MailboxImportRequestSQL;
    protected mailboxClass: any = MailboxSQL;
    protected folderClass: any = FolderSQL;
    protected auditLogClass: any = AuditLogEntrySQL;
}
