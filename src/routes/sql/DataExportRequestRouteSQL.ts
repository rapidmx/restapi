///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntrySQL, DataExportRequestSQL, MailboxSQL } from "../../sql.js";
import { BaseDataExportRoute } from "../BaseDataExportRoute.js";

export class DataExportRequestRouteSQL extends BaseDataExportRoute<DataExportRequestSQL, MailboxSQL> {
    protected dataExportRequestClass: any = DataExportRequestSQL;
    protected mailboxClass: any = MailboxSQL;
    protected auditLogClass: any = AuditLogEntrySQL;
}
