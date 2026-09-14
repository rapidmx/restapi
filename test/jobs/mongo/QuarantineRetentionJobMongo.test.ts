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
import { AttachmentMongo } from "../../../src/models/mongo/AttachmentMongo.js";
import { IngestQueueEntryMongo } from "../../../src/models/mongo/IngestQueueEntryMongo.js";
import { MatterMongo } from "../../../src/models/mongo/MatterMongo.js";
import { MessageMongo } from "../../../src/models/mongo/MessageMongo.js";
import { ScanResultMongo } from "../../../src/models/mongo/ScanResultMongo.js";
import { InMemoryBlobStore, registerTestDoubles } from "../../testDoubles.js";
import { IngestStatus, QuarantineReason, RecipientType, ScanTargetType } from "../../../src/models/types.js";

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
    let scanResultRepo: MongoRepository<ScanResultMongo>;
    let messageRepo: MongoRepository<MessageMongo>;
    let ingestQueueEntryRepo: MongoRepository<IngestQueueEntryMongo>;
    let matterRepo: MongoRepository<MatterMongo>;

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
        registerTestDoubles(objectFactory);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("QuarantineEntryMongo", QuarantineEntryMongo);
        models.set("ScanResultMongo", ScanResultMongo);
        models.set("MessageMongo", MessageMongo);
        models.set("AttachmentMongo", AttachmentMongo);
        models.set("IngestQueueEntryMongo", IngestQueueEntryMongo);
        models.set("MatterMongo", MatterMongo);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        quarantineEntryRepo = conn.getMongoRepository("QuarantineEntryMongo");
        scanResultRepo = conn.getMongoRepository("ScanResultMongo");
        messageRepo = conn.getMongoRepository("MessageMongo");
        ingestQueueEntryRepo = conn.getMongoRepository("IngestQueueEntryMongo");
        matterRepo = conn.getMongoRepository("MatterMongo");

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
            for (const repo of [scanResultRepo, messageRepo, ingestQueueEntryRepo, matterRepo] as MongoRepository<any>[]) {
                await repo.clear();
            }
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

    it("Purges an expired entry's ScanResult and raw blob, keeping a raw blob another recipient's message or pending ingest entry still references.", async () => {
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const scanResult = await scanResultRepo.save(new ScanResultMongo({ targetType: ScanTargetType.MESSAGE, targetUid: uuid.v4(), scannedAt: new Date() }));
        const ownKey = `ingest/${uuid.v4()}`;
        const deliveredKey = `ingest/${uuid.v4()}`;
        const pendingKey = `ingest/${uuid.v4()}`;
        for (const key of [ownKey, deliveredKey, pendingKey]) {
            await blobStore.put(key, Buffer.from("raw"));
        }
        const entries = [
            await createEntry({ rawBlobKey: ownKey, scanResultUid: scanResult.uid, dateCreated: new Date(Date.now() - (RETENTION_DAYS + 5) * DAY_MS) }),
            await createEntry({ rawBlobKey: deliveredKey, dateCreated: new Date(Date.now() - (RETENTION_DAYS + 5) * DAY_MS) }),
            await createEntry({ rawBlobKey: pendingKey, dateCreated: new Date(Date.now() - (RETENTION_DAYS + 5) * DAY_MS) }),
        ];
        expect(entries).toHaveLength(3);
        await messageRepo.save(
            new MessageMongo({
                mailboxUid: uuid.v4(),
                folderUid: uuid.v4(),
                messageId: "m@example.com",
                subject: "Hi",
                from: { address: "a@example.com", type: RecipientType.TO },
                recipients: [],
                sentDate: new Date(),
                receivedDate: new Date(),
                bodyBlobKey: deliveredKey,
                flags: { read: false, flagged: false, answered: false, forwarded: false },
                references: [],
                hasAttachments: false,
            }),
        );
        await ingestQueueEntryRepo.save(
            new IngestQueueEntryMongo({ mailboxUid: uuid.v4(), envelopeFrom: "a@example.com", envelopeTo: ["b@example.com"], rawBlobKey: pendingKey, status: IngestStatus.PENDING }),
        );

        await job.run();

        expect(await quarantineEntryRepo.count()).toBe(0);
        expect(await scanResultRepo.findOne({ uid: scanResult.uid } as any)).toBeNull();
        expect(await blobStore.exists(ownKey)).toBe(false);
        expect(await blobStore.exists(deliveredKey)).toBe(true);
        expect(await blobStore.exists(pendingKey)).toBe(true);
    });

    it("Keeps an expired entry whose mailbox is under an open legal hold.", async () => {
        const entry = await createEntry({ dateCreated: new Date(Date.now() - (RETENTION_DAYS + 5) * DAY_MS) });
        await matterRepo.save(
            new MatterMongo({ name: "Held", escrowScopeId: uuid.v4(), custodianMailboxUids: [entry.mailboxUid], dateRangeStart: new Date("2000-01-01"), dateRangeEnd: new Date("2100-01-01") }),
        );
        const other = await createEntry({ dateCreated: new Date(Date.now() - (RETENTION_DAYS + 5) * DAY_MS) });

        await job.run();

        expect(await quarantineEntryRepo.findOne({ uid: entry.uid } as any)).not.toBeNull();
        expect(await quarantineEntryRepo.findOne({ uid: other.uid } as any)).toBeNull();
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

    it("Stops mid-page at the batch size when an entry counted as skipped vanished underneath the page offset.", async () => {
        (job as any).batchSize = 3;
        const entries: QuarantineEntryMongo[] = [];
        for (let i = 0; i < 6; i++) {
            entries.push(await createEntry({ dateCreated: new Date(Date.now() - (RETENTION_DAYS + 20 - i) * DAY_MS) }));
        }
        const repoUtils = (job as any).quarantineEntryRepo;
        const originalDelete = repoUtils.delete.bind(repoUtils);
        vi.spyOn(repoUtils, "delete").mockImplementation(async (uid: any, opts: any) => {
            const result = await originalDelete(uid, opts);
            if (uid === entries[0].uid) {
                // The delete committed, but the call still reported failure (e.g. a timeout after the write).
                throw new Error("simulated post-commit failure");
            }
            return result;
        });

        await job.run();

        // Page 0 = [0, 1, 2]: 0 "fails" (skipped, yet really gone), 1 and 2 purge. Page 0 re-read = [3, 4, 5],
        // whose first row is treated as the already-skipped one; 4 purges and the run stops before 5.
        const remaining = (await quarantineEntryRepo.find({ uid: { $in: entries.map((e) => e.uid) } } as any).toArray()).map((e) => e.uid);
        expect(remaining.sort()).toEqual([entries[3].uid, entries[5].uid].sort());
    });

    it("Logs a warning (no throw) and still purges the entry when cleaning up its ScanResult/blob fails.", async () => {
        const entry = await createEntry({ dateCreated: new Date(Date.now() - (RETENTION_DAYS + 5) * DAY_MS) });
        vi.spyOn((job as any).scanResultRepo, "delete").mockRejectedValue(new Error("simulated cleanup failure"));
        const warnSpy = vi.spyOn((job as any).logger, "warn");

        await expect(job.run()).resolves.toBeUndefined();

        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("simulated cleanup failure"));
        expect(await quarantineEntryRepo.findOne({ uid: entry.uid } as any)).toBeNull();
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
