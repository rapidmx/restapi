///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { EscrowAuditLogEntrySQL, EscrowScopeSQL, MatterSQL } from "../../sql.js";
import { BaseEscrowAuditLogRoute } from "../BaseEscrowAuditLogRoute.js";
const { Model } = RouteDecorators;

@Model(EscrowAuditLogEntrySQL)
export class EscrowAuditLogRouteSQL extends BaseEscrowAuditLogRoute<EscrowAuditLogEntrySQL> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected escrowScopeClass: any = EscrowScopeSQL;
    protected matterClass: any = MatterSQL;
}
