///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { FolderMongo, LabelMongo, MailFilterRuleMongo } from "../../mongo.js";
import { BaseMailFilterRuleRoute } from "../BaseMailFilterRuleRoute.js";
const { Model } = RouteDecorators;

@Model(MailFilterRuleMongo)
export class MailFilterRuleRouteMongo extends BaseMailFilterRuleRoute<MailFilterRuleMongo> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected folderClass: any = FolderMongo;
    protected labelClass: any = LabelMongo;
}
