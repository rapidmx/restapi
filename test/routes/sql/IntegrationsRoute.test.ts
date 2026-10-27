///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { ConnectionManager, isSqlDataSource, ObjectFactory, Server } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { Repository } from "typeorm";
import { AuditLogEntrySQL } from "../../../src/models/sql/AuditLogEntrySQL.js";
import { IntegrationSettingsSQL } from "../../../src/models/sql/IntegrationSettingsSQL.js";
import { INTEGRATION_SETTINGS_UID } from "../../../src/util/IntegrationSettingsUtils.js";
import type { ConfigCipher } from "../../../src/secrets/ConfigCipher.js";
import { registerTestDoubles } from "../../testDoubles.js";
import { integrationsSuite } from "../integrationsSuite.js";

describe("Route:IntegrationsSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const repos: Record<string, Repository<any>> = {};

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();
        const conn: any = objectFactory.getInstance<ConnectionManager>(ConnectionManager)?.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        for (const cls of [AuditLogEntrySQL, IntegrationSettingsSQL]) {
            repos[cls.name] = conn.getRepository(cls);
        }
    });

    afterAll(async () => {
        // The SQLite file is shared by every SQL suite: leave no settings or audit rows behind for the next one.
        for (const repo of Object.values(repos)) {
            await repo.clear();
        }
        await server.stop();
        await objectFactory.destroy();
    });

    integrationsSuite({
        config,
        app: () => server.getApplication(),
        prefix: "/sql",
        cipher: () => objectFactory.getInstance<ConfigCipher>("ConfigCipher")!,
        clear: async () => {
            for (const repo of Object.values(repos)) {
                await repo.clear();
            }
        },
        row: async () => await repos.IntegrationSettingsSQL.findOneBy({ uid: INTEGRATION_SETTINGS_UID }),
        auditEntries: async () => await repos.AuditLogEntrySQL.find(),
    });
});
