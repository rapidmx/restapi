///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for ErasureExecutionJobMongo - see DataExportJobMongo.test.ts's/
// QuarantineRetentionJobMongo.test.ts's file headers for the full rationale (bypasses `Server`, wires a
// real ObjectFactory/ConnectionManager directly).
import { MongoMemoryServer } from "mongodb-memory-server";
import { ACLUtils, ConnectionManager, MongoConnection, MongoRepository, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../../config.js";
import { ErasureExecutionJobMongo } from "../../../src/jobs/mongo/ErasureExecutionJobMongo.js";
import { AttachmentMongo } from "../../../src/models/mongo/AttachmentMongo.js";
import { AuditLogEntryMongo } from "../../../src/models/mongo/AuditLogEntryMongo.js";
import { CalendarEventMongo } from "../../../src/models/mongo/CalendarEventMongo.js";
import { ContactMongo } from "../../../src/models/mongo/ContactMongo.js";
import { ContactListMongo } from "../../../src/models/mongo/ContactListMongo.js";
import { DataSubjectErasureRequestMongo } from "../../../src/models/mongo/DataSubjectErasureRequestMongo.js";
import { FolderMongo } from "../../../src/models/mongo/FolderMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { MatterMongo } from "../../../src/models/mongo/MatterMongo.js";
import { MessageMongo } from "../../../src/models/mongo/MessageMongo.js";
import { NoteMongo } from "../../../src/models/mongo/NoteMongo.js";
import { TaskMongo } from "../../../src/models/mongo/TaskMongo.js";
import { AuditAction, RecipientType } from "../../../src/models/types.js";
import { InMemoryBlobStore, registerTestDoubles } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("ErasureExecutionJobMongo Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: ErasureExecutionJobMongo;
    let requestRepo: MongoRepository<DataSubjectErasureRequestMongo>;
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let folderRepo: MongoRepository<FolderMongo>;
    let messageRepo: MongoRepository<MessageMongo>;
    let contactRepo: MongoRepository<ContactMongo>;
    let contactListRepo: MongoRepository<ContactListMongo>;
    let calendarEventRepo: MongoRepository<CalendarEventMongo>;
    let taskRepo: MongoRepository<TaskMongo>;
    let noteRepo: MongoRepository<NoteMongo>;
    let attachmentRepo: MongoRepository<AttachmentMongo>;
    let matterRepo: MongoRepository<MatterMongo>;
    let auditLogRepo: MongoRepository<AuditLogEntryMongo>;

    const createMailbox = async (): Promise<MailboxMongo> =>
        await mailboxRepo.save(
            new MailboxMongo({
                ownerUserUid: uuid.v4(),
                primarySmtpAddress: `${uuid.v4()}@example.com`,
                aliasAddresses: [],
                displayName: "Test Mailbox",
                timezone: "UTC",
                quotaBytes: 1_000_000_000,
                usedBytes: 0,
            }),
        );

    const createRequest = async (data: Partial<DataSubjectErasureRequestMongo>): Promise<DataSubjectErasureRequestMongo> =>
        await requestRepo.save(new DataSubjectErasureRequestMongo({ mailboxUid: uuid.v4(), requestedByUserUid: uuid.v4(), status: "approved", ...data }));

    beforeAll(async () => {
        await mongod.start();
        objectFactory = new ObjectFactory(config, logger);
        objectFactory.register(ACLUtils);
        registerTestDoubles(objectFactory);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("DataSubjectErasureRequestMongo", DataSubjectErasureRequestMongo);
        models.set("MailboxMongo", MailboxMongo);
        models.set("FolderMongo", FolderMongo);
        models.set("MessageMongo", MessageMongo);
        models.set("ContactMongo", ContactMongo);
        models.set("ContactListMongo", ContactListMongo);
        models.set("CalendarEventMongo", CalendarEventMongo);
        models.set("TaskMongo", TaskMongo);
        models.set("NoteMongo", NoteMongo);
        models.set("AttachmentMongo", AttachmentMongo);
        models.set("MatterMongo", MatterMongo);
        models.set("AuditLogEntryMongo", AuditLogEntryMongo);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        requestRepo = conn.getMongoRepository("DataSubjectErasureRequestMongo");
        mailboxRepo = conn.getMongoRepository("MailboxMongo");
        folderRepo = conn.getMongoRepository("FolderMongo");
        messageRepo = conn.getMongoRepository("MessageMongo");
        contactRepo = conn.getMongoRepository("ContactMongo");
        contactListRepo = conn.getMongoRepository("ContactListMongo");
        calendarEventRepo = conn.getMongoRepository("CalendarEventMongo");
        taskRepo = conn.getMongoRepository("TaskMongo");
        noteRepo = conn.getMongoRepository("NoteMongo");
        attachmentRepo = conn.getMongoRepository("AttachmentMongo");
        matterRepo = conn.getMongoRepository("MatterMongo");
        auditLogRepo = conn.getMongoRepository("AuditLogEntryMongo");

        job = await objectFactory.newInstance(ErasureExecutionJobMongo, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
        await mongod.stop();
    });

    beforeEach(async () => {
        for (const repo of [
            requestRepo,
            mailboxRepo,
            folderRepo,
            messageRepo,
            contactRepo,
            contactListRepo,
            calendarEventRepo,
            taskRepo,
            noteRepo,
            attachmentRepo,
            matterRepo,
            auditLogRepo,
        ]) {
            await repo.clear();
        }
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("Exposes the configured cron schedule.", () => {
        expect(job.schedule).toBe(config.get("mail:jobs:erasure_execution:schedule"));
    });

    it("start() and stop() are no-ops beyond init().", async () => {
        await expect(job.start()).resolves.toBeUndefined();
        expect(job.stop()).toBeUndefined();
    });

    it("Does nothing when there are no approved requests.", async () => {
        await expect(job.run()).resolves.toBeUndefined();
    });

    it("Skips (does not error, does not complete) a request whose mailbox is under an active legal hold, retrying it later.", async () => {
        const mailbox = await createMailbox();
        await matterRepo.save(
            new MatterMongo({
                name: "Held",
                escrowScopeId: uuid.v4(),
                custodianMailboxUids: [mailbox.uid],
                dateRangeStart: new Date("2020-01-01"),
                dateRangeEnd: new Date("2030-01-01"),
            }),
        );
        const request = await createRequest({ mailboxUid: mailbox.uid });

        await job.run();

        const stillApproved = await requestRepo.findOne({ uid: request.uid } as any);
        expect(stillApproved!.status).toBe("approved");

        const stillThere = await mailboxRepo.findOne({ uid: mailbox.uid } as any);
        expect(stillThere).toBeDefined();
    });

    it("Cascades a full erasure: every mailboxUid-scoped entity, their blobs, and the mailbox itself.", async () => {
        const mailbox = await createMailbox();
        const folder = await folderRepo.save(new FolderMongo({ mailboxUid: mailbox.uid, name: "Inbox" }));
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;

        const bodyBlobKey = `bodies/${uuid.v4()}`;
        const sanitizedHtmlBlobKey = `sanitized/${uuid.v4()}`;
        await blobStore.put(bodyBlobKey, Buffer.from("raw"));
        await blobStore.put(sanitizedHtmlBlobKey, Buffer.from("<p>html</p>"));
        const message = await messageRepo.save(
            new MessageMongo({
                mailboxUid: mailbox.uid,
                folderUid: folder.uid,
                messageId: `${uuid.v4()}@example.com`,
                subject: "Hi",
                from: { address: "alice@example.com", type: RecipientType.TO },
                recipients: [{ address: "bob@example.com", type: RecipientType.TO }],
                sentDate: new Date(),
                receivedDate: new Date(),
                bodyBlobKey,
                sanitizedHtmlBlobKey,
                flags: { read: false, flagged: false, answered: false, forwarded: false },
                references: [],
                hasAttachments: true,
            }),
        );

        const attachmentBlobKey = `attachments/${uuid.v4()}`;
        const extractedTextBlobKey = `extracted/${uuid.v4()}`;
        await blobStore.put(attachmentBlobKey, Buffer.from("attachment bytes"));
        await blobStore.put(extractedTextBlobKey, Buffer.from("extracted text"));
        await attachmentRepo.save(
            new AttachmentMongo({
                mailboxUid: mailbox.uid,
                folderUid: folder.uid,
                messageUid: message.uid,
                filename: "file.txt",
                mimeType: "text/plain",
                blobKey: attachmentBlobKey,
                extractedTextBlobKey,
            }),
        );

        const photoBlobKey = `photos/${uuid.v4()}`;
        await blobStore.put(photoBlobKey, Buffer.from("photo bytes"));
        await contactRepo.save(new ContactMongo({ mailboxUid: mailbox.uid, folderUid: folder.uid, displayName: "A Contact", photoBlobKey }));
        await contactListRepo.save(new ContactListMongo({ mailboxUid: mailbox.uid, name: "A Contact List" }));
        await calendarEventRepo.save(new CalendarEventMongo({ mailboxUid: mailbox.uid, folderUid: folder.uid, title: "An Event" }));
        await taskRepo.save(new TaskMongo({ mailboxUid: mailbox.uid, folderUid: folder.uid, title: "A Task" }));
        await noteRepo.save(new NoteMongo({ mailboxUid: mailbox.uid, folderUid: folder.uid, title: "A Note", body: "Note body" }));

        const request = await createRequest({ mailboxUid: mailbox.uid });

        await job.run();

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        expect(updated!.status).toBe("completed");
        // folder, message, attachment, contact, contactList, calendarEvent, task, note, mailbox = 9
        expect(updated!.purgedCount).toBe(9);

        expect(await mailboxRepo.findOne({ uid: mailbox.uid } as any)).toBeNull();
        expect(await folderRepo.findOne({ uid: folder.uid } as any)).toBeNull();
        expect(await messageRepo.findOne({ uid: message.uid } as any)).toBeNull();
        expect((await contactRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(0);
        expect((await contactListRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(0);
        expect((await calendarEventRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(0);
        expect((await taskRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(0);
        expect((await noteRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(0);
        expect((await attachmentRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(0);

        expect(await blobStore.exists(bodyBlobKey)).toBe(false);
        expect(await blobStore.exists(sanitizedHtmlBlobKey)).toBe(false);
        expect(await blobStore.exists(attachmentBlobKey)).toBe(false);
        expect(await blobStore.exists(extractedTextBlobKey)).toBe(false);
        expect(await blobStore.exists(photoBlobKey)).toBe(false);

        const entries = await auditLogRepo.find({ action: AuditAction.ERASURE_REQUEST_COMPLETED }).toArray();
        expect(entries).toHaveLength(1);
    });

    it("Skips deleting a sanitizedHtmlBlobKey/extractedTextBlobKey that was never set.", async () => {
        const mailbox = await createMailbox();
        const folder = await folderRepo.save(new FolderMongo({ mailboxUid: mailbox.uid, name: "Inbox" }));
        const bodyBlobKey = `bodies/${uuid.v4()}`;
        const message = await messageRepo.save(
            new MessageMongo({
                mailboxUid: mailbox.uid,
                folderUid: folder.uid,
                messageId: `${uuid.v4()}@example.com`,
                subject: "Plain text only",
                from: { address: "alice@example.com", type: RecipientType.TO },
                recipients: [],
                sentDate: new Date(),
                receivedDate: new Date(),
                bodyBlobKey,
                flags: { read: false, flagged: false, answered: false, forwarded: false },
                references: [],
                hasAttachments: true,
            }),
        );
        const attachmentBlobKey = `attachments/${uuid.v4()}`;
        await attachmentRepo.save(
            new AttachmentMongo({
                mailboxUid: mailbox.uid,
                folderUid: folder.uid,
                messageUid: message.uid,
                filename: "file.txt",
                mimeType: "text/plain",
                blobKey: attachmentBlobKey,
            }),
        );
        const request = await createRequest({ mailboxUid: mailbox.uid });

        await expect(job.run()).resolves.toBeUndefined();

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        expect(updated!.status).toBe("completed");
    });

    it("Does not touch another mailbox's content.", async () => {
        const mailbox = await createMailbox();
        const otherMailbox = await createMailbox();
        await contactRepo.save(new ContactMongo({ mailboxUid: mailbox.uid, folderUid: uuid.v4(), displayName: "Mine" }));
        await contactRepo.save(new ContactMongo({ mailboxUid: otherMailbox.uid, folderUid: uuid.v4(), displayName: "Not Mine" }));
        const request = await createRequest({ mailboxUid: mailbox.uid });

        await job.run();

        expect(await requestRepo.findOne({ uid: request.uid } as any).then((r) => r!.status)).toBe("completed");
        expect((await contactRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(0);
        expect((await contactRepo.find({ mailboxUid: otherMailbox.uid }).toArray()).length).toBe(1);
        expect(await mailboxRepo.findOne({ uid: otherMailbox.uid } as any)).toBeDefined();
    });

    it("Marks completed even when the mailbox row itself no longer exists, having still purged its children.", async () => {
        const mailboxUid = uuid.v4();
        await contactRepo.save(new ContactMongo({ mailboxUid, folderUid: uuid.v4(), displayName: "Orphaned" }));
        const request = await createRequest({ mailboxUid });

        await job.run();

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        expect(updated!.status).toBe("completed");
        expect(updated!.purgedCount).toBe(1);
    });

    it("Logs a warning and continues the cascade when one row's own delete throws.", async () => {
        const mailbox = await createMailbox();
        await contactRepo.save(new ContactMongo({ mailboxUid: mailbox.uid, folderUid: uuid.v4(), displayName: "A" }));
        await contactRepo.save(new ContactMongo({ mailboxUid: mailbox.uid, folderUid: uuid.v4(), displayName: "B" }));
        const request = await createRequest({ mailboxUid: mailbox.uid });

        const originalNewInstance = objectFactory.newInstance.bind(objectFactory);
        let contactRepoUtilsCreated = 0;
        vi.spyOn(objectFactory, "newInstance").mockImplementation(async (...args: any[]) => {
            const instance: any = await originalNewInstance(...args);
            if (args[1]?.name === "ContactMongo" && contactRepoUtilsCreated++ === 0) {
                vi.spyOn(instance, "delete").mockRejectedValueOnce(new Error("simulated delete failure"));
            }
            return instance;
        });

        await job.run();

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        expect(updated!.status).toBe("completed");
        // One contact failed to delete and is still there; everything else (including the mailbox) is gone.
        expect((await contactRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(1);
    });

    it("Logs an error when the mailbox's own purge fails, still marking the request completed.", async () => {
        const mailbox = await createMailbox();
        const request = await createRequest({ mailboxUid: mailbox.uid });

        vi.spyOn((job as any).mailboxRepo, "delete").mockRejectedValueOnce(new Error("simulated mailbox delete failure"));

        await job.run();

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        expect(updated!.status).toBe("completed");
        expect(await mailboxRepo.findOne({ uid: mailbox.uid } as any)).toBeDefined();
    });

    it("Logs an error but doesn't crash the run when processing one request throws unexpectedly.", async () => {
        const request = await createRequest({ mailboxUid: uuid.v4() });
        vi.spyOn((job as any).mailboxRepo, "findOne").mockRejectedValueOnce(new Error("simulated lookup failure"));

        await expect(job.run()).resolves.toBeUndefined();

        const stillApproved = await requestRepo.findOne({ uid: request.uid } as any);
        expect(stillApproved!.status).toBe("approved");
    });

    it("Does nothing when the repos are not yet initialized.", async () => {
        const original = (job as any).requestRepo;
        (job as any).requestRepo = undefined;
        try {
            await expect(job.run()).resolves.toBeUndefined();
        } finally {
            (job as any).requestRepo = original;
        }
    });
});
