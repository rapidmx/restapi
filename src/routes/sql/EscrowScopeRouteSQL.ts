///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { AuditLogEntrySQL, EscrowScopeSQL, MatterSQL } from "../../sql.js";
import { BaseEscrowScopeRoute } from "../BaseEscrowScopeRoute.js";
const { Model } = RouteDecorators;

@Model(EscrowScopeSQL)
export class EscrowScopeRouteSQL extends BaseEscrowScopeRoute<EscrowScopeSQL> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected auditLogClass: any = AuditLogEntrySQL;
    protected matterClass: any = MatterSQL;
}
