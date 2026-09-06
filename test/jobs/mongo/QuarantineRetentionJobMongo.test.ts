///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for QuarantineRetentionJobMongo: a real in-memory MongoDB connection and a
// real `ObjectFactory` construct the job exactly as production wiring would - its own `@Init` builds a real
// `RepoUtils` against the live connection. No repo is hand-mocked. See
// ../../jobs/mongo/ScanQueueJobMongo.test.ts's file header for the full rationale behind bypassing
// `Server`/`ClassLoader`.
import { MongoMemoryServer } from "mongodb-memory-server";
import { ACLUtils, ConnectionManager, MongoConnection, MongoRepository, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../../config.js";
import { QuarantineRetentionJobMongo } from "../../../src/jobs/mongo/QuarantineRetentionJobMongo.js";
import { QuarantineEntryMongo } from "../../../src/models/mongo/QuarantineEntryMongo.js";
import { QuarantineReason } from "../../../src/models/types.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

const RETENTION_DAYS = 30; // matches mail:jobs:quarantine_retention:retention_days in test/config.ts
const DAY_MS = 24 * 60 * 60 * 1000;

describe("QuarantineRetentionJobMongo Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: QuarantineRetentionJobMongo;
    let quarantineEntryRepo: MongoRepository<QuarantineEntryMongo>;

    const createEntry = async (data?: Partial<QuarantineEntryMongo>): Promise<QuarantineEntryMongo> => {
        const obj = new QuarantineEntryMongo({
            mailboxUid: uuid.v4(),
            reason: QuarantineReason.INFECTED,
            scanResultUid: uuid.v4(),
            rawBlobKey: `raw/${uuid.v4()}`,
            ...data,
        });
        return await quarantineEntryRepo.save(obj);
    };

    beforeAll(async () => {
        await mongod.start();
        objectFactory = new ObjectFactory(config, logger);
        // Normally registered by `Server`'s own bootstrap - registered explicitly here since this file
        // deliberately bypasses `Server` (see ScanQueueJobMongo.test.ts's header comment).
        objectFactory.register(ACLUtils);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("QuarantineEntryMongo", QuarantineEntryMongo);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        quarantineEntryRepo = conn.getMongoRepository("QuarantineEntryMongo");

        // Constructed once via real ObjectFactory DI: `@Init` builds its one real `RepoUtils` against the live
        // connection above.
        job = await objectFactory.newInstance(QuarantineRetentionJobMongo, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
        await mongod.stop();
    });

    beforeEach(async () => {
        try {
            await quarantineEntryRepo.clear();
        } catch (err: any) {
            if (err.message !== "ns not found") {
                throw err;
            }
        }
        // Restore the job's batch size to the configured default between tests, in case a test overrode it.
        (job as any).batchSize = config.get("mail:jobs:quarantine_retention:batch_size") ?? 500;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("Exposes the configured cron schedule.", () => {
        expect(job.schedule).toBe(config.get("mail:jobs:quarantine_retention:schedule"));
    });

    it("start() and stop() are no-ops beyond init().", async () => {
        await expect(job.start()).resolves.toBeUndefined();
        expect(job.stop()).toBeUndefined();
    });

    it("Does nothing when there are no quarantine entries.", async () => {
        await expect(job.run()).resolves.toBeUndefined();
    });

    it("Does nothing when quarantineEntryRepo is not yet initialized.", async () => {
        const original = (job as any).quarantineEntryRepo;
        (job as any).quarantineEntryRepo = undefined;
        try {
            await expect(job.run()).resolves.toBeUndefined();
        } finally {
            (job as any).quarantineEntryRepo = original;
        }
    });

    it("Purges an unreleased entry older than the retention cutoff.", async () => {
        const old = await createEntry({
            dateCreated: new Date(Date.now() - (RETENTION_DAYS + 5) * DAY_MS),
            releasedAt: undefined,
        });

        await job.run();

        const found = await quarantineEntryRepo.findOne({ uid: old.uid } as any);
        expect(found).toBeNull();
    });

    it("Purges a released entry older than the retention cutoff too - release status doesn't extend retention.", async () => {
        const oldReleased = await createEntry({
            dateCreated: new Date(Date.now() - (RETENTION_DAYS + 5) * DAY_MS),
            releasedAt: new Date(Date.now() - DAY_MS),
            releasedByUserUid: uuid.v4(),
        });

        await job.run();

        const found = await quarantineEntryRepo.findOne({ uid: oldReleased.uid } as any);
        expect(found).toBeNull();
    });

    it("Keeps an entry created within the retention window.", async () => {
        const recent = await createEntry({ dateCreated: new Date(Date.now() - (RETENTION_DAYS - 5) * DAY_MS) });

        await job.run();

        const found = await quarantineEntryRepo.findOne({ uid: recent.uid } as any);
        expect(found).not.toBeNull();
    });

    it("Bounds how many expired entries are purged per run to the configured batch size.", async () => {
        (job as any).batchSize = 2;
        const oldDate = new Date(Date.now() - (RETENTION_DAYS + 5) * DAY_MS);
        const entries = await Promise.all([
            createEntry({ dateCreated: oldDate }),
            createEntry({ dateCreated: oldDate }),
            createEntry({ dateCreated: oldDate }),
        ]);

        await job.run();

        const remaining = await quarantineEntryRepo.find({ uid: { $in: entries.map((e) => e.uid) } }).toArray();
        expect(remaining.length).toBe(1);
    });

    it("Logs a warning and continues purging subsequent entries when one delete throws.", async () => {
        // Real infrastructure has no deterministic, non-destructive way to make a single entry's own delete
        // throw (a plain delete against a healthy DB simply succeeds, even for an already-removed row) - this
        // targets a fault at the one seam real infra can't reach: the job's own internal `RepoUtils.delete()`
        // call for the "bad" entry, restored immediately after so every other call in this test still goes to
        // the real database.
        const oldDate = new Date(Date.now() - (RETENTION_DAYS + 5) * DAY_MS);
        const badEntry = await createEntry({ dateCreated: oldDate });
        const goodEntry = await createEntry({ dateCreated: oldDate });

        const repoUtils = (job as any).quarantineEntryRepo;
        const originalDelete = repoUtils.delete.bind(repoUtils);
        vi.spyOn(repoUtils, "delete").mockImplementation(async (uid: string, opts: any) => {
            if (uid === badEntry.uid) {
                throw new Error("simulated database failure");
            }
            return originalDelete(uid, opts);
        });

        await expect(job.run()).resolves.toBeUndefined();

        const badFound = await quarantineEntryRepo.findOne({ uid: badEntry.uid } as any);
        const goodFound = await quarantineEntryRepo.findOne({ uid: goodEntry.uid } as any);
        expect(badFound).not.toBeNull();
        expect(goodFound).toBeNull();
    });
});
