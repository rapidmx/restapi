///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { ConnectionManager, MongoConnection, MongoRepository, ObjectFactory, Server } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { MongoMemoryServer } from "mongodb-memory-server";
import { AuditLogEntryMongo } from "../../../src/models/mongo/AuditLogEntryMongo.js";
import { PluginMongo } from "../../../src/models/mongo/PluginMongo.js";
import { registerTestDoubles } from "../../testDoubles.js";
import { pluginRouteSuite } from "../../plugins/pluginRouteSuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("Route:PluginMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    let pluginRepo: MongoRepository<PluginMongo>;
    let auditLogRepo: MongoRepository<AuditLogEntryMongo>;

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();
        const conn: any = objectFactory.getInstance<ConnectionManager>(ConnectionManager)?.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        pluginRepo = conn.getMongoRepository("PluginMongo");
        auditLogRepo = conn.getMongoRepository("AuditLogEntryMongo");
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    pluginRouteSuite({
        config,
        app: () => server.getApplication(),
        baseUrl: "/mongo/plugins",
        clear: async () => {
            await pluginRepo.clear();
            await auditLogRepo.clear();
        },
        auditActions: async () => (await auditLogRepo.find({}).toArray()).map((entry) => entry.action),
    });
});
