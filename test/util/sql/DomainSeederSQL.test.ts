///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for DomainSeederSQL: a real SQLite connection and a real `ObjectFactory` construct the seeder exactly as the server
// does at startup. The behaviour itself is in ../domainSeedSuite.ts, shared with the Mongo backend; `seededDomains` is a JSON column here.
import { ACLUtils, AccessControlListSQL, ConnectionManager, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import config from "../../config.sql.js";
import { NullDkimKeyProvider } from "../../../src/dkim/NullDkimKeyProvider.js";
import { AuditLogEntrySQL } from "../../../src/models/sql/AuditLogEntrySQL.js";
import { DnsProviderSQL } from "../../../src/models/sql/DnsProviderSQL.js";
import { DomainSQL } from "../../../src/models/sql/DomainSQL.js";
import { SetupStateSQL } from "../../../src/models/sql/SetupStateSQL.js";
import { DomainSeederSQL } from "../../../src/util/sql/DomainSeederSQL.js";
import { SETUP_STATE_UID } from "../../../src/util/SetupStateUtils.js";
import { InMemoryDnsPublisher } from "../../testDoubles.js";
import { domainSeedSuite } from "../domainSeedSuite.js";

describe("DomainSeederSQL Tests (real DB + DI)", () => {
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
        objectFactory.register(NullDkimKeyProvider, "DkimKeyProvider");
        objectFactory.register(InMemoryDnsPublisher, "DnsPublisher");

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("AccessControlListSQL", AccessControlListSQL);
        for (const cls of [DomainSQL, SetupStateSQL, AuditLogEntrySQL, DnsProviderSQL]) {
            models.set(cls.name, cls);
        }
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        for (const cls of [DomainSQL, SetupStateSQL, AuditLogEntrySQL, DnsProviderSQL]) {
            repos[cls.name] = conn.getRepository(cls);
        }
    });

    afterAll(async () => {
        // The database file is shared with later SQL suites, which must not find these domains, providers or setup state.
        await clear();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await clear();
    });

    it("Resolves the registered DkimKeyProvider and DnsPublisher, and builds its repositories.", async () => {
        const seeder: any = await objectFactory.newInstance(DomainSeederSQL, { name: "default" });
        expect(seeder.dkimKeyProvider).toBeInstanceOf(NullDkimKeyProvider);
        expect(seeder.dnsPublisher).toBeInstanceOf(InMemoryDnsPublisher);
        expect(seeder.domainRepo).toBeDefined();
        expect(seeder.setupStateRepo).toBeDefined();
        expect(seeder.dnsProviderRepo).toBeDefined();
        expect(seeder.auditLogUtils).toBeDefined();
    });

    domainSeedSuite({
        config,
        parallelWrites: false,
        newSeeder: async () => await objectFactory.newInstance(DomainSeederSQL, { name: `replica-${uuid.v4()}` }),
        saveDomain: async (fields) => {
            const name = fields.name as string;
            await repos.DomainSQL.save(new DomainSQL({ uid: name, enabled: true, verified: false, verificationToken: uuid.v4(), ...fields } as any));
        },
        domainRow: async (uid) => (await repos.DomainSQL.findOne({ where: { uid } })) ?? undefined,
        domainRows: async () => await repos.DomainSQL.find(),
        deleteDomain: async (uid) => {
            await repos.DomainSQL.delete({ uid });
        },
        saveProvider: async (fields) => {
            const name = fields.name as string;
            await repos.DnsProviderSQL.save(
                new DnsProviderSQL({ name, nameKey: name.toLowerCase(), type: "cloudflare", options: {}, enabled: true, allowTakeover: false, ...fields } as any),
            );
        },
        setupRow: async () => (await repos.SetupStateSQL.findOne({ where: { uid: SETUP_STATE_UID } })) ?? undefined,
        saveSetupState: async (fields) => {
            await repos.SetupStateSQL.save(new SetupStateSQL({ uid: SETUP_STATE_UID, ...fields } as any));
        },
        auditEntries: async () => await repos.AuditLogEntrySQL.find(),
    });
});
