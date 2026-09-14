///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { ConnectionManager, isSqlDataSource, ObjectFactory, Server } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { Repository } from "typeorm";
import { AuditLogEntrySQL } from "../../../src/models/sql/AuditLogEntrySQL.js";
import { PluginSQL } from "../../../src/models/sql/PluginSQL.js";
import { registerTestDoubles } from "../../testDoubles.js";
import { pluginRouteSuite } from "../../plugins/pluginRouteSuite.js";

describe("Route:PluginSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    let pluginRepo: Repository<PluginSQL>;
    let auditLogRepo: Repository<AuditLogEntrySQL>;

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();
        const conn: any = objectFactory.getInstance<ConnectionManager>(ConnectionManager)?.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        pluginRepo = conn.getRepository(PluginSQL);
        auditLogRepo = conn.getRepository(AuditLogEntrySQL);
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    pluginRouteSuite({
        config,
        app: () => server.getApplication(),
        baseUrl: "/sql/plugins",
        clear: async () => {
            await pluginRepo.clear();
            await auditLogRepo.clear();
        },
        auditActions: async () => (await auditLogRepo.find()).map((entry) => entry.action),
    });
});
