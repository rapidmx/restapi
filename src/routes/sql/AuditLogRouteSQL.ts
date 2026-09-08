///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { AuditLogEntrySQL } from "../../sql.js";
import { BaseAuditLogRoute } from "../BaseAuditLogRoute.js";
const { Model } = RouteDecorators;

@Model(AuditLogEntrySQL)
export class AuditLogRouteSQL extends BaseAuditLogRoute<AuditLogEntrySQL> {
    protected readonly repoUtilsClass: any = RepoUtils;
}
