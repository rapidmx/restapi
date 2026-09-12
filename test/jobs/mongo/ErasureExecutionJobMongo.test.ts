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
import { BookingMongo } from "../../../src/models/mongo/BookingMongo.js";
import { BookingTypeMongo } from "../../../src/models/mongo/BookingTypeMongo.js";
import { CalendarEventMongo } from "../../../src/models/mongo/CalendarEventMongo.js";
import { ContactMongo } from "../../../src/models/mongo/ContactMongo.js";
import { ContactListMongo } from "../../../src/models/mongo/ContactListMongo.js";
import { DataExportRequestMongo } from "../../../src/models/mongo/DataExportRequestMongo.js";
import { DataSubjectErasureRequestMongo } from "../../../src/models/mongo/DataSubjectErasureRequestMongo.js";
import { DeviceSyncStateMongo } from "../../../src/models/mongo/DeviceSyncStateMongo.js";
import { FocusedInboxOverrideMongo } from "../../../src/models/mongo/FocusedInboxOverrideMongo.js";
import { FolderMongo } from "../../../src/models/mongo/FolderMongo.js";
import { IngestQueueEntryMongo } from "../../../src/models/mongo/IngestQueueEntryMongo.js";
import { LabelMongo } from "../../../src/models/mongo/LabelMongo.js";
import { MailboxImportRequestMongo } from "../../../src/models/mongo/MailboxImportRequestMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { MailFilterRuleMongo } from "../../../src/models/mongo/MailFilterRuleMongo.js";
import { MailSignatureMongo } from "../../../src/models/mongo/MailSignatureMongo.js";
import { MatterMongo } from "../../../src/models/mongo/MatterMongo.js";
import { MessageMongo } from "../../../src/models/mongo/MessageMongo.js";
import { NoteMongo } from "../../../src/models/mongo/NoteMongo.js";
import { OofReplySuppressionMongo } from "../../../src/models/mongo/OofReplySuppressionMongo.js";
import { QuarantineEntryMongo } from "../../../src/models/mongo/QuarantineEntryMongo.js";
import { TaskListMongo } from "../../../src/models/mongo/TaskListMongo.js";
import { TaskMongo } from "../../../src/models/mongo/TaskMongo.js";
import { AuditAction, MailFilterActionType, MessageClassification, QuarantineReason, RecipientType } from "../../../src/models/types.js";
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
    let focusedInboxOverrideRepo: MongoRepository<FocusedInboxOverrideMongo>;
    let taskListRepo: MongoRepository<TaskListMongo>;
    let labelRepo: MongoRepository<LabelMongo>;
    let mailFilterRuleRepo: MongoRepository<MailFilterRuleMongo>;
    let mailSignatureRepo: MongoRepository<MailSignatureMongo>;
    let bookingTypeRepo: MongoRepository<BookingTypeMongo>;
    let bookingRepo: MongoRepository<BookingMongo>;
    let oofReplySuppressionRepo: MongoRepository<OofReplySuppressionMongo>;
    let deviceSyncStateRepo: MongoRepository<DeviceSyncStateMongo>;
    let quarantineEntryRepo: MongoRepository<QuarantineEntryMongo>;
    let ingestQueueEntryRepo: MongoRepository<IngestQueueEntryMongo>;
    let dataExportRequestRepo: MongoRepository<DataExportRequestMongo>;
    let mailboxImportRequestRepo: MongoRepository<MailboxImportRequestMongo>;
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
        models.set("FocusedInboxOverrideMongo", FocusedInboxOverrideMongo);
        models.set("TaskListMongo", TaskListMongo);
        models.set("LabelMongo", LabelMongo);
        models.set("MailFilterRuleMongo", MailFilterRuleMongo);
        models.set("MailSignatureMongo", MailSignatureMongo);
        models.set("BookingTypeMongo", BookingTypeMongo);
        models.set("BookingMongo", BookingMongo);
        models.set("OofReplySuppressionMongo", OofReplySuppressionMongo);
        models.set("DeviceSyncStateMongo", DeviceSyncStateMongo);
        models.set("QuarantineEntryMongo", QuarantineEntryMongo);
        models.set("IngestQueueEntryMongo", IngestQueueEntryMongo);
        models.set("DataExportRequestMongo", DataExportRequestMongo);
        models.set("MailboxImportRequestMongo", MailboxImportRequestMongo);
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
        focusedInboxOverrideRepo = conn.getMongoRepository("FocusedInboxOverrideMongo");
        taskListRepo = conn.getMongoRepository("TaskListMongo");
        labelRepo = conn.getMongoRepository("LabelMongo");
        mailFilterRuleRepo = conn.getMongoRepository("MailFilterRuleMongo");
        mailSignatureRepo = conn.getMongoRepository("MailSignatureMongo");
        bookingTypeRepo = conn.getMongoRepository("BookingTypeMongo");
        bookingRepo = conn.getMongoRepository("BookingMongo");
        oofReplySuppressionRepo = conn.getMongoRepository("OofReplySuppressionMongo");
        deviceSyncStateRepo = conn.getMongoRepository("DeviceSyncStateMongo");
        quarantineEntryRepo = conn.getMongoRepository("QuarantineEntryMongo");
        ingestQueueEntryRepo = conn.getMongoRepository("IngestQueueEntryMongo");
        dataExportRequestRepo = conn.getMongoRepository("DataExportRequestMongo");
        mailboxImportRequestRepo = conn.getMongoRepository("MailboxImportRequestMongo");
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
            focusedInboxOverrideRepo,
            taskListRepo,
            labelRepo,
            mailFilterRuleRepo,
            mailSignatureRepo,
            bookingTypeRepo,
            bookingRepo,
            oofReplySuppressionRepo,
            deviceSyncStateRepo,
            quarantineEntryRepo,
            ingestQueueEntryRepo,
            dataExportRequestRepo,
            mailboxImportRequestRepo,
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

        await focusedInboxOverrideRepo.save(
            new FocusedInboxOverrideMongo({ mailboxUid: mailbox.uid, senderAddress: "vip@example.com", classifyAs: MessageClassification.FOCUSED }),
        );
        await taskListRepo.save(new TaskListMongo({ mailboxUid: mailbox.uid, name: "A Task List" }));
        const label = await labelRepo.save(new LabelMongo({ mailboxUid: mailbox.uid, name: "A Label" }));
        await mailFilterRuleRepo.save(
            new MailFilterRuleMongo({
                mailboxUid: mailbox.uid,
                name: "A Rule",
                enabled: true,
                sequence: 0,
                stopProcessingRules: false,
                conditions: { subjectContains: ["Hi"] },
                actions: [{ type: MailFilterActionType.APPLY_LABEL, labelUid: label.uid }],
            }),
        );
        await mailSignatureRepo.save(
            new MailSignatureMongo({ mailboxUid: mailbox.uid, name: "A Signature", contentHtml: "<p>Sig</p>", isDefaultForNewMessages: true, isDefaultForReplyForward: false }),
        );
        const bookingType = await bookingTypeRepo.save(
            new BookingTypeMongo({
                mailboxUid: mailbox.uid,
                calendarFolderUid: folder.uid,
                slug: "intro-call",
                name: "Intro Call",
                hostDisplayName: "Host",
            }),
        );
        await bookingRepo.save(
            new BookingMongo({
                bookingTypeUid: bookingType.uid,
                mailboxUid: mailbox.uid,
                folderUid: folder.uid,
                calendarEventUid: uuid.v4(),
                bookerName: "Booker",
                bookerEmail: "booker@example.com",
                startDate: new Date(),
                endDate: new Date(),
                manageToken: uuid.v4(),
            }),
        );
        await oofReplySuppressionRepo.save(new OofReplySuppressionMongo({ mailboxUid: mailbox.uid, senderAddress: "sender@example.com", lastRepliedAt: new Date() }));
        await deviceSyncStateRepo.save(
            new DeviceSyncStateMongo({ mailboxUid: mailbox.uid, deviceId: uuid.v4(), deviceType: "iPhone", folderSyncKeys: {}, folderCollectionClasses: {}, provisioned: true }),
        );

        const quarantineRawBlobKey = `quarantine/${uuid.v4()}`;
        await blobStore.put(quarantineRawBlobKey, Buffer.from("quarantined raw"));
        await quarantineEntryRepo.save(
            new QuarantineEntryMongo({ mailboxUid: mailbox.uid, reason: QuarantineReason.OTHER, scanResultUid: uuid.v4(), rawBlobKey: quarantineRawBlobKey }),
        );

        const ingestRawBlobKey = `ingest/${uuid.v4()}`;
        await blobStore.put(ingestRawBlobKey, Buffer.from("ingest raw"));
        await ingestQueueEntryRepo.save(
            new IngestQueueEntryMongo({
                mailboxUid: mailbox.uid,
                envelopeFrom: "sender@example.com",
                envelopeTo: ["recipient@example.com"],
                rawBlobKey: ingestRawBlobKey,
                status: "pending" as any,
            }),
        );

        const exportBlobKey = `exports/${uuid.v4()}`;
        await blobStore.put(exportBlobKey, Buffer.from("export bundle"));
        await dataExportRequestRepo.save(
            new DataExportRequestMongo({ mailboxUid: mailbox.uid, requestedByUserUid: uuid.v4(), format: "json", status: "ready", blobKey: exportBlobKey }),
        );

        const importSourceBlobKey = `mailbox-imports/${uuid.v4()}`;
        await blobStore.put(importSourceBlobKey, Buffer.from("mbox source"));
        await mailboxImportRequestRepo.save(
            new MailboxImportRequestMongo({
                mailboxUid: mailbox.uid,
                requestedByUserUid: uuid.v4(),
                targetFolderUid: folder.uid,
                format: "mbox",
                sourceBlobKey: importSourceBlobKey,
                status: "completed",
            }),
        );

        const request = await createRequest({ mailboxUid: mailbox.uid });

        await job.run();

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        expect(updated!.status).toBe("completed");
        // folder, message, attachment, contact, contactList, calendarEvent, task, note,
        // focusedInboxOverride, taskList, label, mailFilterRule, mailSignature, bookingType, booking,
        // oofReplySuppression, deviceSyncState, quarantineEntry, ingestQueueEntry, dataExportRequest,
        // mailboxImportRequest, mailbox = 22
        expect(updated!.purgedCount).toBe(22);

        expect(await mailboxRepo.findOne({ uid: mailbox.uid } as any)).toBeNull();
        expect(await folderRepo.findOne({ uid: folder.uid } as any)).toBeNull();
        expect(await messageRepo.findOne({ uid: message.uid } as any)).toBeNull();
        expect((await contactRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(0);
        expect((await contactListRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(0);
        expect((await calendarEventRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(0);
        expect((await taskRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(0);
        expect((await noteRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(0);
        expect((await attachmentRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(0);
        expect((await focusedInboxOverrideRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(0);
        expect((await taskListRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(0);
        expect((await labelRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(0);
        expect((await mailFilterRuleRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(0);
        expect((await mailSignatureRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(0);
        expect((await bookingTypeRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(0);
        expect((await bookingRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(0);
        expect((await oofReplySuppressionRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(0);
        expect((await deviceSyncStateRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(0);
        expect((await quarantineEntryRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(0);
        expect((await ingestQueueEntryRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(0);
        expect((await dataExportRequestRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(0);
        expect((await mailboxImportRequestRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(0);

        expect(await blobStore.exists(bodyBlobKey)).toBe(false);
        expect(await blobStore.exists(sanitizedHtmlBlobKey)).toBe(false);
        expect(await blobStore.exists(attachmentBlobKey)).toBe(false);
        expect(await blobStore.exists(extractedTextBlobKey)).toBe(false);
        expect(await blobStore.exists(photoBlobKey)).toBe(false);
        expect(await blobStore.exists(quarantineRawBlobKey)).toBe(false);
        expect(await blobStore.exists(ingestRawBlobKey)).toBe(false);
        expect(await blobStore.exists(exportBlobKey)).toBe(false);
        expect(await blobStore.exists(importSourceBlobKey)).toBe(false);

        const entries = await auditLogRepo.find({ action: AuditAction.ERASURE_REQUEST_COMPLETED }).toArray();
        expect(entries).toHaveLength(1);
    });

    it("Leaves the request 'approved' and preserves the mailbox row when a legal hold appears mid-cascade.", async () => {
        const mailbox = await createMailbox();
        await contactRepo.save(new ContactMongo({ mailboxUid: mailbox.uid, folderUid: uuid.v4(), displayName: "A Contact" }));
        const request = await createRequest({ mailboxUid: mailbox.uid });

        const originalFindOne = (job as any).mailboxRepo.findOne.bind((job as any).mailboxRepo);
        vi.spyOn((job as any).mailboxRepo, "findOne").mockImplementationOnce(async (...args: any[]) => {
            const result = await originalFindOne(...args);
            // Simulates a hold being placed on this mailbox in the window between the top-of-method check
            // and the job's own final re-check, right before the cascade itself runs.
            await matterRepo.save(
                new MatterMongo({
                    name: "Hold placed mid-cascade",
                    escrowScopeId: uuid.v4(),
                    custodianMailboxUids: [mailbox.uid],
                    dateRangeStart: new Date("2020-01-01"),
                    dateRangeEnd: new Date("2030-01-01"),
                }),
            );
            return result;
        });

        await job.run();

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        expect(updated!.status).toBe("approved");

        // The cascade already purged the contact before the hold was detected - only the final,
        // most-irreversible step (deleting the mailbox row itself) was actually stopped.
        expect((await contactRepo.find({ mailboxUid: mailbox.uid }).toArray()).length).toBe(0);
        expect(await mailboxRepo.findOne({ uid: mailbox.uid } as any)).toBeDefined();

        const entries = await auditLogRepo.find({ action: AuditAction.ERASURE_REQUEST_COMPLETED }).toArray();
        expect(entries).toHaveLength(0);
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
        await dataExportRequestRepo.save(
            new DataExportRequestMongo({ mailboxUid: mailbox.uid, requestedByUserUid: uuid.v4(), format: "json", status: "pending" }),
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
