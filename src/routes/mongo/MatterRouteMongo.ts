///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { AuditLogEntryMongo, EscrowScopeMongo, MatterMongo } from "../../mongo.js";
import { BaseMatterRoute } from "../BaseMatterRoute.js";
const { Model } = RouteDecorators;

@Model(MatterMongo)
export class MatterRouteMongo extends BaseMatterRoute<MatterMongo> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected escrowScopeClass: any = EscrowScopeMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
