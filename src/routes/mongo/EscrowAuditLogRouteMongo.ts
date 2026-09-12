///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { EscrowAuditLogEntryMongo, EscrowScopeMongo, MatterMongo } from "../../mongo.js";
import { BaseEscrowAuditLogRoute } from "../BaseEscrowAuditLogRoute.js";
const { Model } = RouteDecorators;

@Model(EscrowAuditLogEntryMongo)
export class EscrowAuditLogRouteMongo extends BaseEscrowAuditLogRoute<EscrowAuditLogEntryMongo> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected escrowScopeClass: any = EscrowScopeMongo;
    protected matterClass: any = MatterMongo;
}
