///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { FolderMongo } from "../../mongo.js";
import { BaseFolderRoute } from "../BaseFolderRoute.js";
import { RecoverableRepoUtils } from "../../util/RecoverableRepoUtils.js";
const { Model } = RouteDecorators;

@Model(FolderMongo)
export class FolderRouteMongo extends BaseFolderRoute<FolderMongo> {
    protected readonly repoUtilsClass: any = RecoverableRepoUtils;
}
