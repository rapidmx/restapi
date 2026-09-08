///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { AuditLogEntrySQL, DistributionListSQL, MailboxSQL } from "../../sql.js";
import { BaseDistributionListRoute } from "../BaseDistributionListRoute.js";
const { Model } = RouteDecorators;

@Model(DistributionListSQL)
export class DistributionListRouteSQL extends BaseDistributionListRoute<DistributionListSQL> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected mailboxClass: any = MailboxSQL;
    protected auditLogClass: any = AuditLogEntrySQL;
}
