///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { Raw } from "typeorm";
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { AuditLogEntrySQL, EscrowAccessRequestSQL, EscrowScopeSQL, MailboxSQL, MatterSQL } from "../../sql.js";
import { BaseEscrowScopeRoute } from "../BaseEscrowScopeRoute.js";
const { Model } = RouteDecorators;

@Model(EscrowScopeSQL)
export class EscrowScopeRouteSQL extends BaseEscrowScopeRoute<EscrowScopeSQL> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected auditLogClass: any = AuditLogEntrySQL;
    protected matterClass: any = MatterSQL;
    protected escrowAccessRequestClass: any = EscrowAccessRequestSQL;
    protected mailboxClass: any = MailboxSQL;

    /** `MailboxSQL.aliasAddresses` is stored as a serialized `simple-json` column - a plain equality filter compares
     * against the whole serialized string and never matches a single element. Mirrors `MailboxAccessRouteSQL.
     * aliasQueryValue()`'s identical LIKE-escape shape (itself mirroring `MailIngestRouteSQL.aliasQueryValue()`). */
    protected aliasQueryValue(address: string): any {
        const escaped: string = address.replace(/[\\%_]/g, (ch) => `\\${ch}`);
        return Raw((alias) => `${alias} LIKE :pattern ESCAPE '\\'`, { pattern: `%"${escaped}"%` });
    }
}
