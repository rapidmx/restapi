///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { Raw } from "typeorm";
import { AuditLogEntrySQL, ContactSQL, DomainSQL, FolderSQL, KeyVaultSQL, MailboxSQL } from "../../sql.js";
import { BaseKeyLookupRoute } from "../BaseKeyLookupRoute.js";

export class KeyLookupRouteSQL extends BaseKeyLookupRoute<MailboxSQL, ContactSQL, FolderSQL> {
    protected mailboxClass: any = MailboxSQL;
    protected contactClass: any = ContactSQL;
    protected folderClass: any = FolderSQL;
    protected auditLogClass: any = AuditLogEntrySQL;
    protected keyVaultClass: any = KeyVaultSQL;
    protected domainClass: any = DomainSQL;

    /** `MailboxSQL.aliasAddresses` is a serialized `simple-json` column - see `MailIngestRouteSQL.aliasQueryValue()`, whose
     * anchored, `ESCAPE`d LIKE this repeats so a `%`/`_` in an address can't turn the exact match into a wildcard one. */
    protected aliasQueryValue(address: string): any {
        const escaped: string = address.replace(/[\\%_]/g, (ch) => `\\${ch}`);
        return Raw((alias) => `${alias} LIKE :pattern ESCAPE '\\'`, { pattern: `%"${escaped}"%` });
    }

    /** See `ScanQueueJobSQL.contactEmailQuery()`'s identical doc comment - `emails` is a serialized
     * `simple-json` column on this backend, so a LIKE scan against its serialized form is the only way to
     * match an array element's field, with the address escaped so a literal `%`/`_` can't turn this intended
     * exact match into a wildcard one. */
    protected contactEmailQuery(address: string): any {
        const escaped: string = address.replace(/[\\%_]/g, (ch) => `\\${ch}`);
        return { emails: Raw((alias) => `${alias} LIKE :pattern ESCAPE '\\'`, { pattern: `%"address":"${escaped}"%` }) };
    }
}
