///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for DataExportJobMongo - see QuarantineRetentionJobMongo.test.ts's
// file header for the full rationale (bypasses `Server`, wires a real ObjectFactory/ConnectionManager
// directly).
import { MongoMemoryServer } from "mongodb-memory-server";
import { ACLUtils, ConnectionManager, MongoConnection, MongoRepository, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../../config.js";
import { DataExportJobMongo } from "../../../src/jobs/mongo/DataExportJobMongo.js";
import { AttachmentMongo } from "../../../src/models/mongo/AttachmentMongo.js";
import { AuditLogEntryMongo } from "../../../src/models/mongo/AuditLogEntryMongo.js";
import { CalendarEventMongo } from "../../../src/models/mongo/CalendarEventMongo.js";
import { ContactMongo } from "../../../src/models/mongo/ContactMongo.js";
import { ContactListMongo } from "../../../src/models/mongo/ContactListMongo.js";
import { DataExportRequestMongo } from "../../../src/models/mongo/DataExportRequestMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { MessageMongo } from "../../../src/models/mongo/MessageMongo.js";
import { NoteMongo } from "../../../src/models/mongo/NoteMongo.js";
import { TaskMongo } from "../../../src/models/mongo/TaskMongo.js";
import { AuditAction, RecipientType } from "../../../src/models/types.js";
import { InMemoryBlobStore, registerTestDoubles } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("DataExportJobMongo Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: DataExportJobMongo;
    let requestRepo: MongoRepository<DataExportRequestMongo>;
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let messageRepo: MongoRepository<MessageMongo>;
    let contactRepo: MongoRepository<ContactMongo>;
    let contactListRepo: MongoRepository<ContactListMongo>;
    let calendarEventRepo: MongoRepository<CalendarEventMongo>;
    let taskRepo: MongoRepository<TaskMongo>;
    let noteRepo: MongoRepository<NoteMongo>;
    let attachmentRepo: MongoRepository<AttachmentMongo>;
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

    const createRequest = async (data: Partial<DataExportRequestMongo>): Promise<DataExportRequestMongo> =>
        await requestRepo.save(
            new DataExportRequestMongo({ mailboxUid: uuid.v4(), requestedByUserUid: uuid.v4(), format: "json", status: "pending", ...data }),
        );

    beforeAll(async () => {
        await mongod.start();
        objectFactory = new ObjectFactory(config, logger);
        objectFactory.register(ACLUtils);
        registerTestDoubles(objectFactory);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("DataExportRequestMongo", DataExportRequestMongo);
        models.set("MailboxMongo", MailboxMongo);
        models.set("MessageMongo", MessageMongo);
        models.set("ContactMongo", ContactMongo);
        models.set("ContactListMongo", ContactListMongo);
        models.set("CalendarEventMongo", CalendarEventMongo);
        models.set("TaskMongo", TaskMongo);
        models.set("NoteMongo", NoteMongo);
        models.set("AttachmentMongo", AttachmentMongo);
        models.set("AuditLogEntryMongo", AuditLogEntryMongo);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        requestRepo = conn.getMongoRepository("DataExportRequestMongo");
        mailboxRepo = conn.getMongoRepository("MailboxMongo");
        messageRepo = conn.getMongoRepository("MessageMongo");
        contactRepo = conn.getMongoRepository("ContactMongo");
        contactListRepo = conn.getMongoRepository("ContactListMongo");
        calendarEventRepo = conn.getMongoRepository("CalendarEventMongo");
        taskRepo = conn.getMongoRepository("TaskMongo");
        noteRepo = conn.getMongoRepository("NoteMongo");
        attachmentRepo = conn.getMongoRepository("AttachmentMongo");
        auditLogRepo = conn.getMongoRepository("AuditLogEntryMongo");

        job = await objectFactory.newInstance(DataExportJobMongo, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
        await mongod.stop();
    });

    beforeEach(async () => {
        for (const repo of [
            requestRepo,
            mailboxRepo,
            messageRepo,
            contactRepo,
            contactListRepo,
            calendarEventRepo,
            taskRepo,
            noteRepo,
            attachmentRepo,
            auditLogRepo,
        ]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("Exposes the configured cron schedule.", () => {
        expect(job.schedule).toBe(config.get("mail:jobs:data_export:schedule"));
    });

    it("start() and stop() are no-ops beyond init().", async () => {
        await expect(job.start()).resolves.toBeUndefined();
        expect(job.stop()).toBeUndefined();
    });

    it("Does nothing when there are no pending requests.", async () => {
        await expect(job.run()).resolves.toBeUndefined();
    });

    it("Marks a request failed when its mailbox no longer exists.", async () => {
        const request = await createRequest({ mailboxUid: uuid.v4() });

        await job.run();

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        expect(updated!.status).toBe("failed");
        expect(updated!.errorMessage).toContain("no longer exists");

        const entries = await auditLogRepo.find({ action: AuditAction.DATA_EXPORT_FAILED }).toArray();
        expect(entries.length).toBe(1);
    });

    it("Builds an mbox bundle from the mailbox's own messages and stores it via BlobStore.", async () => {
        const mailbox = await createMailbox();
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const bodyBlobKeyA = `bodies/${uuid.v4()}`;
        const bodyBlobKeyB = `bodies/${uuid.v4()}`;
        await blobStore.put(bodyBlobKeyA, Buffer.from("Subject: First\r\n\r\nFirst body."));
        await blobStore.put(bodyBlobKeyB, Buffer.from("Subject: Second\r\n\r\nSecond body."));
        await messageRepo.save(
            new MessageMongo({
                mailboxUid: mailbox.uid,
                folderUid: uuid.v4(),
                messageId: `${uuid.v4()}@example.com`,
                subject: "First",
                from: { address: "alice@example.com", type: RecipientType.TO },
                recipients: [{ address: "bob@example.com", type: RecipientType.TO }],
                sentDate: new Date("2026-01-01"),
                receivedDate: new Date("2026-01-01"),
                bodyBlobKey: bodyBlobKeyA,
                flags: { read: false, flagged: false, answered: false, forwarded: false },
                references: [],
                hasAttachments: false,
            }),
        );
        await messageRepo.save(
            new MessageMongo({
                mailboxUid: mailbox.uid,
                folderUid: uuid.v4(),
                messageId: `${uuid.v4()}@example.com`,
                subject: "Second",
                from: { address: "carol@example.com", type: RecipientType.TO },
                recipients: [{ address: "dave@example.com", type: RecipientType.TO }],
                sentDate: new Date("2026-01-02"),
                receivedDate: new Date("2026-01-02"),
                bodyBlobKey: bodyBlobKeyB,
                flags: { read: false, flagged: false, answered: false, forwarded: false },
                references: [],
                hasAttachments: false,
            }),
        );
        const request = await createRequest({ mailboxUid: mailbox.uid, format: "mbox" });

        await job.run();

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        expect(updated!.status).toBe("ready");
        expect(updated!.blobKey).toBeTruthy();

        const bundle = await blobStore.get(updated!.blobKey!);
        expect(bundle.toString("utf-8")).toContain("First body.");
        expect(bundle.toString("utf-8")).toContain("Second body.");
        expect(bundle.toString("utf-8")).toMatch(/^From alice@example\.com /);

        const entries = await auditLogRepo.find({ action: AuditAction.DATA_EXPORT_READY }).toArray();
        expect(entries.length).toBe(1);
    });

    it("Builds a JSON bundle covering every entity type this mailbox owns.", async () => {
        const mailbox = await createMailbox();
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const folderUid = uuid.v4();

        await messageRepo.save(
            new MessageMongo({
                mailboxUid: mailbox.uid,
                folderUid,
                messageId: `${uuid.v4()}@example.com`,
                subject: "A Message",
                from: { address: "alice@example.com", type: RecipientType.TO },
                recipients: [{ address: "bob@example.com", type: RecipientType.TO }],
                sentDate: new Date(),
                receivedDate: new Date(),
                bodyBlobKey: `bodies/${uuid.v4()}`,
                flags: { read: false, flagged: false, answered: false, forwarded: false },
                references: [],
                hasAttachments: false,
            }),
        );
        await contactRepo.save(new ContactMongo({ mailboxUid: mailbox.uid, folderUid, displayName: "A Contact" }));
        await contactListRepo.save(new ContactListMongo({ mailboxUid: mailbox.uid, name: "A Contact List" }));
        await calendarEventRepo.save(new CalendarEventMongo({ mailboxUid: mailbox.uid, folderUid, title: "An Event" }));
        await taskRepo.save(new TaskMongo({ mailboxUid: mailbox.uid, folderUid, title: "A Task" }));
        await noteRepo.save(new NoteMongo({ mailboxUid: mailbox.uid, folderUid, title: "A Note", body: "Note body" }));
        await attachmentRepo.save(
            new AttachmentMongo({ mailboxUid: mailbox.uid, folderUid, messageUid: uuid.v4(), filename: "file.txt", mimeType: "text/plain" }),
        );
        const request = await createRequest({ mailboxUid: mailbox.uid, format: "json" });

        await job.run();

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        expect(updated!.status).toBe("ready");

        const bundle = (await blobStore.get(updated!.blobKey!)).toString("utf-8");
        const lines = bundle.split("\n").map((line) => JSON.parse(line));
        const entityTypes = lines.map((line) => line.entityType).sort();
        expect(entityTypes).toEqual(
            ["Mailbox", "attachment", "calendarEvent", "contact", "contactList", "message", "note", "task"].sort(),
        );
        expect(lines.find((line) => line.entityType === "Mailbox").uid).toBe(mailbox.uid);
        expect(lines.find((line) => line.entityType === "message").subject).toBe("A Message");
        expect(lines.find((line) => line.entityType === "contact").displayName).toBe("A Contact");
        expect(lines.find((line) => line.entityType === "note").title).toBe("A Note");
    });

    it("Does not include another mailbox's content in the bundle.", async () => {
        const mailbox = await createMailbox();
        const otherMailbox = await createMailbox();
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        await contactRepo.save(new ContactMongo({ mailboxUid: mailbox.uid, folderUid: uuid.v4(), displayName: "Mine" }));
        await contactRepo.save(new ContactMongo({ mailboxUid: otherMailbox.uid, folderUid: uuid.v4(), displayName: "Not Mine" }));
        const request = await createRequest({ mailboxUid: mailbox.uid, format: "json" });

        await job.run();

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        const bundle = (await blobStore.get(updated!.blobKey!)).toString("utf-8");
        expect(bundle).toContain("Mine");
        expect(bundle).not.toContain("Not Mine");
    });

    it("Logs an error and marks the request failed when building the bundle throws.", async () => {
        const mailbox = await createMailbox();
        const request = await createRequest({ mailboxUid: mailbox.uid, format: "json" });

        vi.spyOn(job as any, "buildJsonBundle").mockRejectedValueOnce(new Error("simulated failure"));

        await expect(job.run()).resolves.toBeUndefined();

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        expect(updated!.status).toBe("failed");
        expect(updated!.errorMessage).toBe("simulated failure");
    });

    it("Marks the request failed when the mailbox's content exceeds the configured max_content_rows cap, rather than risking unbounded memory growth.", async () => {
        const mailbox = await createMailbox();
        await contactRepo.save(new ContactMongo({ mailboxUid: mailbox.uid, folderUid: uuid.v4(), displayName: "A" }));
        await contactRepo.save(new ContactMongo({ mailboxUid: mailbox.uid, folderUid: uuid.v4(), displayName: "B" }));
        const request = await createRequest({ mailboxUid: mailbox.uid, format: "json" });

        const original = (job as any).maxContentRows;
        (job as any).maxContentRows = 1;
        try {
            await expect(job.run()).resolves.toBeUndefined();

            const updated = await requestRepo.findOne({ uid: request.uid } as any);
            expect(updated!.status).toBe("failed");
            expect(updated!.errorMessage).toContain("exceeds the maximum");
        } finally {
            (job as any).maxContentRows = original;
        }
    });

    it("Skips a message whose body blob can't be read, still exporting the rest.", async () => {
        const mailbox = await createMailbox();
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const goodBlobKey = `bodies/${uuid.v4()}`;
        await blobStore.put(goodBlobKey, Buffer.from("Subject: Good\r\n\r\nGood body."));
        await messageRepo.save(
            new MessageMongo({
                mailboxUid: mailbox.uid,
                folderUid: uuid.v4(),
                messageId: `${uuid.v4()}@example.com`,
                subject: "Missing Blob",
                from: { address: "alice@example.com", type: RecipientType.TO },
                recipients: [{ address: "bob@example.com", type: RecipientType.TO }],
                sentDate: new Date(),
                receivedDate: new Date(),
                bodyBlobKey: `bodies/${uuid.v4()}-does-not-exist`,
                flags: { read: false, flagged: false, answered: false, forwarded: false },
                references: [],
                hasAttachments: false,
            }),
        );
        await messageRepo.save(
            new MessageMongo({
                mailboxUid: mailbox.uid,
                folderUid: uuid.v4(),
                messageId: `${uuid.v4()}@example.com`,
                subject: "Good",
                from: { address: "carol@example.com", type: RecipientType.TO },
                recipients: [{ address: "dave@example.com", type: RecipientType.TO }],
                sentDate: new Date(),
                receivedDate: new Date(),
                bodyBlobKey: goodBlobKey,
                flags: { read: false, flagged: false, answered: false, forwarded: false },
                references: [],
                hasAttachments: false,
            }),
        );
        const request = await createRequest({ mailboxUid: mailbox.uid, format: "mbox" });

        await job.run();

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        expect(updated!.status).toBe("ready");
        const bundle = (await blobStore.get(updated!.blobKey!)).toString("utf-8");
        expect(bundle).toContain("Good body.");
        expect(bundle).not.toContain("Missing Blob");
    });

    it("Logs an error when even marking a request failed itself throws.", async () => {
        const request = await createRequest({ mailboxUid: uuid.v4() });
        const repoUtils = (job as any).dataExportRequestRepo;
        vi.spyOn(repoUtils, "update").mockRejectedValueOnce(new Error("update also failed"));

        await expect(job.run()).resolves.toBeUndefined();

        const stillPending = await requestRepo.findOne({ uid: request.uid } as any);
        expect(stillPending!.status).toBe("pending");
    });

    it("Does nothing when the repos are not yet initialized.", async () => {
        const original = (job as any).dataExportRequestRepo;
        (job as any).dataExportRequestRepo = undefined;
        try {
            await expect(job.run()).resolves.toBeUndefined();
        } finally {
            (job as any).dataExportRequestRepo = original;
        }
    });
});
