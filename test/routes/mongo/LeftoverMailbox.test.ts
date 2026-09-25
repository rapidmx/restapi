///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Runs the leftover-mailbox-data suite (listing, erasing and freeing the address of a deleted mailbox) against the MongoDB
// test server. The SQL twin runs the same suite.
import config from "../../config.js";
import { ConnectionManager, MongoConnection, ObjectFactory, Server } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ErasureExecutionJobMongo } from "../../../src/jobs/mongo/ErasureExecutionJobMongo.js";
import { registerTestDoubles } from "../../testDoubles.js";
import type { EntityStore } from "../entityStore.js";
import { createMongoEntityStore } from "../mongoEntityStore.js";
import { leftoverMailboxSuite } from "../leftoverMailboxSuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:LeftoverMailboxMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    let store: EntityStore;
    let job: ErasureExecutionJobMongo;
    let aclConn: MongoConnection;

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();
        store = createMongoEntityStore(objectFactory);
        const connMgr: ConnectionManager = objectFactory.getInstance(ConnectionManager)!;
        const conn: any = connMgr.connections.get("acl");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find the acl connection");
        }
        aclConn = conn;
        job = await objectFactory.newInstance(ErasureExecutionJobMongo, { name: "default" });
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    leftoverMailboxSuite({
        app: () => server.getApplication(),
        prefix: "/mongo",
        token: (user: any) => JWTUtils.createTokenSync(config.get("auth"), user),
        store: () => store,
        runJob: async () => await job.run(),
        findAcl: async (uid) => (await aclConn.getMongoRepository("AccessControlListMongo").findOne({ uid } as any)) ?? undefined,
    });
});
