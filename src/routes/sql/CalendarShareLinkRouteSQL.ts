///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { CalendarShareLinkSQL } from "../../sql.js";
import { BaseCalendarShareLinkRoute } from "../BaseCalendarShareLinkRoute.js";
const { Model } = RouteDecorators;

@Model(CalendarShareLinkSQL)
export class CalendarShareLinkRouteSQL extends BaseCalendarShareLinkRoute<CalendarShareLinkSQL> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected readonly scopeProperty: string = "folderUid";
}
