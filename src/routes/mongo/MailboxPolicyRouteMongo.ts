///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntryMongo, MailboxPolicyMongo } from "../../mongo.js";
import { BaseMailboxPolicyRoute } from "../BaseMailboxPolicyRoute.js";

export class MailboxPolicyRouteMongo extends BaseMailboxPolicyRoute<MailboxPolicyMongo> {
    protected mailboxPolicyClass: any = MailboxPolicyMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
