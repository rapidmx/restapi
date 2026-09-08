///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { AuditLogEntryMongo, TransportRuleMongo } from "../../mongo.js";
import { BaseTransportRuleRoute } from "../BaseTransportRuleRoute.js";
const { Model } = RouteDecorators;

@Model(TransportRuleMongo)
export class TransportRuleRouteMongo extends BaseTransportRuleRoute<TransportRuleMongo> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected auditLogClass: any = AuditLogEntryMongo;
}
