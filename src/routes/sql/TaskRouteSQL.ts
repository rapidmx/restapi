///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { TaskSQL } from "../../sql.js";
import { BaseScopedChildRoute } from "../BaseScopedChildRoute.js";
import { RecoverableRepoUtils } from "../../util/RecoverableRepoUtils.js";
const { Model } = RouteDecorators;

@Model(TaskSQL)
export class TaskRouteSQL extends BaseScopedChildRoute<TaskSQL> {
    protected readonly repoUtilsClass: any = RecoverableRepoUtils;
    protected readonly scopeProperty: string = "folderUid";
}
