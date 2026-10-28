///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntryMongo, DeploymentIdentityMongo, DnsControllerStateMongo, DnsOperationMongo, DnsProviderMongo, DomainMongo } from "../../mongo.js";
import { BaseDnsProviderRoute } from "../BaseDnsProviderRoute.js";

export class DnsProviderRouteMongo extends BaseDnsProviderRoute<DnsProviderMongo> {
    protected dnsProviderClass: any = DnsProviderMongo;
    protected domainClass: any = DomainMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
    protected dnsOperationClass: any = DnsOperationMongo;
    protected dnsControllerStateClass: any = DnsControllerStateMongo;
    protected deploymentIdentityClass: any = DeploymentIdentityMongo;
}
