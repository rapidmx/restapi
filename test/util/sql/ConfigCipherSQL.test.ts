///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for ConfigCipherSQL: a real SQLite connection and a real `ObjectFactory` construct the cipher exactly as the server
// does at startup. The behaviour itself is in ../configCipherSuite.ts, shared with the Mongo backend.
import { ACLUtils, AccessControlListSQL, ConnectionManager, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import config from "../../config.sql.js";
import { ConfigKeyStateSQL } from "../../../src/models/sql/ConfigKeyStateSQL.js";
import { ConfigCipherSQL } from "../../../src/util/sql/ConfigCipherSQL.js";
import { configCipherSuite } from "../configCipherSuite.js";

describe("ConfigCipherSQL Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let repo: Repository<any>;
    const cipherInstances: any[] = [];

    beforeAll(async () => {
        objectFactory = new ObjectFactory(config, logger);
        // Normally registered by `Server`'s own bootstrap - registered explicitly here since this file bypasses `Server`.
        objectFactory.register(ACLUtils);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("AccessControlListSQL", AccessControlListSQL);
        models.set(ConfigKeyStateSQL.name, ConfigKeyStateSQL);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        repo = conn.getRepository(ConfigKeyStateSQL);
    });

    afterAll(async () => {
        for (const cipher of cipherInstances) {
            await cipher.dispose();
        }
        // The database file is shared with later SQL suites, which must not find this key state.
        await repo.clear();
        await objectFactory.destroy();
    });

    it("Builds the repository for the key state row it reads.", async () => {
        const cipher: any = await objectFactory.newInstance(ConfigCipherSQL, { name: "default" });
        cipherInstances.push(cipher);
        expect(cipher.stateRepo).toBeDefined();
    });

    configCipherSuite({
        newCipher: async (ring) => {
            const cipher: any = await objectFactory.newInstance(ConfigCipherSQL, { name: `cipher-${uuid.v4()}` });
            cipherInstances.push(cipher);
            cipher.keyring = ring;
            await cipher.reload();
            return cipher;
        },
        saveState: async (fields) => {
            await repo.delete({ uid: fields.uid as string });
            await repo.save(new ConfigKeyStateSQL(fields as any));
        },
        clearState: async () => {
            await repo.clear();
        },
    });
});
