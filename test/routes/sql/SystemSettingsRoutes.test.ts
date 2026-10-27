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
import { SETUP_STATE_UID } from "../../../src/util/SetupStateUtils.js";
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
        addDomain: async (fields = {}) => {
            const name = `${uuid.v4()}.example.com`;
            await repos.DomainSQL.save(new DomainSQL({ uid: name, name, enabled: true, verified: false, verificationToken: "t", ...fields }));
        },
        domainRow: async (uid) => await repos.DomainSQL.findOne({ where: { uid } }),
        savePolicy: async (fields) => {
            await repos.MailboxPolicySQL.save(new MailboxPolicySQL({ uid: MAILBOX_POLICY_UID, ...fields }));
        },
        auditActions: async () => (await repos.AuditLogEntrySQL.find()).map((entry: any) => entry.action),
        saveSetupState: async (fields) => {
            await repos.SetupStateSQL.save(new SetupStateSQL({ uid: SETUP_STATE_UID, ...fields } as any));
        },
        setSeededDomains: async (names) => {
            const row: any = await repos.SetupStateSQL.findOne({ where: { uid: SETUP_STATE_UID } });
            row.seededDomains = names;
            await repos.SetupStateSQL.save(row);
        },
        setupRow: async () => await repos.SetupStateSQL.findOne({ where: { uid: SETUP_STATE_UID } }),
    });
});
