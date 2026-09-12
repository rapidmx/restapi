///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntryMongo, DataExportRequestMongo, MailboxMongo } from "../../mongo.js";
import { BaseDataExportRoute } from "../BaseDataExportRoute.js";

export class DataExportRequestRouteMongo extends BaseDataExportRoute<DataExportRequestMongo, MailboxMongo> {
    protected dataExportRequestClass: any = DataExportRequestMongo;
    protected mailboxClass: any = MailboxMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
