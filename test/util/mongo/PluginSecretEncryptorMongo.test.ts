///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for PluginSecretEncryptorMongo: a real in-memory MongoDB connection and a real `ObjectFactory` construct the encryptor
// exactly as the server does at startup. The behaviour itself is in ../pluginSecretEncryptionSuite.ts, shared with the SQL backend.
import { MongoMemoryServer } from "mongodb-memory-server";
import { ACLUtils, ConnectionManager, MongoConnection, MongoRepository, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../../config.js";
import { AuditLogEntryMongo } from "../../../src/models/mongo/AuditLogEntryMongo.js";
import { ConfigKeyStateMongo } from "../../../src/models/mongo/ConfigKeyStateMongo.js";
import { PluginMongo } from "../../../src/models/mongo/PluginMongo.js";
import { LocalConfigKeyChannel } from "../../../src/secrets/ConfigKeyChannel.js";
import { CONFIG_KEY_STATE_UID } from "../../../src/secrets/ConfigKeyring.js";
import { ConfigCipherMongo } from "../../../src/util/mongo/ConfigCipherMongo.js";
import { PluginSecretEncryptorMongo } from "../../../src/util/mongo/PluginSecretEncryptorMongo.js";
import { InMemoryServerRolloutCheck } from "../../testDoubles.js";
import { pluginSecretEncryptionSuite } from "../pluginSecretEncryptionSuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("PluginSecretEncryptorMongo Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
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
        objectFactory = new ObjectFactory(config, logger);
        // Normally registered by `Server`'s own bootstrap - registered explicitly here since this file bypasses `Server`.
        objectFactory.register(ACLUtils);
        objectFactory.register(ConfigCipherMongo, "ConfigCipher");
        objectFactory.register(LocalConfigKeyChannel, "ConfigKeyChannel");
        objectFactory.register(InMemoryServerRolloutCheck, "ServerRolloutCheck");

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        for (const cls of [PluginMongo, ConfigKeyStateMongo, AuditLogEntryMongo]) {
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
        for (const name of Object.keys(repos)) {
            await clear(name);
        }
    });

    it("Resolves the registered cipher, channel and rollout check, and builds its repositories.", async () => {
        const encryptor: any = await objectFactory.newInstance(PluginSecretEncryptorMongo, { name: "default" });
        expect(encryptor.cipher).toBeInstanceOf(ConfigCipherMongo);
        expect(encryptor.channel).toBeInstanceOf(LocalConfigKeyChannel);
        expect(encryptor.rolloutCheck).toBeInstanceOf(InMemoryServerRolloutCheck);
        expect(encryptor.pluginRepo).toBeDefined();
        expect(encryptor.stateRepo).toBeDefined();
        expect(encryptor.auditLogUtils).toBeDefined();
    });

    pluginSecretEncryptionSuite({
        newEncryptor: async () => await objectFactory.newInstance(PluginSecretEncryptorMongo, { name: `replica-${uuid.v4()}` }),
        insertPlugin: async (fields) => {
            await repos.PluginMongo.save(new PluginMongo(fields));
        },
        rows: async () => Object.fromEntries((await repos.PluginMongo.find({}).toArray()).map((row: any) => [row.name, row])),
        bumpVersion: async (uid) => {
            await repos.PluginMongo.updateOne({ uid } as any, { $inc: { version: 1 } });
        },
        auditEntries: async () => await repos.AuditLogEntryMongo.find({}).toArray(),
        state: async () => await repos.ConfigKeyStateMongo.findOne({ uid: CONFIG_KEY_STATE_UID } as any),
        saveState: async (fields) => {
            await repos.ConfigKeyStateMongo.deleteMany({ uid: fields.uid } as any);
            await repos.ConfigKeyStateMongo.save(new ConfigKeyStateMongo(fields));
        },
        clearState: async () => await clear("ConfigKeyStateMongo"),
        rollout: () => objectFactory.getInstance<InMemoryServerRolloutCheck>("ServerRolloutCheck")!,
    });
});
