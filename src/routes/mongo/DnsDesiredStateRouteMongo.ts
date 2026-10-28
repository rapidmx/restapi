///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntryMongo, DeploymentIdentityMongo, DnsControllerStateMongo, DnsOperationMongo, DnsProviderMongo, DomainMongo } from "../../mongo.js";
import { BaseDnsDesiredStateRoute } from "../BaseDnsDesiredStateRoute.js";

export class DnsDesiredStateRouteMongo extends BaseDnsDesiredStateRoute {
    protected dnsProviderClass: any = DnsProviderMongo;
    protected domainClass: any = DomainMongo;
    protected dnsOperationClass: any = DnsOperationMongo;
    protected deploymentIdentityClass: any = DeploymentIdentityMongo;
    protected dnsControllerStateClass: any = DnsControllerStateMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
