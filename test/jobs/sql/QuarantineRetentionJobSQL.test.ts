///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for QuarantineRetentionJobSQL: a real SQLite (better-sqlite3) connection
// and a real `ObjectFactory` construct the job exactly as production wiring would - see
// QuarantineRetentionJobMongo.test.ts's file header for the full rationale (also applies here verbatim). Uses
// `config.sql.ts`, whose `acl` datastore is ALSO SQL-backed (`AccessControlListSQL`, auto-selected by `ACLUtils`
// from the connection's runtime type) - so this file has no MongoDB dependency at all.
import { ACLUtils, AccessControlListSQL, ConnectionManager, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { In, Repository } from "typeorm";
import config from "../../config.sql.js";
import { QuarantineRetentionJobSQL } from "../../../src/jobs/sql/QuarantineRetentionJobSQL.js";
import { QuarantineEntrySQL } from "../../../src/models/sql/QuarantineEntrySQL.js";
import { AttachmentSQL } from "../../../src/models/sql/AttachmentSQL.js";
import { IngestQueueEntrySQL } from "../../../src/models/sql/IngestQueueEntrySQL.js";
import { MatterSQL } from "../../../src/models/sql/MatterSQL.js";
import { MessageSQL } from "../../../src/models/sql/MessageSQL.js";
import { ScanResultSQL } from "../../../src/models/sql/ScanResultSQL.js";
import { InMemoryBlobStore, registerTestDoubles } from "../../testDoubles.js";
import { IngestStatus, QuarantineReason, RecipientType, ScanTargetType } from "../../../src/models/types.js";

const RETENTION_DAYS = 30; // matches mail:jobs:quarantine_retention:retention_days in test/config.ts
const DAY_MS = 24 * 60 * 60 * 1000;

describe("QuarantineRetentionJobSQL Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: QuarantineRetentionJobSQL;
    let quarantineEntryRepo: Repository<QuarantineEntrySQL>;
    let scanResultRepo: Repository<ScanResultSQL>;
    let messageRepo: Repository<MessageSQL>;
    let ingestQueueEntryRepo: Repository<IngestQueueEntrySQL>;
    let matterRepo: Repository<MatterSQL>;

    const createEntry = async (data?: Partial<QuarantineEntrySQL>): Promise<QuarantineEntrySQL> => {
        const obj = new QuarantineEntrySQL({
            mailboxUid: uuid.v4(),
            reason: QuarantineReason.INFECTED,
            scanResultUid: uuid.v4(),
            rawBlobKey: `raw/${uuid.v4()}`,
            ...data,
        });
        return await quarantineEntryRepo.save(obj);
    };

    beforeAll(async () => {
        objectFactory = new ObjectFactory(config, logger);
        // Normally registered by `Server`'s own bootstrap - registered explicitly here since this file
        // deliberately bypasses `Server` (see QuarantineRetentionJobMongo.test.ts's header comment).
        objectFactory.register(ACLUtils);
        registerTestDoubles(objectFactory);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        // Not auto-discovered here the way `Server`'s `ClassLoader` scan would - a bare TypeORM `DataSource`
        // throws "No metadata found" from `getRepository()` for any entity not explicitly in this map.
        models.set("AccessControlListSQL", AccessControlListSQL);
        models.set("QuarantineEntrySQL", QuarantineEntrySQL);
        models.set("ScanResultSQL", ScanResultSQL);
        models.set("MessageSQL", MessageSQL);
        models.set("AttachmentSQL", AttachmentSQL);
        models.set("IngestQueueEntrySQL", IngestQueueEntrySQL);
        models.set("MatterSQL", MatterSQL);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        quarantineEntryRepo = conn.getRepository(QuarantineEntrySQL);
        scanResultRepo = conn.getRepository(ScanResultSQL);
        messageRepo = conn.getRepository(MessageSQL);
        ingestQueueEntryRepo = conn.getRepository(IngestQueueEntrySQL);
        matterRepo = conn.getRepository(MatterSQL);

        // Constructed once via real ObjectFactory DI: `@Init` builds its one real `RepoUtils` against the live
        // connection above.
        job = await objectFactory.newInstance(QuarantineRetentionJobSQL, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        for (const repo of [quarantineEntryRepo, scanResultRepo, messageRepo, ingestQueueEntryRepo, matterRepo] as Repository<any>[]) {
            await repo.clear();
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

        const found = await quarantineEntryRepo.findOne({ where: { uid: old.uid } });
        expect(found).toBeNull();
    });

    it("Purges a released entry older than the retention cutoff too - release status doesn't extend retention.", async () => {
        const oldReleased = await createEntry({
            dateCreated: new Date(Date.now() - (RETENTION_DAYS + 5) * DAY_MS),
            releasedAt: new Date(Date.now() - DAY_MS),
            releasedByUserUid: uuid.v4(),
        });

        await job.run();

        const found = await quarantineEntryRepo.findOne({ where: { uid: oldReleased.uid } });
        expect(found).toBeNull();
    });

    it("Purges an expired entry's ScanResult and raw blob, keeping a raw blob another recipient's message or pending ingest entry still references.", async () => {
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const scanResult = await scanResultRepo.save(new ScanResultSQL({ targetType: ScanTargetType.MESSAGE, targetUid: uuid.v4(), scannedAt: new Date() } as any));
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
            new MessageSQL({
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
            new IngestQueueEntrySQL({ mailboxUid: uuid.v4(), envelopeFrom: "a@example.com", envelopeTo: ["b@example.com"], rawBlobKey: pendingKey, status: IngestStatus.PENDING }),
        );

        await job.run();

        expect(await quarantineEntryRepo.count()).toBe(0);
        expect(await scanResultRepo.findOne({ where: { uid: scanResult.uid } })).toBeNull();
        expect(await blobStore.exists(ownKey)).toBe(false);
        expect(await blobStore.exists(deliveredKey)).toBe(true);
        expect(await blobStore.exists(pendingKey)).toBe(true);
    });

    it("Keeps an expired entry whose mailbox is under an open legal hold.", async () => {
        const entry = await createEntry({ dateCreated: new Date(Date.now() - (RETENTION_DAYS + 5) * DAY_MS) });
        await matterRepo.save(
            new MatterSQL({ name: "Held", escrowScopeId: uuid.v4(), custodianMailboxUids: [entry.mailboxUid], dateRangeStart: new Date("2000-01-01"), dateRangeEnd: new Date("2100-01-01") }),
        );
        const other = await createEntry({ dateCreated: new Date(Date.now() - (RETENTION_DAYS + 5) * DAY_MS) });

        await job.run();

        expect(await quarantineEntryRepo.findOne({ where: { uid: entry.uid } })).not.toBeNull();
        expect(await quarantineEntryRepo.findOne({ where: { uid: other.uid } })).toBeNull();
    });

    it("Keeps an entry created within the retention window.", async () => {
        const recent = await createEntry({ dateCreated: new Date(Date.now() - (RETENTION_DAYS - 5) * DAY_MS) });

        await job.run();

        const found = await quarantineEntryRepo.findOne({ where: { uid: recent.uid } });
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

        const remaining = await quarantineEntryRepo.find({ where: { uid: In(entries.map((e) => e.uid)) } });
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

        const badFound = await quarantineEntryRepo.findOne({ where: { uid: badEntry.uid } });
        const goodFound = await quarantineEntryRepo.findOne({ where: { uid: goodEntry.uid } });
        expect(badFound).not.toBeNull();
        expect(goodFound).toBeNull();
    });
});
