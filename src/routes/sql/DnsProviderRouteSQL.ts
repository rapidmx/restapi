///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntrySQL, DeploymentIdentitySQL, DnsControllerStateSQL, DnsOperationSQL, DnsProviderSQL, DomainSQL } from "../../sql.js";
import { BaseDnsProviderRoute } from "../BaseDnsProviderRoute.js";

export class DnsProviderRouteSQL extends BaseDnsProviderRoute<DnsProviderSQL> {
    protected dnsProviderClass: any = DnsProviderSQL;
    protected domainClass: any = DomainSQL;
    protected auditLogClass: any = AuditLogEntrySQL;
    protected dnsOperationClass: any = DnsOperationSQL;
    protected dnsControllerStateClass: any = DnsControllerStateSQL;
    protected deploymentIdentityClass: any = DeploymentIdentitySQL;
}
