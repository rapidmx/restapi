///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for RetentionEnforcementJobMongo - see
// QuarantineRetentionJobMongo.test.ts's file header for the full rationale (bypasses `Server`, wires a real
// ObjectFactory/ConnectionManager directly).
import { MongoMemoryServer } from "mongodb-memory-server";
import { ACLUtils, ConnectionManager, MongoConnection, MongoRepository, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../../config.js";
import { RetentionEnforcementJobMongo } from "../../../src/jobs/mongo/RetentionEnforcementJobMongo.js";
import { AttachmentMongo } from "../../../src/models/mongo/AttachmentMongo.js";
import { AuditLogEntryMongo } from "../../../src/models/mongo/AuditLogEntryMongo.js";
import { MatterMongo } from "../../../src/models/mongo/MatterMongo.js";
import { MessageMongo } from "../../../src/models/mongo/MessageMongo.js";
import { RetentionPolicyMongo } from "../../../src/models/mongo/RetentionPolicyMongo.js";
import { AuditAction, AuditLogEntry, RecipientType } from "../../../src/models/types.js";
import { InMemoryBlobStore, registerTestDoubles } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

const DAY_MS = 24 * 60 * 60 * 1000;

describe("RetentionEnforcementJobMongo Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: RetentionEnforcementJobMongo;
    let retentionPolicyRepo: MongoRepository<RetentionPolicyMongo>;
    let messageRepo: MongoRepository<MessageMongo>;
    let auditLogRepo: MongoRepository<AuditLogEntryMongo>;
    let matterRepo: MongoRepository<MatterMongo>;
    let attachmentRepo: MongoRepository<AttachmentMongo>;

    const createMessage = async (data?: Partial<MessageMongo>): Promise<MessageMongo> => {
        const obj = new MessageMongo({
            mailboxUid: uuid.v4(),
            folderUid: uuid.v4(),
            messageId: `${uuid.v4()}@example.com`,
            subject: "Test Subject",
            from: { address: "sender@example.com", type: RecipientType.TO },
            recipients: [{ address: "recipient@example.com", type: RecipientType.TO }],
            sentDate: new Date(),
            receivedDate: new Date(),
            bodyBlobKey: `bodies/${uuid.v4()}`,
            bodyPreview: "Hello",
            flags: { read: false, flagged: false, answered: false, forwarded: false },
            references: [],
            hasAttachments: false,
            ...data,
        });
        return await messageRepo.save(obj);
    };

    const createAuditLogEntry = async (data?: Partial<AuditLogEntry>): Promise<AuditLogEntryMongo> => {
        const obj = new AuditLogEntryMongo({
            action: AuditAction.MAILBOX_CREATE,
            targetType: "Mailbox",
            targetUid: uuid.v4(),
            ...data,
        });
        return await auditLogRepo.save(obj);
    };

    const createMatter = async (data?: Partial<MatterMongo>): Promise<MatterMongo> => {
        const obj = new MatterMongo({
            name: "Test Matter",
            escrowScopeId: uuid.v4(),
            custodianMailboxUids: [],
            dateRangeStart: new Date("2020-01-01"),
            dateRangeEnd: new Date("2030-01-01"),
            ...data,
        });
        return await matterRepo.save(obj);
    };

    beforeAll(async () => {
        await mongod.start();
        objectFactory = new ObjectFactory(config, logger);
        objectFactory.register(ACLUtils);
        registerTestDoubles(objectFactory);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("RetentionPolicyMongo", RetentionPolicyMongo);
        models.set("MessageMongo", MessageMongo);
        models.set("AuditLogEntryMongo", AuditLogEntryMongo);
        models.set("MatterMongo", MatterMongo);
        models.set("AttachmentMongo", AttachmentMongo);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        retentionPolicyRepo = conn.getMongoRepository("RetentionPolicyMongo");
        messageRepo = conn.getMongoRepository("MessageMongo");
        auditLogRepo = conn.getMongoRepository("AuditLogEntryMongo");
        matterRepo = conn.getMongoRepository("MatterMongo");
        attachmentRepo = conn.getMongoRepository("AttachmentMongo");

        job = await objectFactory.newInstance(RetentionEnforcementJobMongo, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
        await mongod.stop();
    });

    beforeEach(async () => {
        for (const repo of [retentionPolicyRepo, messageRepo, auditLogRepo, matterRepo, attachmentRepo]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
        (job as any).batchSize = config.get("mail:jobs:retention_enforcement:batch_size") ?? 500;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("Exposes the configured cron schedule.", () => {
        expect(job.schedule).toBe(config.get("mail:jobs:retention_enforcement:schedule"));
    });

    it("start() and stop() are no-ops beyond init().", async () => {
        await expect(job.start()).resolves.toBeUndefined();
        expect(job.stop()).toBeUndefined();
    });

    it("Does nothing when no policy row exists at all.", async () => {
        const message = await createMessage({ sentDate: new Date(Date.now() - 3650 * DAY_MS) });

        await expect(job.run()).resolves.toBeUndefined();

        const found = await messageRepo.findOne({ uid: message.uid } as any);
        expect(found).toBeTruthy();
    });

    it("Does nothing when a policy row exists but neither field is configured.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicyMongo({ uid: "retention-policy" }));
        const message = await createMessage({ sentDate: new Date(Date.now() - 3650 * DAY_MS) });

        await expect(job.run()).resolves.toBeUndefined();

        const found = await messageRepo.findOne({ uid: message.uid } as any);
        expect(found).toBeTruthy();
    });

    it("Does nothing when the repos are not yet initialized.", async () => {
        const original = (job as any).messageRepo;
        (job as any).messageRepo = undefined;
        try {
            await expect(job.run()).resolves.toBeUndefined();
        } finally {
            (job as any).messageRepo = original;
        }
    });

    it("Purges a message older than messageRetentionDays and records one audit entry.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicyMongo({ uid: "retention-policy", messageRetentionDays: 30 }));
        const old = await createMessage({ sentDate: new Date(Date.now() - 35 * DAY_MS) });

        await job.run();

        const found = await messageRepo.findOne({ uid: old.uid } as any);
        expect(found).toBeFalsy();

        const entries = await auditLogRepo.find({ action: AuditAction.RETENTION_PURGE_EXECUTED }).toArray();
        expect(entries.length).toBe(1);
        expect(entries[0].targetType).toBe("Message");
        expect(entries[0].details).toEqual({ count: 1, maxAgeDays: 30 });
    });

    it("Purging an expired message also purges every Attachment referencing it, plus both entities' own BlobStore content - PHI/PII a retention policy asserts is gone must not survive as an orphaned, independently-downloadable row or blob.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicyMongo({ uid: "retention-policy", messageRetentionDays: 30 }));
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const bodyBlobKey = `bodies/${uuid.v4()}`;
        const sanitizedHtmlBlobKey = `sanitized/${uuid.v4()}`;
        await blobStore.put(bodyBlobKey, Buffer.from("raw"));
        await blobStore.put(sanitizedHtmlBlobKey, Buffer.from("<p>html</p>"));
        const old = await createMessage({
            sentDate: new Date(Date.now() - 35 * DAY_MS),
            bodyBlobKey,
            sanitizedHtmlBlobKey,
            hasAttachments: true,
        });

        const attachmentBlobKey = `attachments/${uuid.v4()}`;
        const extractedTextBlobKey = `extracted/${uuid.v4()}`;
        await blobStore.put(attachmentBlobKey, Buffer.from("attachment bytes"));
        await blobStore.put(extractedTextBlobKey, Buffer.from("extracted text"));
        const attachment = await attachmentRepo.save(
            new AttachmentMongo({
                mailboxUid: old.mailboxUid,
                folderUid: old.folderUid,
                messageUid: old.uid,
                filename: "file.txt",
                mimeType: "text/plain",
                blobKey: attachmentBlobKey,
                extractedTextBlobKey,
            }),
        );

        await job.run();

        expect(await messageRepo.findOne({ uid: old.uid } as any)).toBeFalsy();
        expect(await attachmentRepo.findOne({ uid: attachment.uid } as any)).toBeFalsy();
        expect(await blobStore.exists(bodyBlobKey)).toBe(false);
        expect(await blobStore.exists(sanitizedHtmlBlobKey)).toBe(false);
        expect(await blobStore.exists(attachmentBlobKey)).toBe(false);
        expect(await blobStore.exists(extractedTextBlobKey)).toBe(false);
    });

    it("Skips deleting a sanitizedHtmlBlobKey/extractedTextBlobKey that was never set, and still purges an attachment with no extractedTextBlobKey.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicyMongo({ uid: "retention-policy", messageRetentionDays: 30 }));
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const bodyBlobKey = `bodies/${uuid.v4()}`;
        await blobStore.put(bodyBlobKey, Buffer.from("raw"));
        const old = await createMessage({ sentDate: new Date(Date.now() - 35 * DAY_MS), bodyBlobKey, hasAttachments: true });
        const attachmentBlobKey = `attachments/${uuid.v4()}`;
        await blobStore.put(attachmentBlobKey, Buffer.from("attachment bytes"));
        const attachment = await attachmentRepo.save(
            new AttachmentMongo({
                mailboxUid: old.mailboxUid,
                folderUid: old.folderUid,
                messageUid: old.uid,
                filename: "file.txt",
                mimeType: "text/plain",
                blobKey: attachmentBlobKey,
            }),
        );

        await expect(job.run()).resolves.toBeUndefined();

        expect(await messageRepo.findOne({ uid: old.uid } as any)).toBeFalsy();
        expect(await attachmentRepo.findOne({ uid: attachment.uid } as any)).toBeFalsy();
    });

    it("Logs a warning and still purges the parent message when one of its attachments fails to purge.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicyMongo({ uid: "retention-policy", messageRetentionDays: 30 }));
        const old = await createMessage({ sentDate: new Date(Date.now() - 35 * DAY_MS), hasAttachments: true });
        await attachmentRepo.save(
            new AttachmentMongo({
                mailboxUid: old.mailboxUid,
                folderUid: old.folderUid,
                messageUid: old.uid,
                filename: "file.txt",
                mimeType: "text/plain",
                blobKey: `attachments/${uuid.v4()}-does-not-exist`,
            }),
        );

        vi.spyOn((job as any).attachmentRepo, "delete").mockRejectedValueOnce(new Error("simulated delete failure"));

        await expect(job.run()).resolves.toBeUndefined();

        expect(await messageRepo.findOne({ uid: old.uid } as any)).toBeFalsy();
    });

    it("Keeps a message within the retention window.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicyMongo({ uid: "retention-policy", messageRetentionDays: 30 }));
        const recent = await createMessage({ sentDate: new Date(Date.now() - 5 * DAY_MS) });

        await job.run();

        const found = await messageRepo.findOne({ uid: recent.uid } as any);
        expect(found).toBeTruthy();
    });

    it("Skips (does not purge) an expired message under an active legal hold, and retries it on a later run once the hold lifts.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicyMongo({ uid: "retention-policy", messageRetentionDays: 30 }));
        const old = await createMessage({ sentDate: new Date(Date.now() - 35 * DAY_MS) });
        const matter = await createMatter({ custodianMailboxUids: [old.mailboxUid] });

        await job.run();

        const stillHeld = await messageRepo.findOne({ uid: old.uid } as any);
        expect(stillHeld).toBeTruthy();
        const noAuditYet = await auditLogRepo.find({ action: AuditAction.RETENTION_PURGE_EXECUTED }).toArray();
        expect(noAuditYet.length).toBe(0);

        await matterRepo.updateOne({ uid: matter.uid } as any, { $set: { closedAt: new Date() } } as any);
        await job.run();

        const nowPurged = await messageRepo.findOne({ uid: old.uid } as any);
        expect(nowPurged).toBeFalsy();
    });

    it("Purges an AuditLogEntry older than auditLogRetentionDays and records one summary entry for the batch.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicyMongo({ uid: "retention-policy", auditLogRetentionDays: 2190 }));
        const old = await createAuditLogEntry({ dateCreated: new Date(Date.now() - 2200 * DAY_MS) });

        await job.run();

        const found = await auditLogRepo.findOne({ uid: old.uid } as any);
        expect(found).toBeFalsy();

        const remaining = await auditLogRepo.find({ action: AuditAction.RETENTION_PURGE_EXECUTED }).toArray();
        expect(remaining.length).toBe(1);
        expect(remaining[0].targetType).toBe("AuditLogEntry");
        expect(remaining[0].details).toEqual({ count: 1, maxAgeDays: 2190 });
    });

    it("Keeps an AuditLogEntry within the retention window.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicyMongo({ uid: "retention-policy", auditLogRetentionDays: 2190 }));
        const recent = await createAuditLogEntry();

        await job.run();

        const found = await auditLogRepo.findOne({ uid: recent.uid } as any);
        expect(found).toBeTruthy();
    });

    it("Skips (does not purge) an expired AuditLogEntry under an active legal hold, and retries it on a later run once the hold lifts.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicyMongo({ uid: "retention-policy", auditLogRetentionDays: 2190 }));
        const mailboxUid = uuid.v4();
        const oldDate = new Date(Date.now() - 2200 * DAY_MS);
        const old = await createAuditLogEntry({ mailboxUid, dateCreated: oldDate });
        const matter = await createMatter({
            custodianMailboxUids: [mailboxUid],
            dateRangeStart: new Date(oldDate.getTime() - DAY_MS),
            dateRangeEnd: new Date(oldDate.getTime() + DAY_MS),
        });

        await job.run();

        const stillHeld = await auditLogRepo.findOne({ uid: old.uid } as any);
        expect(stillHeld).toBeTruthy();

        await matterRepo.updateOne({ uid: matter.uid } as any, { $set: { closedAt: new Date() } } as any);
        await job.run();

        const nowPurged = await auditLogRepo.findOne({ uid: old.uid } as any);
        expect(nowPurged).toBeFalsy();
    });

    it("Purges an expired AuditLogEntry with a mailboxUid that isn't under any active hold, same as one with no mailboxUid at all.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicyMongo({ uid: "retention-policy", auditLogRetentionDays: 2190 }));
        const old = await createAuditLogEntry({ mailboxUid: uuid.v4(), dateCreated: new Date(Date.now() - 2200 * DAY_MS) });

        await job.run();

        const found = await auditLogRepo.findOne({ uid: old.uid } as any);
        expect(found).toBeFalsy();
    });

    it("Bounds how many expired messages are purged per run to the configured batch size.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicyMongo({ uid: "retention-policy", messageRetentionDays: 30 }));
        (job as any).batchSize = 2;
        const oldDate = new Date(Date.now() - 35 * DAY_MS);
        await Promise.all([createMessage({ sentDate: oldDate }), createMessage({ sentDate: oldDate }), createMessage({ sentDate: oldDate })]);

        await job.run();

        const remaining = await messageRepo.find({ sentDate: oldDate }).toArray();
        expect(remaining.length).toBe(1);
    });

    it("Logs a warning and continues purging subsequent messages when one delete throws.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicyMongo({ uid: "retention-policy", messageRetentionDays: 30 }));
        const oldDate = new Date(Date.now() - 35 * DAY_MS);
        const badMessage = await createMessage({ sentDate: oldDate });
        const goodMessage = await createMessage({ sentDate: oldDate });

        const repoUtils = (job as any).messageRepo;
        const originalDelete = repoUtils.delete.bind(repoUtils);
        vi.spyOn(repoUtils, "delete").mockImplementation(async (uid: string, opts: any) => {
            if (uid === badMessage.uid) {
                throw new Error("simulated database failure");
            }
            return originalDelete(uid, opts);
        });

        await expect(job.run()).resolves.toBeUndefined();

        const badFound = await messageRepo.findOne({ uid: badMessage.uid } as any);
        const goodFound = await messageRepo.findOne({ uid: goodMessage.uid } as any);
        expect(badFound).toBeTruthy();
        expect(goodFound).toBeFalsy();
    });

    it("Logs a warning and continues purging subsequent audit log entries when one delete throws.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicyMongo({ uid: "retention-policy", auditLogRetentionDays: 2190 }));
        const oldDate = new Date(Date.now() - 2200 * DAY_MS);
        const badEntry = await createAuditLogEntry({ dateCreated: oldDate });
        const goodEntry = await createAuditLogEntry({ dateCreated: oldDate });

        const repoUtils = (job as any).auditLogRepo;
        const originalDelete = repoUtils.delete.bind(repoUtils);
        vi.spyOn(repoUtils, "delete").mockImplementation(async (uid: string, opts: any) => {
            if (uid === badEntry.uid) {
                throw new Error("simulated database failure");
            }
            return originalDelete(uid, opts);
        });

        await expect(job.run()).resolves.toBeUndefined();

        const badFound = await auditLogRepo.findOne({ uid: badEntry.uid } as any);
        const goodFound = await auditLogRepo.findOne({ uid: goodEntry.uid } as any);
        expect(badFound).toBeTruthy();
        expect(goodFound).toBeFalsy();
    });
});
