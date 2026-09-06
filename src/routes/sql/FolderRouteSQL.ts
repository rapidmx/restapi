///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { FolderSQL } from "../../sql.js";
import { BaseFolderRoute } from "../BaseFolderRoute.js";
import { RecoverableRepoUtils } from "../../util/RecoverableRepoUtils.js";
const { Model } = RouteDecorators;

@Model(FolderSQL)
export class FolderRouteSQL extends BaseFolderRoute<FolderSQL> {
    protected readonly repoUtilsClass: any = RecoverableRepoUtils;
}
