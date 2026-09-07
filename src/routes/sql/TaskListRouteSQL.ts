///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { TaskListSQL } from "../../sql.js";
import { BaseScopedChildRoute } from "../BaseScopedChildRoute.js";
const { Model } = RouteDecorators;

@Model(TaskListSQL)
export class TaskListRouteSQL extends BaseScopedChildRoute<TaskListSQL> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected readonly scopeProperty: string = "mailboxUid";
}
