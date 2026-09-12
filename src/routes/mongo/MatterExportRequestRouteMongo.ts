///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { EscrowAuditLogEntryMongo, EscrowScopeMongo, MailboxMongo, MatterExportRequestMongo, MatterMongo } from "../../mongo.js";
import { BaseMatterExportRequestRoute } from "../BaseMatterExportRequestRoute.js";

export class MatterExportRequestRouteMongo extends BaseMatterExportRequestRoute<MatterExportRequestMongo, MatterMongo, MailboxMongo> {
    protected matterExportRequestClass: any = MatterExportRequestMongo;
    protected matterClass: any = MatterMongo;
    protected mailboxClass: any = MailboxMongo;
    protected escrowScopeClass: any = EscrowScopeMongo;
    protected escrowAuditLogClass: any = EscrowAuditLogEntryMongo;
}
