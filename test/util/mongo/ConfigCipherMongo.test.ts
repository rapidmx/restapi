///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for ConfigCipherMongo: a real in-memory MongoDB connection and a real `ObjectFactory` construct the cipher exactly as
// the server does at startup. The behaviour itself is in ../configCipherSuite.ts, shared with the SQL backend.
import { MongoMemoryServer } from "mongodb-memory-server";
import { ACLUtils, ConnectionManager, MongoConnection, MongoRepository, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../../config.js";
import { ConfigKeyStateMongo } from "../../../src/models/mongo/ConfigKeyStateMongo.js";
import { ConfigCipherMongo } from "../../../src/util/mongo/ConfigCipherMongo.js";
import { configCipherSuite } from "../configCipherSuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("ConfigCipherMongo Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let repo: MongoRepository<any>;
    const cipherInstances: any[] = [];

    beforeAll(async () => {
        await mongod.start();
        objectFactory = new ObjectFactory(config, logger);
        // Normally registered by `Server`'s own bootstrap - registered explicitly here since this file bypasses `Server`.
        objectFactory.register(ACLUtils);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set(ConfigKeyStateMongo.name, ConfigKeyStateMongo);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        repo = conn.getMongoRepository(ConfigKeyStateMongo.name);
    });

    afterAll(async () => {
        for (const cipher of cipherInstances) {
            await cipher.dispose();
        }
        await objectFactory.destroy();
        await mongod.stop();
    });

    it("Builds the repository for the key state row it reads.", async () => {
        const cipher: any = await objectFactory.newInstance(ConfigCipherMongo, { name: "default" });
        cipherInstances.push(cipher);
        expect(cipher.stateRepo).toBeDefined();
    });

    configCipherSuite({
        newCipher: async (ring) => {
            const cipher: any = await objectFactory.newInstance(ConfigCipherMongo, { name: `cipher-${uuid.v4()}` });
            cipherInstances.push(cipher);
            cipher.keyring = ring;
            await cipher.reload();
            return cipher;
        },
        saveState: async (fields) => {
            await repo.deleteMany({ uid: fields.uid } as any);
            await repo.save(new ConfigKeyStateMongo(fields));
        },
        clearState: async () => {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        },
    });
});
