///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { QuarantineEntrySQL } from "../../sql.js";
import { BaseScopedChildRoute } from "../BaseScopedChildRoute.js";
const { Model } = RouteDecorators;

/**
 * See `QuarantineRouteMongo` for the rationale — identical behavior against the SQL backend.
 */
@Model(QuarantineEntrySQL)
export class QuarantineRouteSQL extends BaseScopedChildRoute<QuarantineEntrySQL> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected readonly scopeProperty: string = "mailboxUid";
}
