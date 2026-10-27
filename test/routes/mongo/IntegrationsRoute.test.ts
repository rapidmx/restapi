///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { ConnectionManager, MongoConnection, MongoRepository, ObjectFactory, Server } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { MongoMemoryServer } from "mongodb-memory-server";
import { AuditLogEntryMongo } from "../../../src/models/mongo/AuditLogEntryMongo.js";
import { IntegrationSettingsMongo } from "../../../src/models/mongo/IntegrationSettingsMongo.js";
import { INTEGRATION_SETTINGS_UID } from "../../../src/util/IntegrationSettingsUtils.js";
import type { ConfigCipher } from "../../../src/secrets/ConfigCipher.js";
import { registerTestDoubles } from "../../testDoubles.js";
import { integrationsSuite } from "../integrationsSuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({ instance: { port: 9999, dbName: "rrst-test" } });

describe("Route:IntegrationsMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const repos: Record<string, MongoRepository<any>> = {};

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();
        const conn: any = objectFactory.getInstance<ConnectionManager>(ConnectionManager)?.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        for (const cls of [AuditLogEntryMongo, IntegrationSettingsMongo]) {
            repos[cls.name] = conn.getMongoRepository(cls.name);
        }
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    integrationsSuite({
        config,
        app: () => server.getApplication(),
        prefix: "/mongo",
        cipher: () => objectFactory.getInstance<ConfigCipher>("ConfigCipher")!,
        clear: async () => {
            for (const repo of Object.values(repos)) {
                await repo.clear().catch(() => undefined);
            }
        },
        row: async () => await repos.IntegrationSettingsMongo.findOne({ uid: INTEGRATION_SETTINGS_UID } as any),
        auditEntries: async () => await repos.AuditLogEntryMongo.find({}).toArray(),
    });
});
