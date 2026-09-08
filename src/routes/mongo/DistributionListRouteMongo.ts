///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { AuditLogEntryMongo, DistributionListMongo, MailboxMongo } from "../../mongo.js";
import { BaseDistributionListRoute } from "../BaseDistributionListRoute.js";
const { Model } = RouteDecorators;

@Model(DistributionListMongo)
export class DistributionListRouteMongo extends BaseDistributionListRoute<DistributionListMongo> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected mailboxClass: any = MailboxMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
