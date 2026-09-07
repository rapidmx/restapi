///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { TaskListMongo } from "../../mongo.js";
import { BaseScopedChildRoute } from "../BaseScopedChildRoute.js";
const { Model } = RouteDecorators;

@Model(TaskListMongo)
export class TaskListRouteMongo extends BaseScopedChildRoute<TaskListMongo> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected readonly scopeProperty: string = "mailboxUid";
}
