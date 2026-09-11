///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { LabelSQL, MessageSQL } from "../../sql.js";
import { BaseLabelRoute } from "../BaseLabelRoute.js";
const { Model } = RouteDecorators;

@Model(LabelSQL)
export class LabelRouteSQL extends BaseLabelRoute<LabelSQL, MessageSQL> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected messageClass: any = MessageSQL;
}
