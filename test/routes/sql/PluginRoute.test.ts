///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";

// Two namespaces: the default one and a company one on its own registry.
config.set("system:plugins:uploads:max_bytes", UPLOAD_TEST_MAX_BYTES);
config.set("system:plugins:namespaces", ["@rapidmx", { name: "@acme", registry: "https://npm.acme.test", token: "secret" }]);
import { ConnectionManager, isSqlDataSource, ObjectFactory, Server } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { Repository } from "typeorm";
import { AuditLogEntrySQL } from "../../../src/models/sql/AuditLogEntrySQL.js";
import { ConfigKeyStateSQL } from "../../../src/models/sql/ConfigKeyStateSQL.js";
import { PluginSQL } from "../../../src/models/sql/PluginSQL.js";
import type { ConfigCipher } from "../../../src/secrets/ConfigCipher.js";
import { CONFIG_KEY_STATE_UID } from "../../../src/secrets/ConfigKeyring.js";
import { InMemoryBlobStore, registerTestDoubles } from "../../testDoubles.js";
import { pluginRouteSuite } from "../../plugins/pluginRouteSuite.js";
import { pluginUploadSuite, UPLOAD_TEST_MAX_BYTES } from "../../plugins/pluginUploadSuite.js";

describe("Route:PluginSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    let pluginRepo: Repository<PluginSQL>;
    let auditLogRepo: Repository<AuditLogEntrySQL>;
    let stateRepo: Repository<ConfigKeyStateSQL>;

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();
        const conn: any = objectFactory.getInstance<ConnectionManager>(ConnectionManager)?.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        pluginRepo = conn.getRepository(PluginSQL);
        auditLogRepo = conn.getRepository(AuditLogEntrySQL);
        stateRepo = conn.getRepository(ConfigKeyStateSQL);
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    const context: any = {
        config,
        app: () => server.getApplication(),
        baseUrl: "/sql/plugins",
        clear: async () => {
            await pluginRepo.clear();
            await auditLogRepo.clear();
            await stateRepo.clear();
        },
        auditActions: async () => (await auditLogRepo.find()).map((entry) => entry.action),
        insertPlugin: async (fields) => {
            await pluginRepo.save(new PluginSQL(fields));
        },
        rows: async () => (await pluginRepo.find()).sort((a, b) => a.name.localeCompare(b.name)),
        bumpVersion: async (uid) => {
            await pluginRepo.increment({ uid }, "version", 1);
        },
        updatePlugin: async (uid, fields) => {
            await pluginRepo.update({ uid }, fields);
        },
        cipher: () => objectFactory.getInstance<ConfigCipher>("ConfigCipher")!,
        setEncrypted: async (encrypted: boolean) => {
            await stateRepo.delete({ uid: CONFIG_KEY_STATE_UID });
            if (encrypted) {
                await stateRepo.save(new ConfigKeyStateSQL({ uid: CONFIG_KEY_STATE_UID, pluginSecrets: { encryptedAt: new Date(), waitingForRollout: false } } as any));
            }
        },
    };

    pluginRouteSuite(context);
    pluginUploadSuite({
        ...context,
        blobStore: () => objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!,
        auditEntries: async () => (await auditLogRepo.find()).map((entry) => ({ action: entry.action, details: entry.details })),
    });
});
