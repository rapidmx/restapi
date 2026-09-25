///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntrySQL, DataSubjectErasureRequestSQL, FolderSQL, MailboxSQL, MatterSQL } from "../../sql.js";
import { BaseDataSubjectErasureRequestRoute } from "../BaseDataSubjectErasureRequestRoute.js";

export class DataSubjectErasureRequestRouteSQL extends BaseDataSubjectErasureRequestRoute<DataSubjectErasureRequestSQL, MailboxSQL> {
    protected dataSubjectErasureRequestClass: any = DataSubjectErasureRequestSQL;
    protected mailboxClass: any = MailboxSQL;
    protected folderClass: any = FolderSQL;
    protected matterClass: any = MatterSQL;
    protected auditLogClass: any = AuditLogEntrySQL;
}
