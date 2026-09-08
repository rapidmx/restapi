///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { JWTUser } from "@rapidrest/core";
import {
    AccessControlListMongo,
    DatabaseDecorators,
    RepoUtils,
    RouteDecorators,
    type MongoRepository,
} from "@rapidrest/service-core";
import { AuditLogEntryMongo, DistributionListMongo, DomainMongo, FolderMongo, MailboxMongo } from "../../mongo.js";
import { BaseMailboxRoute } from "../BaseMailboxRoute.js";
const { Model } = RouteDecorators;
const { Repository } = DatabaseDecorators;

@Model(MailboxMongo)
export class MailboxRouteMongo extends BaseMailboxRoute<MailboxMongo> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected folderClass: any = FolderMongo;
    protected distributionListClass: any = DistributionListMongo;
    protected domainClass: any = DomainMongo;
    protected auditLogClass: any = AuditLogEntryMongo;

    // `@Repository`-injected, always present in any functioning deployment (the `acl` datastore is a hard
    // requirement of this entire library — every permission check everywhere else depends on it too), so an
    // undefined guard here would be dead/unreachable code in practice; non-null-asserted at the use site
    // instead, matching this codebase's established pattern for the same class of always-injected dependency
    // (e.g. `BaseFolderRoute.aclUtils!`).
    @Repository(AccessControlListMongo)
    private aclRepo?: MongoRepository<AccessControlListMongo>;

    protected async findAccessibleMailboxUids(user: JWTUser): Promise<string[]> {
        const candidates: string[] = [user.uid, ...(user.roles ?? [])];
        const acls: AccessControlListMongo[] = await this.aclRepo!
            .find({ "records.userOrRoleId": { $in: candidates } })
            .toArray();
        return acls.map((acl) => acl.uid);
    }
}
