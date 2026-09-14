///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { ConnectionManager, MongoConnection, MongoRepository, ObjectFactory, Server } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { MongoMemoryServer } from "mongodb-memory-server";
import * as uuid from "uuid";
import { AuditLogEntryMongo } from "../../../src/models/mongo/AuditLogEntryMongo.js";
import { DomainMongo } from "../../../src/models/mongo/DomainMongo.js";
import { MailboxPolicyMongo } from "../../../src/models/mongo/MailboxPolicyMongo.js";
import { SetupStateMongo } from "../../../src/models/mongo/SetupStateMongo.js";
import { registerTestDoubles } from "../../testDoubles.js";
import { MAILBOX_POLICY_UID } from "../../../src/util/MailboxPolicyUtils.js";
import { systemSettingsSuite } from "../systemSettingsSuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({ instance: { port: 9999, dbName: "rrst-test" } });

describe("Route:MailboxPolicyMongo + SetupMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const repos: Record<string, MongoRepository<any>> = {};

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();
        const conn: any = objectFactory.getInstance<ConnectionManager>(ConnectionManager)?.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        for (const cls of [AuditLogEntryMongo, DomainMongo, MailboxPolicyMongo, SetupStateMongo]) {
            repos[cls.name] = conn.getMongoRepository(cls.name);
        }
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    systemSettingsSuite({
        config,
        app: () => server.getApplication(),
        prefix: "/mongo",
        clear: async () => {
            for (const repo of Object.values(repos)) {
                await repo.clear().catch(() => undefined);
            }
        },
        addDomain: async () => {
            const name = `${uuid.v4()}.example.com`;
            await repos.DomainMongo.save(new DomainMongo({ uid: name, name, enabled: true, verified: false, verificationToken: "t" }));
        },
        savePolicy: async (fields) => {
            await repos.MailboxPolicyMongo.save(new MailboxPolicyMongo({ uid: MAILBOX_POLICY_UID, ...fields }));
        },
        auditActions: async () => (await repos.AuditLogEntryMongo.find({}).toArray()).map((entry: any) => entry.action),
    });
});
