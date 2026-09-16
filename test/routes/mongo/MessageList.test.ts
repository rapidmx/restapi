///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { ACLAction, ConnectionManager, MongoConnection, MongoRepository, ObjectFactory, Server } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { MongoMemoryServer } from "mongodb-memory-server";
import * as uuid from "uuid";
import { FolderMongo } from "../../../src/models/mongo/FolderMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { MessageMongo } from "../../../src/models/mongo/MessageMongo.js";
import { MessageImportance, RecipientType } from "../../../src/models/types.js";
import { registerTestDoubles } from "../../testDoubles.js";
import { messageListSuite } from "../messageListSuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:MessageListMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    let aclRepo: MongoRepository<any>;
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let folderRepo: MongoRepository<FolderMongo>;
    let messageRepo: MongoRepository<MessageMongo>;

    const saveAcl = async (uid: string, parentUid: string, records: any[]): Promise<void> => {
        await aclRepo.save({ uid, dateCreated: new Date(), dateModified: new Date(), version: 0, records, parentUid });
    };

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const aclConn: any = connMgr?.connections.get("acl");
        const conn: any = connMgr?.connections.get("mongo");
        if (!(aclConn instanceof MongoConnection) || !(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connections");
        }
        aclRepo = aclConn.getMongoRepository("AccessControlListMongo");
        mailboxRepo = conn.getMongoRepository("MailboxMongo");
        folderRepo = conn.getMongoRepository("FolderMongo");
        messageRepo = conn.getMongoRepository("MessageMongo");
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        for (const repo of [mailboxRepo, folderRepo, messageRepo] as MongoRepository<any>[]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
    });

    messageListSuite({
        config,
        app: () => server.getApplication(),
        baseUrl: "/mongo/messages",
        saveMailbox: async (ownerUserUid) => {
            const mailbox = await mailboxRepo.save(
                new MailboxMongo({
                    ownerUserUid,
                    primarySmtpAddress: `${uuid.v4()}@example.com`,
                    aliasAddresses: [],
                    displayName: "Test Mailbox",
                    timezone: "UTC",
                    quotaBytes: 1_000_000_000,
                    usedBytes: 0,
                }),
            );
            await saveAcl(mailbox.uid, "Mailbox", [{ userOrRoleId: ownerUserUid, actions: [ACLAction.FULL] }]);
            return mailbox;
        },
        saveFolder: async (mailboxUid, type, records = []) => {
            const folder = await folderRepo.save(
                new FolderMongo({ mailboxUid, name: type, type, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }),
            );
            await saveAcl(folder.uid, mailboxUid, records);
            return folder;
        },
        saveMessage: async (mailboxUid, folderUid, fields = {}) =>
            await messageRepo.save(
                new MessageMongo({
                    mailboxUid,
                    folderUid,
                    messageId: `${uuid.v4()}@example.com`,
                    subject: "Test Subject",
                    from: { address: "owner@example.com", type: RecipientType.TO },
                    recipients: [{ address: "recipient@example.com", type: RecipientType.TO }],
                    sentDate: new Date(),
                    receivedDate: new Date(),
                    bodyBlobKey: `bodies/${uuid.v4()}`,
                    bodyPreview: "Hello",
                    flags: { read: false, flagged: false, answered: false, forwarded: false },
                    importance: MessageImportance.NORMAL,
                    references: [],
                    hasAttachments: false,
                    ...fields,
                }),
            ),
        readMessage: async (uid) => await messageRepo.findOne({ uid } as any),
    });
});
