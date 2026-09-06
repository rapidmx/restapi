///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { FolderMongo, MessageMongo } from "../../mongo.js";
import { BaseMessageRoute } from "../BaseMessageRoute.js";
import { RecoverableRepoUtils } from "../../util/RecoverableRepoUtils.js";
const { Model } = RouteDecorators;

@Model(MessageMongo)
export class MessageRouteMongo extends BaseMessageRoute<MessageMongo> {
    protected readonly repoUtilsClass: any = RecoverableRepoUtils;
    protected folderClass: any = FolderMongo;
}
