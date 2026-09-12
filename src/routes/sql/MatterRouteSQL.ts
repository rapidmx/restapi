///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { AuditLogEntrySQL, EscrowAccessRequestSQL, EscrowScopeSQL, MatterSQL } from "../../sql.js";
import { BaseMatterRoute } from "../BaseMatterRoute.js";
const { Model } = RouteDecorators;

@Model(MatterSQL)
export class MatterRouteSQL extends BaseMatterRoute<MatterSQL> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected escrowScopeClass: any = EscrowScopeSQL;
    protected auditLogClass: any = AuditLogEntrySQL;
    protected escrowAccessRequestClass: any = EscrowAccessRequestSQL;
}
