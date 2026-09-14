///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { ConnectionManager, isSqlDataSource, ObjectFactory, Server } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { Repository } from "typeorm";
import * as uuid from "uuid";
import { AuditLogEntrySQL } from "../../../src/models/sql/AuditLogEntrySQL.js";
import { DomainSQL } from "../../../src/models/sql/DomainSQL.js";
import { MailboxPolicySQL } from "../../../src/models/sql/MailboxPolicySQL.js";
import { SetupStateSQL } from "../../../src/models/sql/SetupStateSQL.js";
import { registerTestDoubles } from "../../testDoubles.js";
import { MAILBOX_POLICY_UID } from "../../../src/util/MailboxPolicyUtils.js";
import { systemSettingsSuite } from "../systemSettingsSuite.js";

describe("Route:MailboxPolicySQL + SetupSQL Tests", () => {
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
        for (const cls of [AuditLogEntrySQL, DomainSQL, MailboxPolicySQL, SetupStateSQL]) {
            repos[cls.name] = conn.getRepository(cls);
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    systemSettingsSuite({
        config,
        app: () => server.getApplication(),
        prefix: "/sql",
        clear: async () => {
            for (const repo of Object.values(repos)) {
                await repo.clear();
            }
        },
        addDomain: async () => {
            const name = `${uuid.v4()}.example.com`;
            await repos.DomainSQL.save(new DomainSQL({ uid: name, name, enabled: true, verified: false, verificationToken: "t" }));
        },
        savePolicy: async (fields) => {
            await repos.MailboxPolicySQL.save(new MailboxPolicySQL({ uid: MAILBOX_POLICY_UID, ...fields }));
        },
        auditActions: async () => (await repos.AuditLogEntrySQL.find()).map((entry: any) => entry.action),
    });
});
