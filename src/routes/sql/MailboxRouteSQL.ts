///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { Raw, type Repository as TypeOrmRepository } from "typeorm";
import type { JWTUser } from "@rapidrest/core";
import { AccessControlListSQL, DatabaseDecorators, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { MailboxSQL } from "../../sql.js";
import { BaseMailboxRoute } from "../BaseMailboxRoute.js";
const { Model } = RouteDecorators;
const { Repository } = DatabaseDecorators;

@Model(MailboxSQL)
export class MailboxRouteSQL extends BaseMailboxRoute<MailboxSQL> {
    protected readonly repoUtilsClass: any = RepoUtils;

    @Repository(AccessControlListSQL)
    private aclRepo?: TypeOrmRepository<AccessControlListSQL>;

    /**
     * `AccessControlListSQL.records` is a `simple-json` column (serialized as a single JSON string), the same
     * shape as `MailboxSQL.aliasAddresses` — see `MailIngestRouteSQL.aliasQueryValue()` for the identical
     * problem/solution this mirrors: match the serialized substring via `LIKE`, anchored on the `userOrRoleId`
     * key specifically (not just any quoted occurrence, which could otherwise false-positive-match a
     * coincidentally identical string inside a record's `actions` array) and escaped so a candidate id
     * containing `%`/`_` can't turn this intended exact match into an unintended wildcard/substring match.
     *
     * KNOWN LIMITATION: a `LIKE '%...%'` scan of the whole `records` column can't use a standard index the way
     * a normalized join table could, so this degrades on a very large ACL table (every mailbox/folder/message/
     * etc.'s ACL lives in this one table). Acceptable for now given the library's existing precedent of
     * similar tradeoffs elsewhere (e.g. search index eventual consistency); revisit with a dedicated
     * reverse-lookup table if this becomes a real bottleneck.
     */
    protected async findAccessibleMailboxUids(user: JWTUser): Promise<string[]> {
        if (!this.aclRepo) {
            return [];
        }
        const candidates: string[] = [user.uid, ...(user.roles ?? [])];
        const where = candidates.map((id) => {
            const escaped: string = id.replace(/[\\%_]/g, (ch) => `\\${ch}`);
            return {
                records: Raw((alias) => `${alias} LIKE :pattern ESCAPE '\\'`, {
                    pattern: `%"userOrRoleId":"${escaped}"%`,
                }),
            };
        });
        const acls: AccessControlListSQL[] = await this.aclRepo.find({ where });
        return acls.map((acl) => acl.uid);
    }
}
