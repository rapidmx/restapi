///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import { MongoMemoryServer } from "mongodb-memory-server";
import { FolderMongo } from "../../../src/models/mongo/FolderMongo.js";
import { KeyVaultMongo } from "../../../src/models/mongo/KeyVaultMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { MatterMongo } from "../../../src/models/mongo/MatterMongo.js";
import { MessageMongo } from "../../../src/models/mongo/MessageMongo.js";
import { FolderType } from "../../../src/models/types.js";
import { registerTestDoubles, InMemoryBlobStore, RecordingMailTransport } from "../../testDoubles.js";
import { verificationSealSuite } from "../verificationSealSuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:MessageVerificationSealMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let folderRepo: MongoRepository<FolderMongo>;
    let messageRepo: MongoRepository<MessageMongo>;
    let matterRepo: MongoRepository<MatterMongo>;
    let keyVaultRepo: MongoRepository<KeyVaultMongo>;
    let aclRepo: MongoRepository<any>;

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
        matterRepo = conn.getMongoRepository("MatterMongo");
        keyVaultRepo = conn.getMongoRepository("KeyVaultMongo");
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        for (const repo of [mailboxRepo, folderRepo, messageRepo, matterRepo, keyVaultRepo]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
    });

    verificationSealSuite({
        app: () => server.getApplication(),
        baseUrl: "/mongo/messages",
        tokenFor: (user: any) => JWTUtils.createTokenSync(config.get("auth"), user),
        saveMailbox: async (ownerUid: string) => {
            const mailbox = await mailboxRepo.save(
                new MailboxMongo({
                    ownerUserUid: ownerUid,
                    primarySmtpAddress: `${crypto.randomUUID()}@example.com`,
                    aliasAddresses: ["owner@example.com"],
                    displayName: "Test Mailbox",
                    timezone: "UTC",
                    quotaBytes: 1_000_000_000,
                    usedBytes: 0,
                }),
            );
            await saveAcl(mailbox.uid, "Mailbox", [{ userOrRoleId: ownerUid, actions: ["*"] }]);
            return mailbox;
        },
        saveFolder: async (mailboxUid: string, type: FolderType, records: any[] = []) => {
            const folder = await folderRepo.save(
                new FolderMongo({ mailboxUid, name: type, type, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }),
            );
            await saveAcl(folder.uid, mailboxUid, records);
            return folder;
        },
        saveMessage: async (fields) => await messageRepo.save(new MessageMongo(fields as any)),
        saveKeyVault: async (mailboxUid: string, masterKeyGeneration?: number) => {
            await keyVaultRepo.save(
                new KeyVaultMongo({ mailboxUid, wrappedKeys: [], masterKeyWraps: [], ...(masterKeyGeneration === undefined ? {} : { masterKeyGeneration }) }),
            );
        },
        setVaultGeneration: async (mailboxUid: string, masterKeyGeneration: number) => {
            await keyVaultRepo.updateOne({ mailboxUid }, { $set: { masterKeyGeneration }, $inc: { version: 1 } });
        },
        findMessage: async (uid: string) => await messageRepo.findOne({ uid } as any),
        findMessages: async (mailboxUid: string) => await messageRepo.find({ mailboxUid }).toArray(),
        rawUpdateMessage: async (uid: string, fields) => {
            await messageRepo.updateOne({ uid }, { $set: fields, $inc: { version: 1 } });
        },
        saveMatter: async (fields) => await matterRepo.save(new MatterMongo(fields as any)),
        blobStore: () => objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!,
        transport: () => objectFactory.getInstance<RecordingMailTransport>("MailTransport")!,
    });
});
