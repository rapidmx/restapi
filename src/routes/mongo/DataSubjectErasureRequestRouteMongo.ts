///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntryMongo, DataSubjectErasureRequestMongo, MailboxMongo, MatterMongo } from "../../mongo.js";
import { BaseDataSubjectErasureRequestRoute } from "../BaseDataSubjectErasureRequestRoute.js";

export class DataSubjectErasureRequestRouteMongo extends BaseDataSubjectErasureRequestRoute<DataSubjectErasureRequestMongo, MailboxMongo> {
    protected dataSubjectErasureRequestClass: any = DataSubjectErasureRequestMongo;
    protected mailboxClass: any = MailboxMongo;
    protected matterClass: any = MatterMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
