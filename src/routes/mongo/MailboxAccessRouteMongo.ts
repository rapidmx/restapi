///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntryMongo, MailboxMongo } from "../../mongo.js";
import { BaseMailboxAccessRoute } from "../BaseMailboxAccessRoute.js";

export class MailboxAccessRouteMongo extends BaseMailboxAccessRoute<MailboxMongo> {
    protected mailboxClass: any = MailboxMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
