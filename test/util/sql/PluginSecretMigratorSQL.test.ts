///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for PluginSecretMigratorSQL: a real SQLite connection and a real `ObjectFactory` construct the migrator exactly as
// the server does at startup. The behaviour itself is in ../pluginSecretMigrationSuite.ts, shared with the Mongo backend; settings are a JSON column here.
import { ACLUtils, AccessControlListSQL, ConnectionManager, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import config from "../../config.sql.js";
import { AuditLogEntrySQL } from "../../../src/models/sql/AuditLogEntrySQL.js";
import { PluginSQL } from "../../../src/models/sql/PluginSQL.js";
import { PluginSecretMigratorSQL } from "../../../src/util/sql/PluginSecretMigratorSQL.js";
import { InMemorySecretStore } from "../../testDoubles.js";
import { pluginSecretMigrationSuite } from "../pluginSecretMigrationSuite.js";

describe("PluginSecretMigratorSQL Tests (real DB + DI)", () => {
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
        objectFactory.register(InMemorySecretStore, "SecretStore");

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("AccessControlListSQL", AccessControlListSQL);
        for (const cls of [PluginSQL, AuditLogEntrySQL]) {
            models.set(cls.name, cls);
        }
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        for (const cls of [PluginSQL, AuditLogEntrySQL]) {
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

    it("Resolves the registered SecretStore, and builds its repositories.", async () => {
        const migrator: any = await objectFactory.newInstance(PluginSecretMigratorSQL, { name: "default" });
        expect(migrator.secretStore).toBeInstanceOf(InMemorySecretStore);
        expect(migrator.pluginRepo).toBeDefined();
        expect(migrator.auditLogUtils).toBeDefined();
    });

    pluginSecretMigrationSuite({
        newMigrator: async () => await objectFactory.newInstance(PluginSecretMigratorSQL, { name: `replica-${uuid.v4()}` }),
        insertPlugin: async (fields) => {
            await repos.PluginSQL.save(new PluginSQL(fields as any));
        },
        rows: async () => Object.fromEntries((await repos.PluginSQL.find()).map((row) => [row.name, row])),
        bumpVersion: async (uid) => {
            await repos.PluginSQL.increment({ uid }, "version", 1);
        },
        auditEntries: async () => await repos.AuditLogEntrySQL.find(),
    });
});
