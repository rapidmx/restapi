///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { CalendarShareLinkMongo } from "../../mongo.js";
import { BaseCalendarShareLinkRoute } from "../BaseCalendarShareLinkRoute.js";
const { Model } = RouteDecorators;

@Model(CalendarShareLinkMongo)
export class CalendarShareLinkRouteMongo extends BaseCalendarShareLinkRoute<CalendarShareLinkMongo> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected readonly scopeProperty: string = "folderUid";
}
