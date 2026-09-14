///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { AuditLogEntryMongo, EscrowAccessRequestMongo, EscrowScopeMongo, MatterMongo } from "../../mongo.js";
import { BaseEscrowScopeRoute } from "../BaseEscrowScopeRoute.js";
const { Model } = RouteDecorators;

@Model(EscrowScopeMongo)
export class EscrowScopeRouteMongo extends BaseEscrowScopeRoute<EscrowScopeMongo> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected auditLogClass: any = AuditLogEntryMongo;
    protected matterClass: any = MatterMongo;
    protected escrowAccessRequestClass: any = EscrowAccessRequestMongo;
}
