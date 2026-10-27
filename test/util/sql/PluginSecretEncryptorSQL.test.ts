///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for PluginSecretEncryptorSQL: a real SQLite connection and a real `ObjectFactory` construct the encryptor exactly as
// the server does at startup. The behaviour itself is in ../pluginSecretEncryptionSuite.ts, shared with the Mongo backend; settings are a JSON column here.
import { ACLUtils, AccessControlListSQL, ConnectionManager, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import config from "../../config.sql.js";
import { AuditLogEntrySQL } from "../../../src/models/sql/AuditLogEntrySQL.js";
import { ConfigKeyStateSQL } from "../../../src/models/sql/ConfigKeyStateSQL.js";
import { PluginSQL } from "../../../src/models/sql/PluginSQL.js";
import { LocalConfigKeyChannel } from "../../../src/secrets/ConfigKeyChannel.js";
import { CONFIG_KEY_STATE_UID } from "../../../src/secrets/ConfigKeyring.js";
import { ConfigCipherSQL } from "../../../src/util/sql/ConfigCipherSQL.js";
import { PluginSecretEncryptorSQL } from "../../../src/util/sql/PluginSecretEncryptorSQL.js";
import { InMemoryServerRolloutCheck } from "../../testDoubles.js";
import { pluginSecretEncryptionSuite } from "../pluginSecretEncryptionSuite.js";

describe("PluginSecretEncryptorSQL Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    const repos: Record<string, Repository<any>> = {};

    const clear = async (): Promise<void> => {
        for (const repo of Object.values(repos)) {
            await repo.clear();
        }
    };

    beforeAll(async () => {
        objectFactory = new ObjectFactory(config, logger);
        // Normally registered by `Server`'s own bootstrap - registered explicitly here since this file bypasses `Server`.
        objectFactory.register(ACLUtils);
        objectFactory.register(ConfigCipherSQL, "ConfigCipher");
        objectFactory.register(LocalConfigKeyChannel, "ConfigKeyChannel");
        objectFactory.register(InMemoryServerRolloutCheck, "ServerRolloutCheck");

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("AccessControlListSQL", AccessControlListSQL);
        for (const cls of [PluginSQL, ConfigKeyStateSQL, AuditLogEntrySQL]) {
            models.set(cls.name, cls);
        }
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        for (const cls of [PluginSQL, ConfigKeyStateSQL, AuditLogEntrySQL]) {
            repos[cls.name] = conn.getRepository(cls);
        }
    });

    afterAll(async () => {
        // The database file is shared with later SQL suites, which must not find these plugins.
        await clear();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await clear();
    });

    it("Resolves the registered cipher, channel and rollout check, and builds its repositories.", async () => {
        const encryptor: any = await objectFactory.newInstance(PluginSecretEncryptorSQL, { name: "default" });
        expect(encryptor.cipher).toBeInstanceOf(ConfigCipherSQL);
        expect(encryptor.channel).toBeInstanceOf(LocalConfigKeyChannel);
        expect(encryptor.rolloutCheck).toBeInstanceOf(InMemoryServerRolloutCheck);
        expect(encryptor.pluginRepo).toBeDefined();
        expect(encryptor.stateRepo).toBeDefined();
        expect(encryptor.auditLogUtils).toBeDefined();
    });

    pluginSecretEncryptionSuite({
        newEncryptor: async () => await objectFactory.newInstance(PluginSecretEncryptorSQL, { name: `replica-${uuid.v4()}` }),
        insertPlugin: async (fields) => {
            await repos.PluginSQL.save(new PluginSQL(fields as any));
        },
        rows: async () => Object.fromEntries((await repos.PluginSQL.find()).map((row) => [row.name, row])),
        bumpVersion: async (uid) => {
            await repos.PluginSQL.increment({ uid }, "version", 1);
        },
        auditEntries: async () => await repos.AuditLogEntrySQL.find(),
        state: async () => await repos.ConfigKeyStateSQL.findOneBy({ uid: CONFIG_KEY_STATE_UID }),
        saveState: async (fields) => {
            await repos.ConfigKeyStateSQL.delete({ uid: fields.uid as string });
            await repos.ConfigKeyStateSQL.save(new ConfigKeyStateSQL(fields as any));
        },
        clearState: async () => await repos.ConfigKeyStateSQL.clear(),
        rollout: () => objectFactory.getInstance<InMemoryServerRolloutCheck>("ServerRolloutCheck")!,
    });
});
