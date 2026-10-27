///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntrySQL } from "../../models/sql/AuditLogEntrySQL.js";
import { DnsProviderSQL } from "../../models/sql/DnsProviderSQL.js";
import { DomainSQL } from "../../models/sql/DomainSQL.js";
import { SetupStateSQL } from "../../models/sql/SetupStateSQL.js";
import { DomainSeeder } from "../DomainSeedUtils.js";

export class DomainSeederSQL extends DomainSeeder<DomainSQL, SetupStateSQL> {
    protected domainClass: any = DomainSQL;
    protected setupStateClass: any = SetupStateSQL;
    protected auditLogClass: any = AuditLogEntrySQL;
    protected dnsProviderClass: any = DnsProviderSQL;
}
