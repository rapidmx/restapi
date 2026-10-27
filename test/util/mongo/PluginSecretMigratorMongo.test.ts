///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for PluginSecretMigratorMongo: a real in-memory MongoDB connection and a real `ObjectFactory` construct the migrator
// exactly as the server does at startup. The behaviour itself is in ../pluginSecretMigrationSuite.ts, shared with the SQL backend.
import { MongoMemoryServer } from "mongodb-memory-server";
import { ACLUtils, ConnectionManager, MongoConnection, MongoRepository, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../../config.js";
import { AuditLogEntryMongo } from "../../../src/models/mongo/AuditLogEntryMongo.js";
import { PluginMongo } from "../../../src/models/mongo/PluginMongo.js";
import { PluginSecretMigratorMongo } from "../../../src/util/mongo/PluginSecretMigratorMongo.js";
import { InMemorySecretStore } from "../../testDoubles.js";
import { pluginSecretMigrationSuite } from "../pluginSecretMigrationSuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("PluginSecretMigratorMongo Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    const repos: Record<string, MongoRepository<any>> = {};

    beforeAll(async () => {
        await mongod.start();
        objectFactory = new ObjectFactory(config, logger);
        // Normally registered by `Server`'s own bootstrap - registered explicitly here since this file bypasses `Server`.
        objectFactory.register(ACLUtils);
        objectFactory.register(InMemorySecretStore, "SecretStore");

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        for (const cls of [PluginMongo, AuditLogEntryMongo]) {
            models.set(cls.name, cls);
        }
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        for (const name of models.keys()) {
            repos[name] = conn.getMongoRepository(name);
        }
    });

    afterAll(async () => {
        await objectFactory.destroy();
        await mongod.stop();
    });

    beforeEach(async () => {
        for (const repo of Object.values(repos)) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
    });

    it("Resolves the registered SecretStore, and builds its repositories.", async () => {
        const migrator: any = await objectFactory.newInstance(PluginSecretMigratorMongo, { name: "default" });
        expect(migrator.secretStore).toBeInstanceOf(InMemorySecretStore);
        expect(migrator.pluginRepo).toBeDefined();
        expect(migrator.auditLogUtils).toBeDefined();
    });

    pluginSecretMigrationSuite({
        newMigrator: async () => await objectFactory.newInstance(PluginSecretMigratorMongo, { name: `replica-${uuid.v4()}` }),
        insertPlugin: async (fields) => {
            await repos.PluginMongo.save(new PluginMongo(fields));
        },
        rows: async () => Object.fromEntries((await repos.PluginMongo.find({}).toArray()).map((row: any) => [row.name, row])),
        bumpVersion: async (uid) => {
            await repos.PluginMongo.updateOne({ uid } as any, { $inc: { version: 1 } });
        },
        auditEntries: async () => await repos.AuditLogEntryMongo.find({}).toArray(),
    });
});
