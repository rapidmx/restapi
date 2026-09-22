///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real HTTP+DB tests of every mailbox having every well-known folder (created with it, healed on read, announced) - see
// `wellKnownFoldersSuite.ts`.
import config from "../../config.js";
import { MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager, RepoUtils } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { FolderMongo } from "../../../src/models/mongo/FolderMongo.js";
import { findOrCreateWellKnownFolder } from "../../../src/util/FolderUtils.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles } from "../../testDoubles.js";
import { wellKnownFoldersSuite } from "../wellKnownFoldersSuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:FolderMongo well-known folders Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let folderRepo: MongoRepository<FolderMongo>;
    let aclRepo: MongoRepository<any>;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);
    const stranger: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const strangerToken = JWTUtils.createTokenSync(config.get("auth"), stranger);
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);
    const delegate: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const delegateToken = JWTUtils.createTokenSync(config.get("auth"), delegate);

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        let conn: any = connMgr?.connections.get("acl");
        if (conn instanceof MongoConnection) {
            aclRepo = conn.getMongoRepository("AccessControlListMongo");
        }
        conn = connMgr?.connections.get("mongo");
        if (conn instanceof MongoConnection) {
            mailboxRepo = conn.getMongoRepository("MailboxMongo");
            folderRepo = conn.getMongoRepository("FolderMongo");
        } else {
            throw new Error("Could not find mongo connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        for (const repo of [mailboxRepo, folderRepo]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
    });

    wellKnownFoldersSuite({
        app: () => server.getApplication(),
        foldersUrl: "/mongo/folders",
        mailboxesUrl: "/mongo/mailboxes",
        ownerToken,
        ownerUid: owner.uid,
        strangerToken,
        adminToken,
        adminUid: admin.uid,
        delegateToken,
        delegateUid: delegate.uid,
        createMailbox: async (ownerUid, grants = []) => {
            const result = await mailboxRepo.save(
                new MailboxMongo({
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
                new FolderMongo({ mailboxUid, name: name ?? type, type, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }),
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
        foldersOf: async (mailboxUid) => await folderRepo.find({ mailboxUid }).toArray(),
        findOrCreate: async (mailboxUid, type) => {
            const repo: RepoUtils<any> = await objectFactory.newInstance(RepoUtils, { name: FolderMongo.name, args: [FolderMongo] });
            return await findOrCreateWellKnownFolder(repo, FolderMongo, mailboxUid, type);
        },
    });
});
