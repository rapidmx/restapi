///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntrySQL, MailboxPolicySQL } from "../../sql.js";
import { BaseMailboxPolicyRoute } from "../BaseMailboxPolicyRoute.js";

export class MailboxPolicyRouteSQL extends BaseMailboxPolicyRoute<MailboxPolicySQL> {
    protected mailboxPolicyClass: any = MailboxPolicySQL;
    protected auditLogClass: any = AuditLogEntrySQL;
}
