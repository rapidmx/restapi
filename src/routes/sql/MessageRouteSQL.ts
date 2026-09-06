///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { FolderSQL, MessageSQL } from "../../sql.js";
import { BaseMessageRoute } from "../BaseMessageRoute.js";
import { RecoverableRepoUtils } from "../../util/RecoverableRepoUtils.js";
const { Model } = RouteDecorators;

@Model(MessageSQL)
export class MessageRouteSQL extends BaseMessageRoute<MessageSQL> {
    protected readonly repoUtilsClass: any = RecoverableRepoUtils;
    protected folderClass: any = FolderSQL;
}
