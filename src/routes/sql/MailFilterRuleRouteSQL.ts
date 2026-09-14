///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { FolderSQL, LabelSQL, MailFilterRuleSQL } from "../../sql.js";
import { BaseMailFilterRuleRoute } from "../BaseMailFilterRuleRoute.js";
const { Model } = RouteDecorators;

@Model(MailFilterRuleSQL)
export class MailFilterRuleRouteSQL extends BaseMailFilterRuleRoute<MailFilterRuleSQL> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected folderClass: any = FolderSQL;
    protected labelClass: any = LabelSQL;
}
