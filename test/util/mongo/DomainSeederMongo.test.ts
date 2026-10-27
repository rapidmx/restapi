///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for DomainSeederMongo: a real in-memory MongoDB connection and a real `ObjectFactory` construct the seeder exactly as
// the server does at startup. The behaviour itself is in ../domainSeedSuite.ts, shared with the SQL backend.
import { MongoMemoryServer } from "mongodb-memory-server";
import { ACLUtils, ConnectionManager, MongoConnection, MongoRepository, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../../config.js";
import { NullDkimKeyProvider } from "../../../src/dkim/NullDkimKeyProvider.js";
import { AuditLogEntryMongo } from "../../../src/models/mongo/AuditLogEntryMongo.js";
import { DnsProviderMongo } from "../../../src/models/mongo/DnsProviderMongo.js";
import { DomainMongo } from "../../../src/models/mongo/DomainMongo.js";
import { SetupStateMongo } from "../../../src/models/mongo/SetupStateMongo.js";
import { DomainSeederMongo } from "../../../src/util/mongo/DomainSeederMongo.js";
import { SETUP_STATE_UID } from "../../../src/util/SetupStateUtils.js";
import { InMemoryDnsPublisher } from "../../testDoubles.js";
import { domainSeedSuite } from "../domainSeedSuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("DomainSeederMongo Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    const repos: Record<string, MongoRepository<any>> = {};

    beforeAll(async () => {
        await mongod.start();
        objectFactory = new ObjectFactory(config, logger);
        // Normally registered by `Server`'s own bootstrap - registered explicitly here since this file bypasses `Server`.
        objectFactory.register(ACLUtils);
        objectFactory.register(NullDkimKeyProvider, "DkimKeyProvider");
        objectFactory.register(InMemoryDnsPublisher, "DnsPublisher");

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        for (const cls of [DomainMongo, SetupStateMongo, AuditLogEntryMongo, DnsProviderMongo]) {
            models.set(cls.name, cls);
        }
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        for (const name of models.keys()) {
            repos[name] = conn.getMongoRepository(name);
        }
    });

    afterAll(async () => {
        await objectFactory.destroy();
        await mongod.stop();
    });

    beforeEach(async () => {
        for (const repo of Object.values(repos)) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
    });

    it("Resolves the registered DkimKeyProvider and DnsPublisher, and builds its repositories.", async () => {
        const seeder: any = await objectFactory.newInstance(DomainSeederMongo, { name: "default" });
        expect(seeder.dkimKeyProvider).toBeInstanceOf(NullDkimKeyProvider);
        expect(seeder.dnsPublisher).toBeInstanceOf(InMemoryDnsPublisher);
        expect(seeder.domainRepo).toBeDefined();
        expect(seeder.setupStateRepo).toBeDefined();
        expect(seeder.dnsProviderRepo).toBeDefined();
        expect(seeder.auditLogUtils).toBeDefined();
    });

    domainSeedSuite({
        config,
        parallelWrites: true,
        newSeeder: async () => await objectFactory.newInstance(DomainSeederMongo, { name: `replica-${uuid.v4()}` }),
        saveDomain: async (fields) => {
            const name = fields.name as string;
            await repos.DomainMongo.save(new DomainMongo({ uid: name, enabled: true, verified: false, verificationToken: uuid.v4(), ...fields }));
        },
        domainRow: async (uid) => (await repos.DomainMongo.findOne({ uid } as any)) ?? undefined,
        domainRows: async () => await repos.DomainMongo.find({}).toArray(),
        deleteDomain: async (uid) => {
            await repos.DomainMongo.deleteMany({ uid } as any);
        },
        saveProvider: async (fields) => {
            const name = fields.name as string;
            await repos.DnsProviderMongo.save(
                new DnsProviderMongo({ name, nameKey: name.toLowerCase(), type: "cloudflare", options: {}, enabled: true, allowTakeover: false, ...fields } as any),
            );
        },
        setupRow: async () => (await repos.SetupStateMongo.findOne({ uid: SETUP_STATE_UID } as any)) ?? undefined,
        saveSetupState: async (fields) => {
            await repos.SetupStateMongo.save(new SetupStateMongo({ uid: SETUP_STATE_UID, ...fields }));
        },
        auditEntries: async () => await repos.AuditLogEntryMongo.find({}).toArray(),
    });
});
