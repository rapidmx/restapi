///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { AuditLogEntryMongo, DomainMongo } from "../../mongo.js";
import { BaseDomainRoute } from "../BaseDomainRoute.js";
const { Model } = RouteDecorators;

@Model(DomainMongo)
export class DomainRouteMongo extends BaseDomainRoute<DomainMongo> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected auditLogClass: any = AuditLogEntryMongo;
}
