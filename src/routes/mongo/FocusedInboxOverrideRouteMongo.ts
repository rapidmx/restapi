///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { FocusedInboxOverrideMongo } from "../../mongo.js";
import { BaseFocusedInboxOverrideRoute } from "../BaseFocusedInboxOverrideRoute.js";
const { Model } = RouteDecorators;

@Model(FocusedInboxOverrideMongo)
export class FocusedInboxOverrideRouteMongo extends BaseFocusedInboxOverrideRoute<FocusedInboxOverrideMongo> {
    protected readonly repoUtilsClass: any = RepoUtils;
}
