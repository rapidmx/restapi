///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { Raw } from "typeorm";
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { AuditLogEntrySQL, DistributionListSQL, DomainSQL, MailboxSQL } from "../../sql.js";
import { BaseDistributionListRoute } from "../BaseDistributionListRoute.js";
const { Model } = RouteDecorators;

@Model(DistributionListSQL)
export class DistributionListRouteSQL extends BaseDistributionListRoute<DistributionListSQL> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected mailboxClass: any = MailboxSQL;
    protected domainClass: any = DomainSQL;
    protected auditLogClass: any = AuditLogEntrySQL;

    /** `aliasAddresses` is a serialized `simple-json` column on both `DistributionListSQL` and `MailboxSQL` -
     * see `MailboxRouteSQL.aliasQueryValue()`'s identical override for the full explanation. */
    protected aliasQueryValue(address: string): any {
        const escaped: string = address.replace(/[\\%_]/g, (ch) => `\\${ch}`);
        return Raw((alias) => `${alias} LIKE :pattern ESCAPE '\\'`, { pattern: `%"${escaped}"%` });
    }
}
