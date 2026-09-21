///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real HTTP+DB tests of the folder counts being derived from the messages (and published when a write changes them) - see
// `folderCountsSuite.ts`.
import config from "../../config.js";
import { MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { FolderMongo } from "../../../src/models/mongo/FolderMongo.js";
import { MessageMongo } from "../../../src/models/mongo/MessageMongo.js";
import { FolderType, MessageImportance, RecipientType } from "../../../src/models/types.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles, InMemoryBlobStore, RecordingMailTransport } from "../../testDoubles.js";
import { folderCountsSuite } from "../folderCountsSuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:FolderMongo counts Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let folderRepo: MongoRepository<FolderMongo>;
    let messageRepo: MongoRepository<MessageMongo>;
    let aclRepo: MongoRepository<any>;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);

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
            messageRepo = conn.getMongoRepository("MessageMongo");
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
        for (const repo of [mailboxRepo, folderRepo, messageRepo]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
        objectFactory.getInstance<RecordingMailTransport>("MailTransport")!.sent = [];
    });

    folderCountsSuite({
        app: () => server.getApplication(),
        messagesUrl: "/mongo/messages",
        foldersUrl: "/mongo/folders",
        ownerToken,
        ownerUid: owner.uid,
        blobStore: () => objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!,
        createMailbox: async (ownerUid) => {
            const result = await mailboxRepo.save(
                new MailboxMongo({
                    ownerUserUid: ownerUid,
                    primarySmtpAddress: `${uuid.v4()}@example.com`,
                    aliasAddresses: ["owner@example.com"],
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
                records: [{ userOrRoleId: ownerUid, actions: ["*"] }],
                parentUid: "Mailbox",
            });
            return result;
        },
        createFolder: async (mailboxUid, type, stored) => {
            const result = await folderRepo.save(
                new FolderMongo({ mailboxUid, name: type, type, unreadCount: 0, totalCount: 0, syncKeyVersion: 0, ...stored }),
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
        createMessage: async (mailboxUid, folderUid, data) =>
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
                    ...data,
                }),
            ),
        findFolder: async (uid) => (await folderRepo.findOne({ uid } as any))!,
        findMessage: async (uid) => (await messageRepo.findOne({ uid } as any))!,
        restoreMessage: async (uid) => {
            await messageRepo.updateOne({ uid } as any, { $set: { deleted: false } });
        },
        countGroupedQueries: async (work) => {
            const spy = vi.spyOn(MongoRepository.prototype, "aggregate");
            try {
                const result = await work();
                return { result, queries: spy.mock.calls.filter(([pipeline]) => pipeline.some((stage: any) => "$group" in stage)).length };
            } finally {
                spy.mockRestore();
            }
        },
    });
});
