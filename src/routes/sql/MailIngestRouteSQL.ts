///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { Raw } from "typeorm";
import { IngestQueueEntrySQL, MailboxSQL } from "../../sql.js";
import { BaseMailIngestRoute } from "../BaseMailIngestRoute.js";

export class MailIngestRouteSQL extends BaseMailIngestRoute<MailboxSQL, IngestQueueEntrySQL> {
    protected mailboxClass: any = MailboxSQL;
    protected ingestQueueClass: any = IngestQueueEntrySQL;

    /**
     * `MailboxSQL.aliasAddresses` is a `simple-json` column, stored as a serialized JSON array string (e.g.
     * `["a@example.com","b@example.com"]`). A plain equality filter compares against that whole string, so it
     * never matches a single address. Match the serialized substring instead, anchored on the surrounding
     * quotes the JSON encoding produces, so a partial-address match (e.g. "ob@example.co" against a stored
     * "bob@example.com") can't produce a false positive.
     *
     * Returns a TypeORM `Raw()` `FindOperator` (a live object, not an `op(value)`-encoded string) so this can
     * bind `%`/`_` as literal characters via an explicit `ESCAPE` clause — `RepoUtils`'s shared query-string DSL
     * has no such escaping for its own `like(...)` operator, and `address` here ultimately originates from
     * whatever RCPT TO value an anonymous internet SMTP client sends. Without escaping, an address containing
     * `%`/`_` would turn this intended *exact*-alias-match into a wildcard/substring match, enabling blind
     * alias enumeration via `GET /internal/mta/resolve`'s 200/404 response and mis-delivery to an unintended
     * mailbox whose alias happens to satisfy the resulting pattern - a real, confirmed vulnerability, not a
     * theoretical one.
     */
    protected aliasQueryValue(address: string): any {
        const escaped: string = address.replace(/[\\%_]/g, (ch) => `\\${ch}`);
        return Raw((alias) => `${alias} LIKE :pattern ESCAPE '\\'`, { pattern: `%"${escaped}"%` });
    }
}
