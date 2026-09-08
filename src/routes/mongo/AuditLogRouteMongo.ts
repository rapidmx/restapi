///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { AuditLogEntryMongo } from "../../mongo.js";
import { BaseAuditLogRoute } from "../BaseAuditLogRoute.js";
const { Model } = RouteDecorators;

@Model(AuditLogEntryMongo)
export class AuditLogRouteMongo extends BaseAuditLogRoute<AuditLogEntryMongo> {
    protected readonly repoUtilsClass: any = RepoUtils;
}
