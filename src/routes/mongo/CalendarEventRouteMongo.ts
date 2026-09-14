///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { CalendarEventMongo, CalendarShareLinkMongo, FolderMongo, MailboxMongo } from "../../mongo.js";
import { BaseCalendarEventRoute } from "../BaseCalendarEventRoute.js";
import { RecoverableRepoUtils } from "../../util/RecoverableRepoUtils.js";
const { Model } = RouteDecorators;

@Model(CalendarEventMongo)
export class CalendarEventRouteMongo extends BaseCalendarEventRoute<CalendarEventMongo> {
    protected readonly repoUtilsClass: any = RecoverableRepoUtils;
    protected mailboxClass: any = MailboxMongo;
    protected folderClass: any = FolderMongo;
    protected shareLinkClass: any = CalendarShareLinkMongo;
}
