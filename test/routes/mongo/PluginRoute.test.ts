///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";

// Two namespaces: the default one and a company one on its own registry.
config.set("system:plugins:uploads:max_bytes", UPLOAD_TEST_MAX_BYTES);
config.set("system:plugins:namespaces", ["@rapidmx", { name: "@acme", registry: "https://npm.acme.test", token: "secret" }]);
import { ConnectionManager, MongoConnection, MongoRepository, ObjectFactory, Server } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { MongoMemoryServer } from "mongodb-memory-server";
import { AuditLogEntryMongo } from "../../../src/models/mongo/AuditLogEntryMongo.js";
import { ConfigKeyStateMongo } from "../../../src/models/mongo/ConfigKeyStateMongo.js";
import { PluginMongo } from "../../../src/models/mongo/PluginMongo.js";
import type { ConfigCipher } from "../../../src/secrets/ConfigCipher.js";
import { CONFIG_KEY_STATE_UID } from "../../../src/secrets/ConfigKeyring.js";
import { InMemoryBlobStore, registerTestDoubles } from "../../testDoubles.js";
import { pluginRouteSuite } from "../../plugins/pluginRouteSuite.js";
import { pluginUploadSuite, UPLOAD_TEST_MAX_BYTES } from "../../plugins/pluginUploadSuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("Route:PluginMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    let pluginRepo: MongoRepository<PluginMongo>;
    let auditLogRepo: MongoRepository<AuditLogEntryMongo>;
    let stateRepo: MongoRepository<ConfigKeyStateMongo>;

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
        stateRepo = conn.getMongoRepository("ConfigKeyStateMongo");
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    const context: any = {
        config,
        app: () => server.getApplication(),
        baseUrl: "/mongo/plugins",
        clear: async () => {
            await pluginRepo.clear();
            await auditLogRepo.clear();
            await context.setEncrypted(false);
        },
        auditActions: async () => (await auditLogRepo.find({}).toArray()).map((entry) => entry.action),
        insertPlugin: async (fields) => {
            await pluginRepo.save(new PluginMongo(fields));
        },
        rows: async () => (await pluginRepo.find({}).toArray()).sort((a, b) => a.name.localeCompare(b.name)),
        bumpVersion: async (uid) => {
            await pluginRepo.updateOne({ uid }, { $inc: { version: 1 } });
        },
        updatePlugin: async (uid, fields) => {
            await pluginRepo.updateOne({ uid }, { $set: fields });
        },
        cipher: () => objectFactory.getInstance<ConfigCipher>("ConfigCipher")!,
        setEncrypted: async (encrypted: boolean) => {
            await stateRepo.deleteMany({ uid: CONFIG_KEY_STATE_UID });
            if (encrypted) {
                await stateRepo.save(new ConfigKeyStateMongo({ uid: CONFIG_KEY_STATE_UID, pluginSecrets: { encryptedAt: new Date(), waitingForRollout: false } }));
            }
        },
    };

    pluginRouteSuite(context);
    pluginUploadSuite({
        ...context,
        blobStore: () => objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!,
        auditEntries: async () => (await auditLogRepo.find({}).toArray()).map((entry) => ({ action: entry.action, details: entry.details })),
    });
});
