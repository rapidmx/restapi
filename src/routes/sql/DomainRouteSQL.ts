///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { AuditLogEntrySQL, DeploymentIdentitySQL, DnsOperationSQL, DnsProviderSQL, DomainSQL } from "../../sql.js";
import { BaseDomainRoute } from "../BaseDomainRoute.js";
const { Model } = RouteDecorators;

@Model(DomainSQL)
export class DomainRouteSQL extends BaseDomainRoute<DomainSQL> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected auditLogClass: any = AuditLogEntrySQL;
    protected dnsProviderClass: any = DnsProviderSQL;
    protected dnsOperationClass: any = DnsOperationSQL;
    protected deploymentIdentityClass: any = DeploymentIdentitySQL;
}
