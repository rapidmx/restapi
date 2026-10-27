///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntryMongo, DnsProviderMongo, DomainMongo } from "../../mongo.js";
import { BaseDnsProviderRoute } from "../BaseDnsProviderRoute.js";

export class DnsProviderRouteMongo extends BaseDnsProviderRoute<DnsProviderMongo> {
    protected dnsProviderClass: any = DnsProviderMongo;
    protected domainClass: any = DomainMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
