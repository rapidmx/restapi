///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// SQL counterpart of test/routes/mongo/WellKnownFolders.test.ts - see that file and `wellKnownFoldersSuite.ts`.
import config from "../../config.sql.js";
import { Server, ObjectFactory, ConnectionManager, AccessControlListSQL, RepoUtils, isSqlDataSource } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { FolderSQL } from "../../../src/models/sql/FolderSQL.js";
import { findOrCreateWellKnownFolder } from "../../../src/util/FolderUtils.js";
import { registerTestDoubles } from "../../testDoubles.js";
import { wellKnownFoldersSuite } from "../wellKnownFoldersSuite.js";

describe("Route:FolderSQL well-known folders Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    let mailboxRepo: Repository<MailboxSQL>;
    let folderRepo: Repository<FolderSQL>;
    let aclRepo: Repository<AccessControlListSQL>;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);
    const stranger: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const strangerToken = JWTUtils.createTokenSync(config.get("auth"), stranger);
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);
    const delegate: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const delegateToken = JWTUtils.createTokenSync(config.get("auth"), delegate);

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        let conn: any = connMgr?.connections.get("acl");
        if (isSqlDataSource(conn)) {
            aclRepo = conn.getRepository(AccessControlListSQL);
        } else {
            throw new Error("Could not find sql acl connection");
        }
        conn = connMgr?.connections.get("sql");
        if (isSqlDataSource(conn)) {
            mailboxRepo = conn.getRepository(MailboxSQL);
            folderRepo = conn.getRepository(FolderSQL);
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await folderRepo.clear();
        await mailboxRepo.clear();
    });

    wellKnownFoldersSuite({
        app: () => server.getApplication(),
        foldersUrl: "/sql/folders",
        mailboxesUrl: "/sql/mailboxes",
        ownerToken,
        ownerUid: owner.uid,
        strangerToken,
        adminToken,
        adminUid: admin.uid,
        delegateToken,
        delegateUid: delegate.uid,
        createMailbox: async (ownerUid, grants = []) => {
            const result = await mailboxRepo.save(
                new MailboxSQL({
                    ownerUserUid: ownerUid,
                    primarySmtpAddress: `${uuid.v4()}@example.com`,
                    aliasAddresses: [],
                    displayName: "Test Mailbox",
                    timezone: "UTC",
                    quotaBytes: 1_000_000_000,
                    usedBytes: 0,
                }),
            );
            await aclRepo.save({
                uid: result.uid,
                dateCreated: new Date(),
                dateModified: new Date(),
                version: 0,
                records: [
                    ...(ownerUid ? [{ userOrRoleId: ownerUid, actions: ["*"] }] : []),
                    ...grants.map((grant) => ({ userOrRoleId: grant.userUid, actions: grant.actions })),
                ],
                parentUid: "Mailbox",
            });
            return result;
        },
        createFolder: async (mailboxUid, type, name) => {
            const result = await folderRepo.save(
                new FolderSQL({ mailboxUid, name: name ?? type, type, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }),
            );
            await aclRepo.save({
                uid: result.uid,
                dateCreated: new Date(),
                dateModified: new Date(),
                version: 0,
                records: [],
                parentUid: mailboxUid,
            });
            return result;
        },
        foldersOf: async (mailboxUid) => await folderRepo.find({ where: { mailboxUid } }),
        findOrCreate: async (mailboxUid, type) => {
            const repo: RepoUtils<any> = await objectFactory.newInstance(RepoUtils, { name: FolderSQL.name, args: [FolderSQL] });
            return await findOrCreateWellKnownFolder(repo, FolderSQL, mailboxUid, type);
        },
    });
});
