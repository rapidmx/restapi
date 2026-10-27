///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { ConnectionManager, MongoConnection, MongoRepository, ObjectFactory, Server } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { MongoMemoryServer } from "mongodb-memory-server";
import { AuditLogEntryMongo } from "../../../src/models/mongo/AuditLogEntryMongo.js";
import { ConfigKeyStateMongo } from "../../../src/models/mongo/ConfigKeyStateMongo.js";
import { AuditAction } from "../../../src/models/types.js";
import type { LocalConfigKeyChannel } from "../../../src/secrets/ConfigKeyChannel.js";
import { CONFIG_KEY_STATE_UID } from "../../../src/secrets/ConfigKeyring.js";
import { registerTestDoubles } from "../../testDoubles.js";
import { configKeysSuite } from "../configKeysSuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({ instance: { port: 9999, dbName: "rrst-test" } });

describe("Route:ConfigKeyMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const repos: Record<string, MongoRepository<any>> = {};

    const clear = async (name: string): Promise<void> => {
        try {
            await repos[name].clear();
        } catch (err: any) {
            if (err.message !== "ns not found") {
                throw err;
            }
        }
    };

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();
        const conn: any = objectFactory.getInstance<ConnectionManager>(ConnectionManager)?.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        for (const cls of [AuditLogEntryMongo, ConfigKeyStateMongo]) {
            repos[cls.name] = conn.getMongoRepository(cls.name);
        }
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    configKeysSuite({
        config,
        app: () => server.getApplication(),
        prefix: "/mongo",
        channel: () => objectFactory.getInstance<LocalConfigKeyChannel>("ConfigKeyChannel")!,
        saveState: async (fields) => {
            await repos.ConfigKeyStateMongo.deleteMany({ uid: fields.uid } as any);
            await repos.ConfigKeyStateMongo.save(new ConfigKeyStateMongo(fields));
        },
        state: async () => await repos.ConfigKeyStateMongo.findOne({ uid: CONFIG_KEY_STATE_UID } as any),
        clearState: async () => await clear("ConfigKeyStateMongo"),
        auditEntries: async (action: AuditAction) => await repos.AuditLogEntryMongo.find({ action }).toArray(),
        clearAudit: async () => await clear("AuditLogEntryMongo"),
    });
});
