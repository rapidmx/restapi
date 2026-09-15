///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { ACLAction, ConnectionManager, MongoConnection, MongoRepository, ObjectFactory, Server } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ContactMongo } from "../../../src/models/mongo/ContactMongo.js";
import { DataSubjectErasureRequestMongo } from "../../../src/models/mongo/DataSubjectErasureRequestMongo.js";
import { DistributionListMongo } from "../../../src/models/mongo/DistributionListMongo.js";
import { FolderMongo } from "../../../src/models/mongo/FolderMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { registerTestDoubles } from "../../testDoubles.js";
import { directorySuite } from "../directorySuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:DirectoryMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    let aclRepo: MongoRepository<any>;
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let folderRepo: MongoRepository<FolderMongo>;
    let contactRepo: MongoRepository<ContactMongo>;
    let listRepo: MongoRepository<DistributionListMongo>;
    let erasureRepo: MongoRepository<DataSubjectErasureRequestMongo>;

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
        contactRepo = conn.getMongoRepository("ContactMongo");
        listRepo = conn.getMongoRepository("DistributionListMongo");
        erasureRepo = conn.getMongoRepository("DataSubjectErasureRequestMongo");
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        for (const repo of [mailboxRepo, folderRepo, contactRepo, listRepo, erasureRepo] as MongoRepository<any>[]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
    });

    directorySuite({
        config,
        app: () => server.getApplication(),
        baseUrl: "/mongo/directory",
        saveMailbox: async (fields, records = []) => {
            const mailbox = await mailboxRepo.save(
                new MailboxMongo({ aliasAddresses: [], displayName: "", timezone: "UTC", quotaBytes: 1_000_000_000, usedBytes: 0, ...fields }),
            );
            const ownerRecords = mailbox.ownerUserUid ? [{ userOrRoleId: mailbox.ownerUserUid, actions: [ACLAction.FULL] }] : [];
            await saveAcl(mailbox.uid, "Mailbox", [...ownerRecords, ...records]);
            return mailbox;
        },
        saveList: async (fields) => await listRepo.save(new DistributionListMongo({ memberAddresses: [], ...fields })),
        saveFolder: async (fields, records = []) => {
            const folder = await folderRepo.save(new FolderMongo({ unreadCount: 0, totalCount: 0, syncKeyVersion: 0, ...fields }));
            await saveAcl(folder.uid, folder.mailboxUid, records);
            return folder;
        },
        saveContact: async (fields) => await contactRepo.save(new ContactMongo(fields as any)),
        saveErasureRequest: async (mailboxUid, status) => {
            await erasureRepo.save(new DataSubjectErasureRequestMongo({ mailboxUid, requestedByUserUid: "someone", status } as any));
        },
    });
});
