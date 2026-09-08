///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { TransportRuleSQL } from "../../sql.js";
import { BaseTransportRuleRoute } from "../BaseTransportRuleRoute.js";
const { Model } = RouteDecorators;

@Model(TransportRuleSQL)
export class TransportRuleRouteSQL extends BaseTransportRuleRoute<TransportRuleSQL> {
    protected readonly repoUtilsClass: any = RepoUtils;
}
