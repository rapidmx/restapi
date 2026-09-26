///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { senderListsRouteSuite } from "../senderListsRouteSuite.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:SenderListsMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let aclRepo: MongoRepository<any>;

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
        } else {
            throw new Error("Could not find mongo connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    senderListsRouteSuite({
        config,
        app: () => server.getApplication(),
        mailboxUrl: "/mongo/mailboxes",
        filterRuleUrl: "/mongo/mail-filter-rules",
        saveMailbox: async (fields, records = []) => {
            const result: MailboxMongo = await mailboxRepo.save(
                new MailboxMongo({
                    aliasAddresses: [],
                    displayName: "Test Mailbox",
                    timezone: "UTC",
                    quotaBytes: 1_000_000_000,
                    usedBytes: 0,
                    ...fields,
                }),
            );
            await aclRepo.save({
                uid: result.uid,
                dateCreated: new Date(),
                dateModified: new Date(),
                version: 0,
                records: [...(result.ownerUserUid ? [{ userOrRoleId: result.ownerUserUid, actions: ["*"] }] : []), ...records],
                parentUid: "Mailbox",
            });
            return result;
        },
        findMailbox: async (uid) => (await mailboxRepo.findOne({ uid } as any))!,
        rawUpdateMailbox: async (uid, fields) => {
            await mailboxRepo.updateOne({ uid } as any, { $set: fields, $inc: { version: 1 } } as any);
        },
        clearLists: async (uid) => {
            await mailboxRepo.updateOne({ uid } as any, { $unset: { blockedSenders: "", safeSenders: "" } } as any);
        },
    });
});
