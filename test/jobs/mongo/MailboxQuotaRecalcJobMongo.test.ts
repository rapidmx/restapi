///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for MailboxQuotaRecalcJobMongo: a real in-memory MongoDB connection and a
// real `ObjectFactory` construct the job exactly as production wiring would - its own `@Init` builds real
// `RepoUtils` against the live connection, and its `@Inject("BlobStore")` field resolves to a real (in-memory)
// `BlobStore` test double. No repo is hand-mocked. See ScanQueueJobMongo.test.ts's file header for the full
// rationale behind bypassing `Server`/`ClassLoader`.
import { MongoMemoryServer } from "mongodb-memory-server";
import { ACLUtils, ConnectionManager, MongoConnection, MongoRepository, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../../config.js";
import { registerTestDoubles } from "../../testDoubles.js";
import { MailboxQuotaRecalcJobMongo } from "../../../src/jobs/mongo/MailboxQuotaRecalcJobMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { MessageMongo } from "../../../src/models/mongo/MessageMongo.js";
import { AttachmentMongo } from "../../../src/models/mongo/AttachmentMongo.js";
import { RecipientType } from "../../../src/models/types.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("MailboxQuotaRecalcJobMongo Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: MailboxQuotaRecalcJobMongo;
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let messageRepo: MongoRepository<MessageMongo>;
    let attachmentRepo: MongoRepository<AttachmentMongo>;

    const createMailbox = async (data?: Partial<MailboxMongo>): Promise<MailboxMongo> => {
        const obj = new MailboxMongo({
            ownerUserUid: uuid.v4(),
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            displayName: "Test Mailbox",
            timezone: "UTC",
            quotaBytes: 1000000000,
            usedBytes: 0,
            ...data,
        });
        return await mailboxRepo.save(obj);
    };

    const createMessage = async (mailboxUid: string, data?: Partial<MessageMongo>): Promise<MessageMongo> => {
        const obj = new MessageMongo({
            folderUid: uuid.v4(),
            mailboxUid,
            messageId: `<${uuid.v4()}@example.com>`,
            subject: "Test",
            from: { address: "sender@example.com", type: RecipientType.TO },
            bodyBlobKey: `body/${uuid.v4()}`,
            hasAttachments: false,
            ...data,
        });
        return await messageRepo.save(obj);
    };

    const createAttachment = async (messageUid: string, mailboxUid: string, data?: Partial<AttachmentMongo>): Promise<AttachmentMongo> => {
        const obj = new AttachmentMongo({
            messageUid,
            folderUid: uuid.v4(),
            mailboxUid,
            filename: "file.txt",
            mimeType: "text/plain",
            sizeBytes: 0,
            blobKey: `att/${uuid.v4()}`,
            ...data,
        });
        return await attachmentRepo.save(obj);
    };

    beforeAll(async () => {
        await mongod.start();
        objectFactory = new ObjectFactory(config, logger);
        registerTestDoubles(objectFactory);
        // Normally registered by `Server`'s own bootstrap - registered explicitly here since this file
        // deliberately bypasses `Server` (see ScanQueueJobMongo.test.ts's header comment).
        objectFactory.register(ACLUtils);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("MailboxMongo", MailboxMongo);
        models.set("MessageMongo", MessageMongo);
        models.set("AttachmentMongo", AttachmentMongo);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        mailboxRepo = conn.getMongoRepository("MailboxMongo");
        messageRepo = conn.getMongoRepository("MessageMongo");
        attachmentRepo = conn.getMongoRepository("AttachmentMongo");

        // Constructed once via real ObjectFactory DI: `@Init` builds its three real `RepoUtils` against the
        // live connection above, and `@Inject("BlobStore")` resolves to the registered test double.
        job = await objectFactory.newInstance(MailboxQuotaRecalcJobMongo, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
        await mongod.stop();
    });

    beforeEach(async () => {
        for (const repo of [mailboxRepo, messageRepo, attachmentRepo]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
        // Restore the job's batch size to the configured default between tests, in case a test overrode it.
        (job as any).batchSize = config.get("mail:jobs:mailbox_quota_recalc:batch_size") ?? 100;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("Exposes the configured cron schedule.", () => {
        expect(job.schedule).toBe(config.get("mail:jobs:mailbox_quota_recalc:schedule"));
    });

    it("start() and stop() are no-ops beyond init().", async () => {
        await expect(job.start()).resolves.toBeUndefined();
        expect(job.stop()).toBeUndefined();
    });

    it("Does nothing when there are no mailboxes.", async () => {
        await expect(job.run()).resolves.toBeUndefined();
    });

    it.each(["mailboxRepo", "messageRepo", "attachmentRepo", "blobStore"] as const)(
        "Does nothing when %s is not yet initialized.",
        async (field) => {
            const original = (job as any)[field];
            (job as any)[field] = undefined;
            try {
                await expect(job.run()).resolves.toBeUndefined();
            } finally {
                (job as any)[field] = original;
            }
        },
    );

    it("Sums body blob sizes and attachment sizes across every message and updates usedBytes when it drifted.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const mailbox = await createMailbox({ usedBytes: 0 });
        const bodyKey1 = `body/${uuid.v4()}`;
        const bodyKey2 = `body/${uuid.v4()}`;
        await blobStore.put(bodyKey1, Buffer.alloc(1000));
        await blobStore.put(bodyKey2, Buffer.alloc(200));
        const message1 = await createMessage(mailbox.uid, { bodyBlobKey: bodyKey1, hasAttachments: true });
        await createMessage(mailbox.uid, { bodyBlobKey: bodyKey2, hasAttachments: false });
        await createAttachment(message1.uid, mailbox.uid, { sizeBytes: 100 });
        await createAttachment(message1.uid, mailbox.uid, { sizeBytes: 50 });

        await job.run();

        // 1000 (msg1 body) + 150 (msg1 attachments) + 200 (msg2 body) = 1350
        const updated = await mailboxRepo.findOne({ uid: mailbox.uid } as any);
        expect(updated!.usedBytes).toBe(1350);
        expect(updated!.version).toBe(mailbox.version + 1);
    });

    it("Skips the write entirely when the recomputed usedBytes matches the stored value.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const bodyKey = `body/${uuid.v4()}`;
        await blobStore.put(bodyKey, Buffer.alloc(500));
        const mailbox = await createMailbox({ usedBytes: 500 });
        await createMessage(mailbox.uid, { bodyBlobKey: bodyKey, hasAttachments: false });

        await job.run();

        const updated = await mailboxRepo.findOne({ uid: mailbox.uid } as any);
        expect(updated!.usedBytes).toBe(500);
        // No write happened at all - the version is unchanged from creation.
        expect(updated!.version).toBe(mailbox.version);
    });

    it("Treats a body blob that fails to size as 0 bytes and still sums the rest.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const mailbox = await createMailbox({ usedBytes: 0 });
        // No blob was ever put at this key, so `blobStore.size()` rejects with a real "no blob" error.
        await createMessage(mailbox.uid, { bodyBlobKey: `body/${uuid.v4()}`, hasAttachments: false });
        const bodyKey2 = `body/${uuid.v4()}`;
        await blobStore.put(bodyKey2, Buffer.alloc(300));
        await createMessage(mailbox.uid, { bodyBlobKey: bodyKey2, hasAttachments: false });

        await job.run();

        const updated = await mailboxRepo.findOne({ uid: mailbox.uid } as any);
        expect(updated!.usedBytes).toBe(300);
    });

    it("Sums ALL messages in a mailbox, not just the first page, when it has more than one page's worth.", async () => {
        // `RepoUtils.find()` defaults to a 100-row cap when no pagination is requested - `recalcMailbox()` used
        // to call it unpaginated, silently truncating usedBytes to only the first ~100 messages for any larger
        // mailbox. Uses a small page size (10) via a stubbed default so 25 messages genuinely spans multiple
        // pages without the test needing to create 100+ real documents.
        const findAllPages = (job as any).findAllPages.bind(job);
        const pageSizeSpy = vi
            .spyOn(job as any, "findAllPages")
            .mockImplementation((repo: any, criteria: any) => findAllPages(repo, criteria, 10));
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const bodyKey = `body/${uuid.v4()}`;
        await blobStore.put(bodyKey, Buffer.alloc(10));
        const mailbox = await createMailbox({ usedBytes: 0 });
        const messageCount = 25;
        for (let i = 0; i < messageCount; i++) {
            await createMessage(mailbox.uid, { bodyBlobKey: bodyKey, hasAttachments: false });
        }

        await job.run();

        const updated = await mailboxRepo.findOne({ uid: mailbox.uid } as any);
        expect(updated!.usedBytes).toBe(messageCount * 10);
        pageSizeSpy.mockRestore();
    });

    it("Bounds how many mailboxes are processed per run to the configured batch size.", async () => {
        (job as any).batchSize = 2;
        const bodyKey = `body/${uuid.v4()}`;
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        await blobStore.put(bodyKey, Buffer.alloc(42));
        const mailboxes = [];
        for (let i = 0; i < 3; i++) {
            const mailbox = await createMailbox({ usedBytes: 0 });
            await createMessage(mailbox.uid, { bodyBlobKey: bodyKey, hasAttachments: false });
            mailboxes.push(mailbox);
        }

        await job.run();

        const updatedMailboxes = await mailboxRepo.find({ uid: { $in: mailboxes.map((m) => m.uid) } }).toArray();
        const processedCount = updatedMailboxes.filter((m) => m.usedBytes === 42).length;
        expect(processedCount).toBe(2);
    });

    it("Logs an error and continues with the next mailbox when recalculating one mailbox throws.", async () => {
        // Real infrastructure has no deterministic, non-destructive way to make a single mailbox's own
        // recalculation throw (a plain query against a healthy DB simply succeeds) - this targets a fault at
        // the one seam real infra can't reach: the job's own internal `RepoUtils.find()` call for the "bad"
        // mailbox's messages, restored immediately after so every other call in this test still goes to the
        // real database. This is the same class of gap the `AlwaysCleanAvScanProvider`/`RecordingMailTransport`
        // markers exist for elsewhere in this suite - simulating a failure mode real infra can't be coerced
        // into on demand.
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const bodyKey = `body/${uuid.v4()}`;
        await blobStore.put(bodyKey, Buffer.alloc(42));
        const badMailbox = await createMailbox({ usedBytes: 0 });
        const goodMailbox = await createMailbox({ usedBytes: 0 });
        await createMessage(goodMailbox.uid, { bodyBlobKey: bodyKey, hasAttachments: false });

        const messageRepoUtils = (job as any).messageRepo;
        const originalFind = messageRepoUtils.find.bind(messageRepoUtils);
        vi.spyOn(messageRepoUtils, "find").mockImplementation(async (query: any, opts: any) => {
            if (query.mailboxUid === badMailbox.uid) {
                throw new Error("simulated database failure");
            }
            return originalFind(query, opts);
        });

        await expect(job.run()).resolves.toBeUndefined();

        const updatedBad = await mailboxRepo.findOne({ uid: badMailbox.uid } as any);
        const updatedGood = await mailboxRepo.findOne({ uid: goodMailbox.uid } as any);
        expect(updatedBad!.usedBytes).toBe(0);
        expect(updatedGood!.usedBytes).toBe(42);
    });
});
