///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for DkimRotationJobMongo: a real in-memory MongoDB connection and a real `ObjectFactory` construct the job exactly
// as production wiring would. The phases themselves are in ../dkimRotationSuite.ts, shared with the SQL backend; see DomainVerificationJobMongo.test.ts
// for why `Server` is bypassed.
import { MongoMemoryServer } from "mongodb-memory-server";
import { ACLUtils, ConnectionManager, MongoConnection, MongoRepository, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../../config.js";
import { DkimRotationJobMongo } from "../../../src/jobs/mongo/DkimRotationJobMongo.js";
import { NullDkimKeyProvider } from "../../../src/dkim/NullDkimKeyProvider.js";
import { AuditLogEntryMongo } from "../../../src/models/mongo/AuditLogEntryMongo.js";
import { DomainMongo } from "../../../src/models/mongo/DomainMongo.js";
import { AuditAction } from "../../../src/models/types.js";
import { InMemoryDnsPublisher, StaticDnsResolver } from "../../testDoubles.js";
import { dkimRotationSuite } from "../dkimRotationSuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("DkimRotationJobMongo Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: DkimRotationJobMongo;
    let domainRepo: MongoRepository<DomainMongo>;
    let auditLogRepo: MongoRepository<AuditLogEntryMongo>;
    let dnsResolver: StaticDnsResolver;

    beforeAll(async () => {
        await mongod.start();
        objectFactory = new ObjectFactory(config, logger);
        // Normally registered by `Server`'s own bootstrap - registered explicitly here since this file bypasses `Server`.
        objectFactory.register(ACLUtils);
        objectFactory.register(StaticDnsResolver, "DnsResolver");
        objectFactory.register(NullDkimKeyProvider, "DkimKeyProvider");
        objectFactory.register(InMemoryDnsPublisher, "DnsPublisher");

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("DomainMongo", DomainMongo);
        models.set("AuditLogEntryMongo", AuditLogEntryMongo);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        domainRepo = conn.getMongoRepository("DomainMongo");
        auditLogRepo = conn.getMongoRepository("AuditLogEntryMongo");

        job = await objectFactory.newInstance(DkimRotationJobMongo, { name: "default" });
        dnsResolver = objectFactory.getInstance<StaticDnsResolver>("DnsResolver")!;
    });

    afterAll(async () => {
        await objectFactory.destroy();
        await mongod.stop();
    });

    beforeEach(async () => {
        for (const r of [domainRepo, auditLogRepo]) {
            try {
                await r.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
        dnsResolver.records.clear();
        dnsResolver.failing.clear();
    });

    it("Resolves the registered DkimKeyProvider and DnsPublisher.", () => {
        expect((job as any).dkimKeyProvider).toBeInstanceOf(NullDkimKeyProvider);
        expect((job as any).dnsPublisher).toBeInstanceOf(InMemoryDnsPublisher);
    });

    dkimRotationSuite({
        job: () => job,
        newJob: async () => await objectFactory.newInstance(DkimRotationJobMongo, { name: `replica-${uuid.v4()}` }),
        createDomain: async (data) => {
            const name: string = data?.name ?? `${uuid.v4()}.example.com`;
            return await domainRepo.save(new DomainMongo({ name, uid: name, enabled: true, verified: false, verificationToken: uuid.v4(), ...data }));
        },
        findDomain: async (uid) => (await domainRepo.findOne({ uid } as any))!,
        auditEntries: async (action: AuditAction) => await auditLogRepo.find({ action }).toArray(),
        dnsResolver: () => dnsResolver,
    });
});
