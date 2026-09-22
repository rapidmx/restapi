///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntryMongo, ContactMongo, DomainMongo, FolderMongo, KeyVaultMongo, MailboxMongo } from "../../mongo.js";
import { BaseKeyLookupRoute } from "../BaseKeyLookupRoute.js";

export class KeyLookupRouteMongo extends BaseKeyLookupRoute<MailboxMongo, ContactMongo, FolderMongo> {
    protected mailboxClass: any = MailboxMongo;
    protected contactClass: any = ContactMongo;
    protected folderClass: any = FolderMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
    protected keyVaultClass: any = KeyVaultMongo;
    protected domainClass: any = DomainMongo;
}
