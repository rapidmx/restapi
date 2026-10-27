///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntryMongo } from "../../models/mongo/AuditLogEntryMongo.js";
import { DnsProviderMongo } from "../../models/mongo/DnsProviderMongo.js";
import { DomainMongo } from "../../models/mongo/DomainMongo.js";
import { SetupStateMongo } from "../../models/mongo/SetupStateMongo.js";
import { DomainSeeder } from "../DomainSeedUtils.js";

export class DomainSeederMongo extends DomainSeeder<DomainMongo, SetupStateMongo> {
    protected domainClass: any = DomainMongo;
    protected setupStateClass: any = SetupStateMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
    protected dnsProviderClass: any = DnsProviderMongo;
}
