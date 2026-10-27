///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { ConnectionManager, isSqlDataSource, ObjectFactory, Server } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { Repository } from "typeorm";
import { AuditLogEntrySQL } from "../../../src/models/sql/AuditLogEntrySQL.js";
import { ConfigKeyStateSQL } from "../../../src/models/sql/ConfigKeyStateSQL.js";
import { AuditAction } from "../../../src/models/types.js";
import type { LocalConfigKeyChannel } from "../../../src/secrets/ConfigKeyChannel.js";
import { CONFIG_KEY_STATE_UID } from "../../../src/secrets/ConfigKeyring.js";
import { registerTestDoubles } from "../../testDoubles.js";
import { configKeysSuite } from "../configKeysSuite.js";

describe("Route:ConfigKeySQL Tests", () => {
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
        for (const cls of [AuditLogEntrySQL, ConfigKeyStateSQL]) {
            repos[cls.name] = conn.getRepository(cls);
        }
    });

    afterAll(async () => {
        // The SQLite file is shared by every SQL suite: leave no key state or audit rows behind for the next one.
        for (const repo of Object.values(repos)) {
            await repo.clear();
        }
        await server.stop();
        await objectFactory.destroy();
    });

    configKeysSuite({
        config,
        app: () => server.getApplication(),
        prefix: "/sql",
        channel: () => objectFactory.getInstance<LocalConfigKeyChannel>("ConfigKeyChannel")!,
        saveState: async (fields) => {
            await repos.ConfigKeyStateSQL.delete({ uid: fields.uid } as any);
            await repos.ConfigKeyStateSQL.save(new ConfigKeyStateSQL(fields as any));
        },
        state: async () => await repos.ConfigKeyStateSQL.findOneBy({ uid: CONFIG_KEY_STATE_UID }),
        clearState: async () => await repos.ConfigKeyStateSQL.clear(),
        auditEntries: async (action: AuditAction) => await repos.AuditLogEntrySQL.find({ where: { action } }),
        clearAudit: async () => await repos.AuditLogEntrySQL.clear(),
    });
});
