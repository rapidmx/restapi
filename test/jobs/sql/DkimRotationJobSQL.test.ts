///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for DkimRotationJobSQL: a real SQLite connection and a real `ObjectFactory` construct the job exactly as production
// wiring would. The phases themselves are in ../dkimRotationSuite.ts, shared with the Mongo backend; on SQL the rotation's dates come back as text from
// its JSON column, which the job and the suite read the same way.
import { ACLUtils, AccessControlListSQL, ConnectionManager, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import config from "../../config.sql.js";
import { DkimRotationJobSQL } from "../../../src/jobs/sql/DkimRotationJobSQL.js";
import { NullDkimKeyProvider } from "../../../src/dkim/NullDkimKeyProvider.js";
import { AuditLogEntrySQL } from "../../../src/models/sql/AuditLogEntrySQL.js";
import { DomainSQL } from "../../../src/models/sql/DomainSQL.js";
import { AuditAction } from "../../../src/models/types.js";
import { InMemoryDnsPublisher, StaticDnsResolver } from "../../testDoubles.js";
import { dkimRotationSuite } from "../dkimRotationSuite.js";

describe("DkimRotationJobSQL Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: DkimRotationJobSQL;
    let domainRepo: Repository<DomainSQL>;
    let auditLogRepo: Repository<AuditLogEntrySQL>;
    let dnsResolver: StaticDnsResolver;

    beforeAll(async () => {
        objectFactory = new ObjectFactory(config, logger);
        // Normally registered by `Server`'s own bootstrap - registered explicitly here since this file bypasses `Server`.
        objectFactory.register(ACLUtils);
        objectFactory.register(StaticDnsResolver, "DnsResolver");
        objectFactory.register(NullDkimKeyProvider, "DkimKeyProvider");
        objectFactory.register(InMemoryDnsPublisher, "DnsPublisher");

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("AccessControlListSQL", AccessControlListSQL);
        models.set("DomainSQL", DomainSQL);
        models.set("AuditLogEntrySQL", AuditLogEntrySQL);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        domainRepo = conn.getRepository(DomainSQL);
        auditLogRepo = conn.getRepository(AuditLogEntrySQL);

        job = await objectFactory.newInstance(DkimRotationJobSQL, { name: "default" });
        dnsResolver = objectFactory.getInstance<StaticDnsResolver>("DnsResolver")!;
    });

    afterAll(async () => {
        // The database file is shared with later SQL suites, which must not find these (verified) domains.
        await domainRepo.clear();
        await auditLogRepo.clear();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await domainRepo.clear();
        await auditLogRepo.clear();
        dnsResolver.records.clear();
        dnsResolver.failing.clear();
    });

    it("Resolves the registered DkimKeyProvider and DnsPublisher.", () => {
        expect((job as any).dkimKeyProvider).toBeInstanceOf(NullDkimKeyProvider);
        expect((job as any).dnsPublisher).toBeInstanceOf(InMemoryDnsPublisher);
    });

    dkimRotationSuite({
        job: () => job,
        newJob: async () => await objectFactory.newInstance(DkimRotationJobSQL, { name: `replica-${uuid.v4()}` }),
        createDomain: async (data) => {
            const name: string = data?.name ?? `${uuid.v4()}.example.com`;
            return await domainRepo.save(new DomainSQL({ name, uid: name, enabled: true, verified: false, verificationToken: uuid.v4(), ...data } as any));
        },
        findDomain: async (uid) => (await domainRepo.findOne({ where: { uid } }))!,
        auditEntries: async (action: AuditAction) => await auditLogRepo.find({ where: { action } }),
        dnsResolver: () => dnsResolver,
    });
});
