///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { FocusedInboxOverrideSQL } from "../../sql.js";
import { BaseFocusedInboxOverrideRoute } from "../BaseFocusedInboxOverrideRoute.js";
const { Model } = RouteDecorators;

@Model(FocusedInboxOverrideSQL)
export class FocusedInboxOverrideRouteSQL extends BaseFocusedInboxOverrideRoute<FocusedInboxOverrideSQL> {
    protected readonly repoUtilsClass: any = RepoUtils;
}
