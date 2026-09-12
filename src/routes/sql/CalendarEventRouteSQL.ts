///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { CalendarEventSQL, FolderSQL, MailboxSQL } from "../../sql.js";
import { BaseCalendarEventRoute } from "../BaseCalendarEventRoute.js";
import { RecoverableRepoUtils } from "../../util/RecoverableRepoUtils.js";
const { Model } = RouteDecorators;

@Model(CalendarEventSQL)
export class CalendarEventRouteSQL extends BaseCalendarEventRoute<CalendarEventSQL> {
    protected readonly repoUtilsClass: any = RecoverableRepoUtils;
    protected mailboxClass: any = MailboxSQL;
    protected folderClass: any = FolderSQL;
}
