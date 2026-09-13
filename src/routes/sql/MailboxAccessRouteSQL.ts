///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { Raw } from "typeorm";
import { MailboxSQL } from "../../sql.js";
import { BaseMailboxAccessRoute } from "../BaseMailboxAccessRoute.js";

export class MailboxAccessRouteSQL extends BaseMailboxAccessRoute<MailboxSQL> {
    protected mailboxClass: any = MailboxSQL;

    /** `aliasAddresses` is stored as a serialized `simple-json` column on the SQL backend - a plain
     * equality filter compares against the whole serialized string and never matches a single element.
     * Mirrors `MailIngestRouteSQL.aliasQueryValue()`'s identical LIKE-escape shape. */
    protected aliasQueryValue(address: string): any {
        const escaped: string = address.replace(/[\\%_]/g, (ch) => `\\${ch}`);
        return Raw((alias) => `${alias} LIKE :pattern ESCAPE '\\'`, { pattern: `%"${escaped}"%` });
    }
}
