///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { EscrowAuditLogEntrySQL, EscrowScopeSQL, MailboxSQL, MatterExportRequestSQL, MatterSQL } from "../../sql.js";
import { BaseMatterExportRequestRoute } from "../BaseMatterExportRequestRoute.js";

export class MatterExportRequestRouteSQL extends BaseMatterExportRequestRoute<MatterExportRequestSQL, MatterSQL, MailboxSQL> {
    protected matterExportRequestClass: any = MatterExportRequestSQL;
    protected matterClass: any = MatterSQL;
    protected mailboxClass: any = MailboxSQL;
    protected escrowScopeClass: any = EscrowScopeSQL;
    protected escrowAuditLogClass: any = EscrowAuditLogEntrySQL;
}
