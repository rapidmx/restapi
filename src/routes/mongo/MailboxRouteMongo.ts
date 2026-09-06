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
import { MailboxMongo } from "../../mongo.js";
import { BaseMailboxRoute } from "../BaseMailboxRoute.js";
const { Model } = RouteDecorators;
const { Repository } = DatabaseDecorators;

@Model(MailboxMongo)
export class MailboxRouteMongo extends BaseMailboxRoute<MailboxMongo> {
    protected readonly repoUtilsClass: any = RepoUtils;

    @Repository(AccessControlListMongo)
    private aclRepo?: MongoRepository<AccessControlListMongo>;

    protected async findAccessibleMailboxUids(user: JWTUser): Promise<string[]> {
        if (!this.aclRepo) {
            return [];
        }
        const candidates: string[] = [user.uid, ...(user.roles ?? [])];
        const acls: AccessControlListMongo[] = await this.aclRepo
            .find({ "records.userOrRoleId": { $in: candidates } })
            .toArray();
        return acls.map((acl) => acl.uid);
    }
}
