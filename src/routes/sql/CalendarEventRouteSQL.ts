///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { Raw } from "typeorm";
import { CalendarEventSQL, CalendarShareLinkSQL, FolderSQL, MailboxSQL, MessageSQL } from "../../sql.js";
import { BaseCalendarEventRoute } from "../BaseCalendarEventRoute.js";
import { RecoverableRepoUtils } from "../../util/RecoverableRepoUtils.js";
const { Model } = RouteDecorators;

@Model(CalendarEventSQL)
export class CalendarEventRouteSQL extends BaseCalendarEventRoute<CalendarEventSQL> {
    protected readonly repoUtilsClass: any = RecoverableRepoUtils;
    protected mailboxClass: any = MailboxSQL;
    protected messageClass: any = MessageSQL;
    protected folderClass: any = FolderSQL;
    protected shareLinkClass: any = CalendarShareLinkSQL;

    /** `aliasAddresses` is stored as a serialized `simple-json` column on the SQL backend - a plain equality filter compares against the
     * whole serialized string and never matches a single element. Mirrors `MailboxAccessRouteSQL.aliasQueryValue()`'s LIKE-escape shape. */
    protected aliasQueryValue(address: string): any {
        const escaped: string = address.replace(/[\\%_]/g, (ch) => `\\${ch}`);
        return Raw((alias) => `${alias} LIKE :pattern ESCAPE '\\'`, { pattern: `%"${escaped}"%` });
    }
}
