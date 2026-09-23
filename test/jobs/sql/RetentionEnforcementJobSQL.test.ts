///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for RetentionEnforcementJobSQL - see
// QuarantineRetentionJobSQL.test.ts's file header for the full rationale (bypasses `Server`, wires a real
// ObjectFactory/ConnectionManager directly).
import { ACLUtils, AccessControlListSQL, ConnectionManager, NotificationUtils, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { In, Repository } from "typeorm";
import config from "../../config.sql.js";
import { RetentionEnforcementJobSQL } from "../../../src/jobs/sql/RetentionEnforcementJobSQL.js";
import { AttachmentSQL } from "../../../src/models/sql/AttachmentSQL.js";
import { AuditLogEntrySQL } from "../../../src/models/sql/AuditLogEntrySQL.js";
import { MatterSQL } from "../../../src/models/sql/MatterSQL.js";
import { IngestQueueEntrySQL } from "../../../src/models/sql/IngestQueueEntrySQL.js";
import { QuarantineEntrySQL } from "../../../src/models/sql/QuarantineEntrySQL.js";
import { FolderSQL } from "../../../src/models/sql/FolderSQL.js";
import { MessageSQL } from "../../../src/models/sql/MessageSQL.js";
import { RetentionPolicySQL } from "../../../src/models/sql/RetentionPolicySQL.js";
import { AuditAction, AuditLogEntry, RecipientType } from "../../../src/models/types.js";
import { InMemoryBlobStore, registerTestDoubles } from "../../testDoubles.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("RetentionEnforcementJobSQL Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: RetentionEnforcementJobSQL;
    let retentionPolicyRepo: Repository<RetentionPolicySQL>;
    let messageRepo: Repository<MessageSQL>;
    let auditLogRepo: Repository<AuditLogEntrySQL>;
    let matterRepo: Repository<MatterSQL>;
    let attachmentRepo: Repository<AttachmentSQL>;
    let folderRepo: Repository<FolderSQL>;

    const createMessage = async (data?: Partial<MessageSQL>): Promise<MessageSQL> => {
        const obj = new MessageSQL({
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

    const createAuditLogEntry = async (data?: Partial<AuditLogEntry>): Promise<AuditLogEntrySQL> => {
        const obj = new AuditLogEntrySQL({
            action: AuditAction.MAILBOX_CREATE,
            targetType: "Mailbox",
            targetUid: uuid.v4(),
            ...data,
        });
        return await auditLogRepo.save(obj);
    };

    const createMatter = async (data?: Partial<MatterSQL>): Promise<MatterSQL> => {
        const obj = new MatterSQL({
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
        objectFactory = new ObjectFactory(config, logger);
        objectFactory.register(ACLUtils);
        registerTestDoubles(objectFactory);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("AccessControlListSQL", AccessControlListSQL);
        models.set("RetentionPolicySQL", RetentionPolicySQL);
        models.set("MessageSQL", MessageSQL);
        models.set("FolderSQL", FolderSQL);
        models.set("AuditLogEntrySQL", AuditLogEntrySQL);
        models.set("MatterSQL", MatterSQL);
        models.set("AttachmentSQL", AttachmentSQL);
        models.set("QuarantineEntrySQL", QuarantineEntrySQL);
        models.set("IngestQueueEntrySQL", IngestQueueEntrySQL);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        retentionPolicyRepo = conn.getRepository(RetentionPolicySQL);
        messageRepo = conn.getRepository(MessageSQL);
        auditLogRepo = conn.getRepository(AuditLogEntrySQL);
        matterRepo = conn.getRepository(MatterSQL);
        attachmentRepo = conn.getRepository(AttachmentSQL);
        folderRepo = conn.getRepository(FolderSQL);

        job = await objectFactory.newInstance(RetentionEnforcementJobSQL, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await retentionPolicyRepo.clear();
        await messageRepo.clear();
        await auditLogRepo.clear();
        await matterRepo.clear();
        await attachmentRepo.clear();
        await folderRepo.clear();
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

        const found = await messageRepo.findOne({ where: { uid: message.uid } });
        expect(found).not.toBeNull();
    });

    it("Does nothing when a policy row exists but neither field is configured.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy" }));
        const message = await createMessage({ sentDate: new Date(Date.now() - 3650 * DAY_MS) });

        await expect(job.run()).resolves.toBeUndefined();

        const found = await messageRepo.findOne({ where: { uid: message.uid } });
        expect(found).not.toBeNull();
    });

    it("Does nothing when both fields were cleared to null (no automatic purge).", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", messageRetentionDays: null as any, auditLogRetentionDays: null as any }));
        const message = await createMessage({ sentDate: new Date(Date.now() - 3650 * DAY_MS) });

        await expect(job.run()).resolves.toBeUndefined();

        expect(await messageRepo.findOne({ where: { uid: message.uid } })).not.toBeNull();
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
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", messageRetentionDays: 30 }));
        const old = await createMessage({ sentDate: new Date(Date.now() - 35 * DAY_MS) });

        await job.run();

        const found = await messageRepo.findOne({ where: { uid: old.uid } });
        expect(found).toBeNull();

        const entries = await auditLogRepo.find({ where: { action: AuditAction.RETENTION_PURGE_EXECUTED } });
        expect(entries.length).toBe(1);
        expect(entries[0].targetType).toBe("Message");
        expect(entries[0].details).toEqual({ count: 1, maxAgeDays: 30 });
    });

    it("Recomputes and publishes the counts of every folder a purge took a live message out of, once per folder - a soft-deleted one was already out of the count.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", messageRetentionDays: 30 }));
        const mailboxUid = uuid.v4();
        const folder = await folderRepo.save(new FolderSQL({ mailboxUid, name: "Inbox", unreadCount: 9, totalCount: 9 }));
        const untouched = await folderRepo.save(new FolderSQL({ mailboxUid, name: "Other", unreadCount: 5, totalCount: 5 }));
        const old = new Date(Date.now() - 35 * DAY_MS);
        await createMessage({ mailboxUid, folderUid: folder.uid, sentDate: old });
        await createMessage({ mailboxUid, folderUid: folder.uid, sentDate: old, flags: { read: true, flagged: false, answered: false, forwarded: false } });
        const softDeleted = await createMessage({ mailboxUid, folderUid: untouched.uid, sentDate: old });
        await messageRepo.update({ uid: softDeleted.uid }, { deleted: true });
        await createMessage({ mailboxUid, folderUid: folder.uid, sentDate: new Date() });
        await createMessage({ mailboxUid, folderUid: untouched.uid, sentDate: new Date() });
        const sendMessageSpy = vi.spyOn(NotificationUtils.prototype, "sendMessage");

        await job.run();

        expect(sendMessageSpy.mock.calls.filter(([, type, action]) => /^Folder/.test(String(type)) && action === "update")).toEqual([
            [[folder.uid, mailboxUid], "FolderSQL", "update", { uid: folder.uid, mailboxUid, unreadCount: 1, totalCount: 1 }],
        ]);
        expect(await folderRepo.findOne({ where: { uid: folder.uid } })).toMatchObject({ unreadCount: 1, totalCount: 1 });
        // Not touched by the purge of a soft-deleted row: neither published nor rewritten.
        expect(await folderRepo.findOne({ where: { uid: untouched.uid } })).toMatchObject({ unreadCount: 5, totalCount: 5 });
    });

    it("Purging an expired message also purges every Attachment referencing it, plus both entities' own BlobStore content - PHI/PII a retention policy asserts is gone must not survive as an orphaned, independently-downloadable row or blob.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", messageRetentionDays: 30 }));
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
            new AttachmentSQL({
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

        expect(await messageRepo.findOne({ where: { uid: old.uid } })).toBeNull();
        expect(await attachmentRepo.findOne({ where: { uid: attachment.uid } })).toBeNull();
        expect(await blobStore.exists(bodyBlobKey)).toBe(false);
        expect(await blobStore.exists(sanitizedHtmlBlobKey)).toBe(false);
        expect(await blobStore.exists(attachmentBlobKey)).toBe(false);
        expect(await blobStore.exists(extractedTextBlobKey)).toBe(false);
    });

    it("Skips deleting a sanitizedHtmlBlobKey/extractedTextBlobKey that was never set, and still purges an attachment with no extractedTextBlobKey.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", messageRetentionDays: 30 }));
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const bodyBlobKey = `bodies/${uuid.v4()}`;
        await blobStore.put(bodyBlobKey, Buffer.from("raw"));
        const old = await createMessage({ sentDate: new Date(Date.now() - 35 * DAY_MS), bodyBlobKey, hasAttachments: true });
        const attachmentBlobKey = `attachments/${uuid.v4()}`;
        await blobStore.put(attachmentBlobKey, Buffer.from("attachment bytes"));
        const attachment = await attachmentRepo.save(
            new AttachmentSQL({
                mailboxUid: old.mailboxUid,
                folderUid: old.folderUid,
                messageUid: old.uid,
                filename: "file.txt",
                mimeType: "text/plain",
                blobKey: attachmentBlobKey,
            }),
        );

        await expect(job.run()).resolves.toBeUndefined();

        expect(await messageRepo.findOne({ where: { uid: old.uid } })).toBeNull();
        expect(await attachmentRepo.findOne({ where: { uid: attachment.uid } })).toBeNull();
    });

    it("Keeps the parent message (retrying it next run) when one of its attachments fails to purge, instead of orphaning the attachment.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", messageRetentionDays: 30 }));
        const old = await createMessage({ sentDate: new Date(Date.now() - 35 * DAY_MS), hasAttachments: true });
        const attachment = await attachmentRepo.save(
            new AttachmentSQL({
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

        expect(await messageRepo.findOne({ where: { uid: old.uid } })).not.toBeNull();
        expect(await attachmentRepo.findOne({ where: { uid: attachment.uid } })).not.toBeNull();

        await job.run();

        expect(await messageRepo.findOne({ where: { uid: old.uid } })).toBeNull();
        expect(await attachmentRepo.findOne({ where: { uid: attachment.uid } })).toBeNull();
    });

    it("Keeps the attachment and its message when deleting the attachment's blob fails, so the blob is retried rather than orphaned.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", messageRetentionDays: 30 }));
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const attachmentBlobKey = `attachments/${uuid.v4()}`;
        await blobStore.put(attachmentBlobKey, Buffer.from("attachment"));
        const old = await createMessage({ sentDate: new Date(Date.now() - 35 * DAY_MS), hasAttachments: true });
        const attachment = await attachmentRepo.save(
            new AttachmentSQL({ mailboxUid: old.mailboxUid, folderUid: old.folderUid, messageUid: old.uid, filename: "a.txt", mimeType: "text/plain", blobKey: attachmentBlobKey }),
        );
        vi.spyOn(blobStore, "delete").mockRejectedValueOnce(new Error("simulated blob store failure"));

        await job.run();

        expect(await attachmentRepo.findOne({ where: { uid: attachment.uid } })).not.toBeNull();
        expect(await messageRepo.findOne({ where: { uid: old.uid } })).not.toBeNull();
        expect(await blobStore.exists(attachmentBlobKey)).toBe(true);

        await job.run();

        expect(await attachmentRepo.findOne({ where: { uid: attachment.uid } })).toBeNull();
        expect(await messageRepo.findOne({ where: { uid: old.uid } })).toBeNull();
        expect(await blobStore.exists(attachmentBlobKey)).toBe(false);
    });

    it("Purges an expired soft-deleted message too, with its blob, and removes purged messages' search documents.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", messageRetentionDays: 30 }));
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const bodyBlobKey = `bodies/${uuid.v4()}`;
        await blobStore.put(bodyBlobKey, Buffer.from("raw"));
        const softDeleted = await createMessage({ sentDate: new Date(Date.now() - 35 * DAY_MS), bodyBlobKey });
        const old = await createMessage({ sentDate: new Date(Date.now() - 36 * DAY_MS) });
        const recentSoftDeleted = await createMessage({ sentDate: new Date(Date.now() - 5 * DAY_MS) });
        await messageRepo.update({ uid: softDeleted.uid }, { deleted: true });
        await messageRepo.update({ uid: recentSoftDeleted.uid }, { deleted: true });
        const searchProvider: any = objectFactory.getInstance("SearchProvider");
        const removeSpy = vi.spyOn(searchProvider, "remove");

        await job.run();

        expect(await messageRepo.findOne({ where: { uid: softDeleted.uid } })).toBeNull();
        expect(await messageRepo.findOne({ where: { uid: old.uid } })).toBeNull();
        expect(await messageRepo.findOne({ where: { uid: recentSoftDeleted.uid } })).not.toBeNull();
        expect(await blobStore.exists(bodyBlobKey)).toBe(false);
        expect(removeSpy.mock.calls.map((call) => `${call[0]}:${call[1]}`).sort()).toEqual([`message:${softDeleted.uid}`, `message:${old.uid}`].sort());
        const entries = await auditLogRepo.find({ where: { action: AuditAction.RETENTION_PURGE_EXECUTED } });
        expect(entries[0].details).toEqual({ count: 2, maxAgeDays: 30 });
    });

    it("Keeps an expired message's body and attachment blobs while another mailbox's copy still references them.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", messageRetentionDays: 30 }));
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const bodyBlobKey = `ingest/${uuid.v4()}`;
        const attachmentBlobKey = `attachments/${uuid.v4()}`;
        await blobStore.put(bodyBlobKey, Buffer.from("raw"));
        await blobStore.put(attachmentBlobKey, Buffer.from("attachment"));
        const old = await createMessage({ bodyBlobKey, sentDate: new Date(Date.now() - 35 * DAY_MS) });
        const recent = await createMessage({ bodyBlobKey });
        for (const message of [old, recent]) {
            await attachmentRepo.save(
                new AttachmentSQL({ mailboxUid: message.mailboxUid, folderUid: message.folderUid, messageUid: message.uid, filename: "a.txt", mimeType: "text/plain", blobKey: attachmentBlobKey }),
            );
        }

        await job.run();

        expect(await messageRepo.findOne({ where: { uid: old.uid } })).toBeNull();
        expect(await blobStore.exists(bodyBlobKey)).toBe(true);
        expect(await blobStore.exists(attachmentBlobKey)).toBe(true);
    });

    it("Purges later expired messages in the same run when earlier ones are held or fail to purge, instead of re-reading the same stuck rows.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", messageRetentionDays: 30 }));
        (job as any).batchSize = 1;
        const heldMailboxUid = uuid.v4();
        await createMatter({ custodianMailboxUids: [heldMailboxUid] });
        const held1 = await createMessage({ mailboxUid: heldMailboxUid, sentDate: new Date(Date.now() - 50 * DAY_MS) });
        const held2 = await createMessage({ mailboxUid: heldMailboxUid, sentDate: new Date(Date.now() - 49 * DAY_MS) });
        const failing = await createMessage({ sentDate: new Date(Date.now() - 45 * DAY_MS) });
        const purgeable = await createMessage({ sentDate: new Date(Date.now() - 40 * DAY_MS) });
        const repo = (job as any).messageRepo;
        const originalDelete = repo.delete.bind(repo);
        vi.spyOn(repo, "delete").mockImplementation(async (uid: any, options: any) => {
            if (uid === failing.uid) {
                throw new Error("simulated database failure");
            }
            return await originalDelete(uid, options);
        });

        await job.run();

        expect(await messageRepo.findOne({ where: { uid: held1.uid } })).not.toBeNull();
        expect(await messageRepo.findOne({ where: { uid: held2.uid } })).not.toBeNull();
        expect(await messageRepo.findOne({ where: { uid: failing.uid } })).not.toBeNull();
        expect(await messageRepo.findOne({ where: { uid: purgeable.uid } })).toBeNull();
    });

    it("Purges a later expired AuditLogEntry in the same run when an earlier one is held.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", auditLogRetentionDays: 2190 }));
        (job as any).batchSize = 1;
        const heldMailboxUid = uuid.v4();
        await createMatter({ custodianMailboxUids: [heldMailboxUid], dateRangeStart: new Date("2000-01-01"), dateRangeEnd: new Date("2030-01-01") });
        const held = await createAuditLogEntry({ mailboxUid: heldMailboxUid, dateCreated: new Date(Date.now() - 2300 * DAY_MS) });
        const orgWide = await createAuditLogEntry({ dateCreated: new Date(Date.now() - 2200 * DAY_MS) });

        await job.run();

        expect(await auditLogRepo.findOne({ where: { uid: held.uid } })).not.toBeNull();
        expect(await auditLogRepo.findOne({ where: { uid: orgWide.uid } })).toBeNull();
    });

    describe("draft bodies kept for a legal hold (round 6)", () => {
        const putBodies = async (...keys: string[]) => {
            const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
            for (const key of keys) {
                await blobStore.put(key, Buffer.from(`content of ${key}`));
            }
            return blobStore;
        };
        const retained = async (uid: string): Promise<string[] | null> => (await messageRepo.findOne({ where: { uid } }))?.retainedBodyBlobKeys ?? null;

        it("releases them once no open Matter holds the mailbox - with no retention policy at all - keeping shared, current and non-body blobs", async () => {
            const [current, old1, shared, notABody] = [`bodies/${uuid.v4()}`, `bodies/${uuid.v4()}`, `bodies/${uuid.v4()}`, `attachments/${uuid.v4()}`];
            const blobStore = await putBodies(current, old1, shared, notABody);
            const draft = await createMessage({ bodyBlobKey: current, retainedBodyBlobKeys: [old1, shared, notABody, current] });
            const softDeleted = await createMessage({ retainedBodyBlobKeys: [`bodies/${uuid.v4()}`] });
            await messageRepo.update({ uid: softDeleted.uid }, { deleted: true });
            // Another row still uses `shared` as its body.
            await createMessage({ bodyBlobKey: shared });
            const untouched = await createMessage();
            const matter = await createMatter({ custodianMailboxUids: [draft.mailboxUid, softDeleted.mailboxUid] });

            await job.run();
            expect(await retained(draft.uid)).toEqual([old1, shared, notABody, current]);
            expect(await blobStore.exists(old1)).toBe(true);

            await matterRepo.update({ uid: matter.uid }, { closedAt: new Date() });
            await job.run();

            expect(await retained(draft.uid)).toBeNull();
            expect((await messageRepo.findOne({ where: { uid: draft.uid } }))?.bodyBlobKey).toBe(current);
            expect(await blobStore.exists(old1)).toBe(false);
            expect(await blobStore.exists(shared)).toBe(true);
            expect(await blobStore.exists(notABody)).toBe(true);
            expect(await blobStore.exists(current)).toBe(true);
            expect(await retained(softDeleted.uid)).toBeNull();
            expect((await messageRepo.findOne({ where: { uid: untouched.uid } }))?.version).toBe(untouched.version);
        });

        it("deletes them with a purged message, releases at most batch_size messages per run, and keeps the field when releasing fails", async () => {
            await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", messageRetentionDays: 30 }));
            const purgedBody = `bodies/${uuid.v4()}`;
            const blobStore = await putBodies(purgedBody);
            const expired = await createMessage({ sentDate: new Date(Date.now() - 35 * DAY_MS), retainedBodyBlobKeys: [purgedBody] });
            await job.run();
            expect(await messageRepo.findOne({ where: { uid: expired.uid } })).toBeNull();
            expect(await blobStore.exists(purgedBody)).toBe(false);

            await retentionPolicyRepo.clear();
            const rows = [
                await createMessage({ retainedBodyBlobKeys: [`bodies/${uuid.v4()}`] }),
                await createMessage({ retainedBodyBlobKeys: [`bodies/${uuid.v4()}`] }),
                await createMessage({ retainedBodyBlobKeys: [`bodies/${uuid.v4()}`] }),
            ];
            const stillRetained = async (): Promise<number> => (await Promise.all(rows.map((row) => retained(row.uid)))).filter((keys) => keys !== null).length;
            (job as any).batchSize = 1;
            const update = vi.spyOn((job as any).messageRepo, "update").mockRejectedValueOnce(new Error("simulated conflict"));
            const warn = vi.spyOn((job as any).logger, "warn");
            await job.run();
            expect(warn).toHaveBeenCalledWith(expect.stringMatching(/failed to release retained draft bodies of message/));
            update.mockRestore();
            expect(await stillRetained()).toBe(2);
            await job.run();
            expect(await stillRetained()).toBe(1);
            await job.run();
            expect(await stillRetained()).toBe(0);
        });
    });

    it("Keeps a message within the retention window.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", messageRetentionDays: 30 }));
        const recent = await createMessage({ sentDate: new Date(Date.now() - 5 * DAY_MS) });

        await job.run();

        const found = await messageRepo.findOne({ where: { uid: recent.uid } });
        expect(found).not.toBeNull();
    });

    it("Skips (does not purge) an expired message under an active legal hold, and retries it on a later run once the hold lifts.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", messageRetentionDays: 30 }));
        const old = await createMessage({ sentDate: new Date(Date.now() - 35 * DAY_MS) });
        const matter = await createMatter({ custodianMailboxUids: [old.mailboxUid] });

        await job.run();

        const stillHeld = await messageRepo.findOne({ where: { uid: old.uid } });
        expect(stillHeld).not.toBeNull();
        const noAuditYet = await auditLogRepo.find({ where: { action: AuditAction.RETENTION_PURGE_EXECUTED } });
        expect(noAuditYet.length).toBe(0);

        await matterRepo.update({ uid: matter.uid }, { closedAt: new Date() });
        await job.run();

        const nowPurged = await messageRepo.findOne({ where: { uid: old.uid } });
        expect(nowPurged).toBeNull();
    });

    it("Purges an AuditLogEntry older than auditLogRetentionDays and records one summary entry for the batch.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", auditLogRetentionDays: 2190 }));
        const old = await createAuditLogEntry({ dateCreated: new Date(Date.now() - 2200 * DAY_MS) });

        await job.run();

        const found = await auditLogRepo.findOne({ where: { uid: old.uid } });
        expect(found).toBeNull();

        // The summary entry this same run recorded is itself brand new, so only it remains.
        const remaining = await auditLogRepo.find({ where: { action: AuditAction.RETENTION_PURGE_EXECUTED } });
        expect(remaining.length).toBe(1);
        expect(remaining[0].targetType).toBe("AuditLogEntry");
        expect(remaining[0].details).toEqual({ count: 1, maxAgeDays: 2190 });
    });

    it("Keeps an AuditLogEntry within the retention window.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", auditLogRetentionDays: 2190 }));
        const recent = await createAuditLogEntry();

        await job.run();

        const found = await auditLogRepo.findOne({ where: { uid: recent.uid } });
        expect(found).not.toBeNull();
    });

    it("Skips (does not purge) an expired AuditLogEntry under an active legal hold, and retries it on a later run once the hold lifts.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", auditLogRetentionDays: 2190 }));
        const mailboxUid = uuid.v4();
        const oldDate = new Date(Date.now() - 2200 * DAY_MS);
        const old = await createAuditLogEntry({ mailboxUid, dateCreated: oldDate });
        const matter = await createMatter({
            custodianMailboxUids: [mailboxUid],
            dateRangeStart: new Date(oldDate.getTime() - DAY_MS),
            dateRangeEnd: new Date(oldDate.getTime() + DAY_MS),
        });

        await job.run();

        const stillHeld = await auditLogRepo.findOne({ where: { uid: old.uid } });
        expect(stillHeld).not.toBeNull();

        await matterRepo.update({ uid: matter.uid }, { closedAt: new Date() });
        await job.run();

        const nowPurged = await auditLogRepo.findOne({ where: { uid: old.uid } });
        expect(nowPurged).toBeNull();
    });

    it("Purges an expired AuditLogEntry with a mailboxUid that isn't under any active hold, same as one with no mailboxUid at all.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", auditLogRetentionDays: 2190 }));
        const old = await createAuditLogEntry({ mailboxUid: uuid.v4(), dateCreated: new Date(Date.now() - 2200 * DAY_MS) });

        await job.run();

        const found = await auditLogRepo.findOne({ where: { uid: old.uid } });
        expect(found).toBeNull();
    });

    it("Bounds how many expired messages are purged per run to the configured batch size.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", messageRetentionDays: 30 }));
        (job as any).batchSize = 2;
        const oldDate = new Date(Date.now() - 35 * DAY_MS);
        await Promise.all([createMessage({ sentDate: oldDate }), createMessage({ sentDate: oldDate }), createMessage({ sentDate: oldDate })]);

        await job.run();

        const remaining = await messageRepo.find({ where: { sentDate: oldDate } });
        expect(remaining.length).toBe(1);
    });

    it("Does not skip a fresh row when an earlier row's delete actually committed but the call itself reported failure (keyset pagination on uid has no offset/skip-count reconciliation to get wrong).", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", messageRetentionDays: 30 }));
        (job as any).batchSize = 3;
        const messages: MessageSQL[] = [];
        for (let i = 0; i < 6; i++) {
            // Explicit, lexically-ordered uids: `purgeSortedBatches()` pages by `uid` ASC, so this pins which
            // rows land on which page instead of depending on whatever uid a real backend would assign.
            messages.push(await createMessage({ uid: `msg-${i}`, sentDate: new Date(Date.now() - (60 - i) * DAY_MS) }));
        }
        const repoUtils = (job as any).messageRepo;
        const originalDelete = repoUtils.delete.bind(repoUtils);
        vi.spyOn(repoUtils, "delete").mockImplementation(async (uid: any, opts: any) => {
            const result = await originalDelete(uid, opts);
            if (uid === messages[0].uid) {
                // The delete committed, but the call still reported failure (e.g. a timeout after the write).
                throw new Error("simulated post-commit failure");
            }
            return result;
        });

        await job.run();

        // Page 0 = [msg-0, msg-1, msg-2]: msg-0 "fails" (really gone, but not counted as purged), msg-1 and
        // msg-2 purge (2 of the 3-row budget used). The cursor advances to msg-2 regardless of msg-0's
        // reported failure, so page 1 queries `uid > msg-2` = [msg-3, msg-4, msg-5] with nothing sliced away
        // as a phantom skip - msg-3 purges (budget reached) and the run stops there, never silently skipping
        // msg-3 the way offset pagination used to.
        const remaining = (await messageRepo.find({ where: { uid: In(messages.map((m) => m.uid)) } })).map((m) => m.uid);
        expect(remaining.sort()).toEqual([messages[4].uid, messages[5].uid].sort());
    });

    it("Logs a warning and continues purging subsequent messages when one delete throws.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", messageRetentionDays: 30 }));
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

        const badFound = await messageRepo.findOne({ where: { uid: badMessage.uid } });
        const goodFound = await messageRepo.findOne({ where: { uid: goodMessage.uid } });
        expect(badFound).not.toBeNull();
        expect(goodFound).toBeNull();
    });

    it("Logs a warning and continues purging subsequent audit log entries when one delete throws.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", auditLogRetentionDays: 2190 }));
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

        const badFound = await auditLogRepo.findOne({ where: { uid: badEntry.uid } });
        const goodFound = await auditLogRepo.findOne({ where: { uid: goodEntry.uid } });
        expect(badFound).not.toBeNull();
        expect(goodFound).toBeNull();
    });
});
