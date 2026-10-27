///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { DeploymentIdentitySQL, DnsControllerStateSQL, DnsOperationSQL, DnsProviderSQL, DomainSQL } from "../../sql.js";
import { BaseDnsDesiredStateRoute } from "../BaseDnsDesiredStateRoute.js";

export class DnsDesiredStateRouteSQL extends BaseDnsDesiredStateRoute {
    protected dnsProviderClass: any = DnsProviderSQL;
    protected domainClass: any = DomainSQL;
    protected dnsOperationClass: any = DnsOperationSQL;
    protected deploymentIdentityClass: any = DeploymentIdentitySQL;
    protected dnsControllerStateClass: any = DnsControllerStateSQL;
}
