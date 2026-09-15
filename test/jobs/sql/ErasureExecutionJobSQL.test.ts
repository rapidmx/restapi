///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for ErasureExecutionJobSQL - see DataExportJobSQL.test.ts's/
// QuarantineRetentionJobSQL.test.ts's file headers for the full rationale (bypasses `Server`, wires a real
// ObjectFactory/ConnectionManager directly).
import { ACLUtils, AccessControlListSQL, ConnectionManager, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import config from "../../config.sql.js";
import { ErasureExecutionJobSQL } from "../../../src/jobs/sql/ErasureExecutionJobSQL.js";
import { AttachmentSQL } from "../../../src/models/sql/AttachmentSQL.js";
import { AuditLogEntrySQL } from "../../../src/models/sql/AuditLogEntrySQL.js";
import { BookingSQL } from "../../../src/models/sql/BookingSQL.js";
import { BookingTypeSQL } from "../../../src/models/sql/BookingTypeSQL.js";
import { CalendarEventSQL } from "../../../src/models/sql/CalendarEventSQL.js";
import { CalendarShareLinkSQL } from "../../../src/models/sql/CalendarShareLinkSQL.js";
import { KeyVaultSQL } from "../../../src/models/sql/KeyVaultSQL.js";
import { ContactSQL } from "../../../src/models/sql/ContactSQL.js";
import { ContactListSQL } from "../../../src/models/sql/ContactListSQL.js";
import { DataExportRequestSQL } from "../../../src/models/sql/DataExportRequestSQL.js";
import { DataSubjectErasureRequestSQL } from "../../../src/models/sql/DataSubjectErasureRequestSQL.js";
import { PluginMailboxDataMongo, PluginMailboxDataSQL } from "../fixtures/PluginMailboxData.js";
import { FocusedInboxOverrideSQL } from "../../../src/models/sql/FocusedInboxOverrideSQL.js";
import { FolderSQL } from "../../../src/models/sql/FolderSQL.js";
import { IngestQueueEntrySQL } from "../../../src/models/sql/IngestQueueEntrySQL.js";
import { LabelSQL } from "../../../src/models/sql/LabelSQL.js";
import { MailboxImportRequestSQL } from "../../../src/models/sql/MailboxImportRequestSQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { MailFilterRuleSQL } from "../../../src/models/sql/MailFilterRuleSQL.js";
import { MailSignatureSQL } from "../../../src/models/sql/MailSignatureSQL.js";
import { MatterSQL } from "../../../src/models/sql/MatterSQL.js";
import { MessageSQL } from "../../../src/models/sql/MessageSQL.js";
import { NoteSQL } from "../../../src/models/sql/NoteSQL.js";
import { OofReplySuppressionSQL } from "../../../src/models/sql/OofReplySuppressionSQL.js";
import { PluginSQL } from "../../../src/models/sql/PluginSQL.js";
import { PluginRegistry } from "../../../src/plugins/PluginRegistry.js";
import { QuarantineEntrySQL } from "../../../src/models/sql/QuarantineEntrySQL.js";
import { TaskListSQL } from "../../../src/models/sql/TaskListSQL.js";
import { TaskSQL } from "../../../src/models/sql/TaskSQL.js";
import { AuditAction, MailFilterActionType, MessageClassification, QuarantineReason, RecipientType } from "../../../src/models/types.js";
import { InMemoryBlobStore, registerTestDoubles } from "../../testDoubles.js";

describe("ErasureExecutionJobSQL Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: ErasureExecutionJobSQL;
    let requestRepo: Repository<DataSubjectErasureRequestSQL>;
    let mailboxRepo: Repository<MailboxSQL>;
    let folderRepo: Repository<FolderSQL>;
    let messageRepo: Repository<MessageSQL>;
    let contactRepo: Repository<ContactSQL>;
    let contactListRepo: Repository<ContactListSQL>;
    let calendarEventRepo: Repository<CalendarEventSQL>;
    let taskRepo: Repository<TaskSQL>;
    let noteRepo: Repository<NoteSQL>;
    let attachmentRepo: Repository<AttachmentSQL>;
    let focusedInboxOverrideRepo: Repository<FocusedInboxOverrideSQL>;
    let taskListRepo: Repository<TaskListSQL>;
    let labelRepo: Repository<LabelSQL>;
    let mailFilterRuleRepo: Repository<MailFilterRuleSQL>;
    let mailSignatureRepo: Repository<MailSignatureSQL>;
    let bookingTypeRepo: Repository<BookingTypeSQL>;
    let bookingRepo: Repository<BookingSQL>;
    let oofReplySuppressionRepo: Repository<OofReplySuppressionSQL>;
    let pluginMailboxDataRepo: Repository<PluginMailboxDataSQL>;
    let pluginRepo: Repository<PluginSQL>;
    let quarantineEntryRepo: Repository<QuarantineEntrySQL>;
    let ingestQueueEntryRepo: Repository<IngestQueueEntrySQL>;
    let dataExportRequestRepo: Repository<DataExportRequestSQL>;
    let mailboxImportRequestRepo: Repository<MailboxImportRequestSQL>;
    let matterRepo: Repository<MatterSQL>;
    let keyVaultRepo: Repository<KeyVaultSQL>;
    let calendarShareLinkRepo: Repository<CalendarShareLinkSQL>;
    let auditLogRepo: Repository<AuditLogEntrySQL>;

    const createMailbox = async (): Promise<MailboxSQL> =>
        await mailboxRepo.save(
            new MailboxSQL({
                ownerUserUid: uuid.v4(),
                primarySmtpAddress: `${uuid.v4()}@example.com`,
                aliasAddresses: [],
                displayName: "Test Mailbox",
                timezone: "UTC",
                quotaBytes: 1_000_000_000,
                usedBytes: 0,
            }),
        );

    const createRequest = async (data: Partial<DataSubjectErasureRequestSQL>): Promise<DataSubjectErasureRequestSQL> =>
        await requestRepo.save(new DataSubjectErasureRequestSQL({ mailboxUid: uuid.v4(), requestedByUserUid: uuid.v4(), status: "approved", ...data }));

    beforeAll(async () => {
        objectFactory = new ObjectFactory(config, logger);
        objectFactory.register(ACLUtils);
        registerTestDoubles(objectFactory);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("AccessControlListSQL", AccessControlListSQL);
        models.set("DataSubjectErasureRequestSQL", DataSubjectErasureRequestSQL);
        models.set("MailboxSQL", MailboxSQL);
        models.set("FolderSQL", FolderSQL);
        models.set("MessageSQL", MessageSQL);
        models.set("ContactSQL", ContactSQL);
        models.set("ContactListSQL", ContactListSQL);
        models.set("CalendarEventSQL", CalendarEventSQL);
        models.set("TaskSQL", TaskSQL);
        models.set("NoteSQL", NoteSQL);
        models.set("AttachmentSQL", AttachmentSQL);
        models.set("FocusedInboxOverrideSQL", FocusedInboxOverrideSQL);
        models.set("TaskListSQL", TaskListSQL);
        models.set("LabelSQL", LabelSQL);
        models.set("MailFilterRuleSQL", MailFilterRuleSQL);
        models.set("MailSignatureSQL", MailSignatureSQL);
        models.set("BookingTypeSQL", BookingTypeSQL);
        models.set("BookingSQL", BookingSQL);
        models.set("OofReplySuppressionSQL", OofReplySuppressionSQL);
        models.set("PluginMailboxDataSQL", PluginMailboxDataSQL);
        models.set("PluginSQL", PluginSQL);
        objectFactory.register(PluginMailboxDataSQL);
        // The other backend's marked model must be ignored, not purged against this datastore.
        objectFactory.register(PluginMailboxDataMongo);
        models.set("QuarantineEntrySQL", QuarantineEntrySQL);
        models.set("IngestQueueEntrySQL", IngestQueueEntrySQL);
        models.set("DataExportRequestSQL", DataExportRequestSQL);
        models.set("MailboxImportRequestSQL", MailboxImportRequestSQL);
        models.set("MatterSQL", MatterSQL);
        models.set("AuditLogEntrySQL", AuditLogEntrySQL);
        models.set("KeyVaultSQL", KeyVaultSQL);
        models.set("CalendarShareLinkSQL", CalendarShareLinkSQL);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        requestRepo = conn.getRepository(DataSubjectErasureRequestSQL);
        mailboxRepo = conn.getRepository(MailboxSQL);
        folderRepo = conn.getRepository(FolderSQL);
        messageRepo = conn.getRepository(MessageSQL);
        contactRepo = conn.getRepository(ContactSQL);
        contactListRepo = conn.getRepository(ContactListSQL);
        calendarEventRepo = conn.getRepository(CalendarEventSQL);
        taskRepo = conn.getRepository(TaskSQL);
        noteRepo = conn.getRepository(NoteSQL);
        attachmentRepo = conn.getRepository(AttachmentSQL);
        focusedInboxOverrideRepo = conn.getRepository(FocusedInboxOverrideSQL);
        taskListRepo = conn.getRepository(TaskListSQL);
        labelRepo = conn.getRepository(LabelSQL);
        mailFilterRuleRepo = conn.getRepository(MailFilterRuleSQL);
        mailSignatureRepo = conn.getRepository(MailSignatureSQL);
        bookingTypeRepo = conn.getRepository(BookingTypeSQL);
        bookingRepo = conn.getRepository(BookingSQL);
        oofReplySuppressionRepo = conn.getRepository(OofReplySuppressionSQL);
        pluginMailboxDataRepo = conn.getRepository(PluginMailboxDataSQL);
        pluginRepo = conn.getRepository(PluginSQL);
        quarantineEntryRepo = conn.getRepository(QuarantineEntrySQL);
        ingestQueueEntryRepo = conn.getRepository(IngestQueueEntrySQL);
        dataExportRequestRepo = conn.getRepository(DataExportRequestSQL);
        mailboxImportRequestRepo = conn.getRepository(MailboxImportRequestSQL);
        matterRepo = conn.getRepository(MatterSQL);
        auditLogRepo = conn.getRepository(AuditLogEntrySQL);
        keyVaultRepo = conn.getRepository(KeyVaultSQL);
        calendarShareLinkRepo = conn.getRepository(CalendarShareLinkSQL);

        job = await objectFactory.newInstance(ErasureExecutionJobSQL, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
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
            pluginMailboxDataRepo,
            pluginRepo,
            quarantineEntryRepo,
            ingestQueueEntryRepo,
            dataExportRequestRepo,
            mailboxImportRequestRepo,
            matterRepo,
            auditLogRepo,
            keyVaultRepo,
            calendarShareLinkRepo,
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
            new MatterSQL({
                name: "Held",
                escrowScopeId: uuid.v4(),
                custodianMailboxUids: [mailbox.uid],
                dateRangeStart: new Date("2020-01-01"),
                dateRangeEnd: new Date("2030-01-01"),
            }),
        );
        const request = await createRequest({ mailboxUid: mailbox.uid });

        await job.run();

        const stillApproved = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(stillApproved!.status).toBe("approved");

        const stillThere = await mailboxRepo.findOne({ where: { uid: mailbox.uid } });
        expect(stillThere).toBeDefined();
    });

    it("Cascades a full erasure: every mailboxUid-scoped entity, their blobs, and the mailbox itself.", async () => {
        const mailbox = await createMailbox();
        const folder = await folderRepo.save(new FolderSQL({ mailboxUid: mailbox.uid, name: "Inbox" }));
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;

        const bodyBlobKey = `bodies/${uuid.v4()}`;
        const sanitizedHtmlBlobKey = `sanitized/${uuid.v4()}`;
        await blobStore.put(bodyBlobKey, Buffer.from("raw"));
        await blobStore.put(sanitizedHtmlBlobKey, Buffer.from("<p>html</p>"));
        const message = await messageRepo.save(
            new MessageSQL({
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
            new AttachmentSQL({
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
        await contactRepo.save(new ContactSQL({ mailboxUid: mailbox.uid, folderUid: folder.uid, displayName: "A Contact", photoBlobKey }));
        await contactListRepo.save(new ContactListSQL({ mailboxUid: mailbox.uid, name: "A Contact List" }));
        await calendarEventRepo.save(new CalendarEventSQL({ mailboxUid: mailbox.uid, folderUid: folder.uid, title: "An Event" }));
        await taskRepo.save(new TaskSQL({ mailboxUid: mailbox.uid, folderUid: folder.uid, title: "A Task" }));
        await noteRepo.save(new NoteSQL({ mailboxUid: mailbox.uid, folderUid: folder.uid, title: "A Note", body: "Note body" }));

        await focusedInboxOverrideRepo.save(
            new FocusedInboxOverrideSQL({ mailboxUid: mailbox.uid, senderAddress: "vip@example.com", classifyAs: MessageClassification.FOCUSED }),
        );
        await taskListRepo.save(new TaskListSQL({ mailboxUid: mailbox.uid, name: "A Task List" }));
        const label = await labelRepo.save(new LabelSQL({ mailboxUid: mailbox.uid, name: "A Label" }));
        await mailFilterRuleRepo.save(
            new MailFilterRuleSQL({
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
            new MailSignatureSQL({ mailboxUid: mailbox.uid, name: "A Signature", contentHtml: "<p>Sig</p>", isDefaultForNewMessages: true, isDefaultForReplyForward: false }),
        );
        const bookingType = await bookingTypeRepo.save(
            new BookingTypeSQL({
                mailboxUid: mailbox.uid,
                calendarFolderUid: folder.uid,
                slug: "intro-call",
                name: "Intro Call",
                hostDisplayName: "Host",
            }),
        );
        await bookingRepo.save(
            new BookingSQL({
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
        await oofReplySuppressionRepo.save(new OofReplySuppressionSQL({ mailboxUid: mailbox.uid, senderAddress: "sender@example.com", lastRepliedAt: new Date() }));
        await pluginMailboxDataRepo.save(
            new PluginMailboxDataSQL({ mailboxUid: mailbox.uid }),
        );

        const quarantineRawBlobKey = `quarantine/${uuid.v4()}`;
        await blobStore.put(quarantineRawBlobKey, Buffer.from("quarantined raw"));
        await quarantineEntryRepo.save(
            new QuarantineEntrySQL({ mailboxUid: mailbox.uid, reason: QuarantineReason.OTHER, scanResultUid: uuid.v4(), rawBlobKey: quarantineRawBlobKey }),
        );

        const ingestRawBlobKey = `ingest/${uuid.v4()}`;
        await blobStore.put(ingestRawBlobKey, Buffer.from("ingest raw"));
        await ingestQueueEntryRepo.save(
            new IngestQueueEntrySQL({
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
            new DataExportRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: uuid.v4(), format: "json", status: "ready", blobKey: exportBlobKey }),
        );

        const importSourceBlobKey = `mailbox-imports/${uuid.v4()}`;
        await blobStore.put(importSourceBlobKey, Buffer.from("mbox source"));
        await mailboxImportRequestRepo.save(
            new MailboxImportRequestSQL({
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

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("completed");
        // folder, message, attachment, contact, contactList, calendarEvent, task, note,
        // focusedInboxOverride, taskList, label, mailFilterRule, mailSignature, bookingType, booking,
        // oofReplySuppression, plugin mailbox data, quarantineEntry, ingestQueueEntry, dataExportRequest,
        // mailboxImportRequest, mailbox = 22
        expect(updated!.purgedCount).toBe(22);

        expect(await mailboxRepo.findOne({ where: { uid: mailbox.uid } })).toBeNull();
        expect(await folderRepo.findOne({ where: { uid: folder.uid } })).toBeNull();
        expect(await messageRepo.findOne({ where: { uid: message.uid } })).toBeNull();
        expect((await contactRepo.find({ where: { mailboxUid: mailbox.uid } })).length).toBe(0);
        expect((await contactListRepo.find({ where: { mailboxUid: mailbox.uid } })).length).toBe(0);
        expect((await calendarEventRepo.find({ where: { mailboxUid: mailbox.uid } })).length).toBe(0);
        expect((await taskRepo.find({ where: { mailboxUid: mailbox.uid } })).length).toBe(0);
        expect((await noteRepo.find({ where: { mailboxUid: mailbox.uid } })).length).toBe(0);
        expect((await attachmentRepo.find({ where: { mailboxUid: mailbox.uid } })).length).toBe(0);
        expect((await focusedInboxOverrideRepo.find({ where: { mailboxUid: mailbox.uid } })).length).toBe(0);
        expect((await taskListRepo.find({ where: { mailboxUid: mailbox.uid } })).length).toBe(0);
        expect((await labelRepo.find({ where: { mailboxUid: mailbox.uid } })).length).toBe(0);
        expect((await mailFilterRuleRepo.find({ where: { mailboxUid: mailbox.uid } })).length).toBe(0);
        expect((await mailSignatureRepo.find({ where: { mailboxUid: mailbox.uid } })).length).toBe(0);
        expect((await bookingTypeRepo.find({ where: { mailboxUid: mailbox.uid } })).length).toBe(0);
        expect((await bookingRepo.find({ where: { mailboxUid: mailbox.uid } })).length).toBe(0);
        expect((await oofReplySuppressionRepo.find({ where: { mailboxUid: mailbox.uid } })).length).toBe(0);
        expect((await pluginMailboxDataRepo.find({ where: { mailboxUid: mailbox.uid } })).length).toBe(0);
        expect((await quarantineEntryRepo.find({ where: { mailboxUid: mailbox.uid } })).length).toBe(0);
        expect((await ingestQueueEntryRepo.find({ where: { mailboxUid: mailbox.uid } })).length).toBe(0);
        expect((await dataExportRequestRepo.find({ where: { mailboxUid: mailbox.uid } })).length).toBe(0);
        expect((await mailboxImportRequestRepo.find({ where: { mailboxUid: mailbox.uid } })).length).toBe(0);

        expect(await blobStore.exists(bodyBlobKey)).toBe(false);
        expect(await blobStore.exists(sanitizedHtmlBlobKey)).toBe(false);
        expect(await blobStore.exists(attachmentBlobKey)).toBe(false);
        expect(await blobStore.exists(extractedTextBlobKey)).toBe(false);
        expect(await blobStore.exists(photoBlobKey)).toBe(false);
        expect(await blobStore.exists(quarantineRawBlobKey)).toBe(false);
        expect(await blobStore.exists(ingestRawBlobKey)).toBe(false);
        expect(await blobStore.exists(exportBlobKey)).toBe(false);
        expect(await blobStore.exists(importSourceBlobKey)).toBe(false);

        const entries = await auditLogRepo.find({ where: { action: AuditAction.ERASURE_REQUEST_COMPLETED } });
        expect(entries).toHaveLength(1);
    });

    it("Leaves the request 'approved' and preserves the mailbox row when a legal hold appears mid-cascade.", async () => {
        const mailbox = await createMailbox();
        await contactRepo.save(new ContactSQL({ mailboxUid: mailbox.uid, folderUid: uuid.v4(), displayName: "A Contact" }));
        const request = await createRequest({ mailboxUid: mailbox.uid });

        const originalFindOne = (job as any).mailboxRepo.findOne.bind((job as any).mailboxRepo);
        vi.spyOn((job as any).mailboxRepo, "findOne").mockImplementationOnce(async (...args: any[]) => {
            const result = await originalFindOne(...args);
            // Simulates a hold being placed on this mailbox in the window between the top-of-method check
            // and the job's own final re-check, right before the cascade itself runs.
            await matterRepo.save(
                new MatterSQL({
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

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("approved");

        // The cascade already purged the contact before the hold was detected - only the final,
        // most-irreversible step (deleting the mailbox row itself) was actually stopped.
        expect((await contactRepo.find({ where: { mailboxUid: mailbox.uid } })).length).toBe(0);
        expect(await mailboxRepo.findOne({ where: { uid: mailbox.uid } })).toBeDefined();

        const entries = await auditLogRepo.find({ where: { action: AuditAction.ERASURE_REQUEST_COMPLETED } });
        expect(entries).toHaveLength(0);
    });

    it("Skips deleting a sanitizedHtmlBlobKey/extractedTextBlobKey that was never set.", async () => {
        const mailbox = await createMailbox();
        const folder = await folderRepo.save(new FolderSQL({ mailboxUid: mailbox.uid, name: "Inbox" }));
        const bodyBlobKey = `bodies/${uuid.v4()}`;
        const message = await messageRepo.save(
            new MessageSQL({
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
            new AttachmentSQL({
                mailboxUid: mailbox.uid,
                folderUid: folder.uid,
                messageUid: message.uid,
                filename: "file.txt",
                mimeType: "text/plain",
                blobKey: attachmentBlobKey,
            }),
        );
        await dataExportRequestRepo.save(
            new DataExportRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: uuid.v4(), format: "json", status: "pending" }),
        );
        const request = await createRequest({ mailboxUid: mailbox.uid });

        await expect(job.run()).resolves.toBeUndefined();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("completed");
    });

    it("Leaves the request 'approved' while an installed plugin with mailbox data isn't loaded, completing once it is.", async () => {
        const mailbox = await createMailbox();
        const plugin = { packageVersion: "1.0.0", enabled: false, settings: {}, manifest: { apiVersion: 1, displayName: "X", settings: [], mailboxScopedData: true } };
        await pluginRepo.save(new PluginSQL({ ...plugin, name: "@rapidmx/activesync-plugin", removed: false }));
        // Neither a disabled plugin without mailbox data nor a removed one holds the erasure.
        await pluginRepo.save(new PluginSQL({ ...plugin, name: "@rapidmx/branding-plugin", removed: false, manifest: { ...plugin.manifest, mailboxScopedData: undefined } }));
        await pluginRepo.save(new PluginSQL({ ...plugin, name: "@rapidmx/gone-plugin", removed: true }));
        const request = await createRequest({ mailboxUid: mailbox.uid });
        const logger = (job as any).logger;
        const error = vi.spyOn(logger, "error");

        try {
            await job.run();
            expect((await requestRepo.findOne({ where: { uid: request.uid } }))!.status).toBe("approved");
            expect(error).toHaveBeenCalledWith(expect.stringMatching(/aren't loaded \(@rapidmx\/activesync-plugin\)/));

            PluginRegistry.setLoaded([{ name: "@rapidmx/activesync-plugin", version: "1.0.0" }]);
            await job.run();
            expect((await requestRepo.findOne({ where: { uid: request.uid } }))!.status).toBe("completed");
            // The removed plugin's data can't be reached, so the erasure records that it was left behind.
            expect(error).toHaveBeenCalledWith(expect.stringMatching(/without erasing mailbox .* removed plugins \(@rapidmx\/gone-plugin\)/));
        } finally {
            PluginRegistry.setLoaded([]);
        }
    });

    it("Purges the mailbox's KeyVault and the CalendarShareLinks on its folders, but not another mailbox's.", async () => {
        const mailbox = await createMailbox();
        const otherMailbox = await createMailbox();
        const folder = await folderRepo.save(new FolderSQL({ mailboxUid: mailbox.uid, name: "Calendar" }));
        const otherFolder = await folderRepo.save(new FolderSQL({ mailboxUid: otherMailbox.uid, name: "Calendar" }));
        await keyVaultRepo.save(new KeyVaultSQL({ mailboxUid: mailbox.uid, wrappedKeys: [], masterKeyWraps: [] }));
        await keyVaultRepo.save(new KeyVaultSQL({ mailboxUid: otherMailbox.uid, wrappedKeys: [], masterKeyWraps: [] }));
        const link = { permittedActions: ["freebusy"], createdByUserUid: uuid.v4() };
        await calendarShareLinkRepo.save(new CalendarShareLinkSQL({ ...link, token: uuid.v4(), folderUid: folder.uid }));
        await calendarShareLinkRepo.save(new CalendarShareLinkSQL({ ...link, token: uuid.v4(), folderUid: otherFolder.uid }));
        const request = await createRequest({ mailboxUid: mailbox.uid });

        await job.run();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("completed");
        // folder, share link, key vault, mailbox
        expect(updated!.purgedCount).toBe(4);
        expect(await keyVaultRepo.count({ where: { mailboxUid: mailbox.uid } })).toBe(0);
        expect(await keyVaultRepo.count({ where: { mailboxUid: otherMailbox.uid } })).toBe(1);
        expect(await calendarShareLinkRepo.count({ where: { folderUid: folder.uid } })).toBe(0);
        expect(await calendarShareLinkRepo.count({ where: { folderUid: otherFolder.uid } })).toBe(1);
    });

    it("Keeps message, attachment and raw blobs another mailbox still references, deleting them once the last reference is erased.", async () => {
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const rawBlobKey = `ingest/${uuid.v4()}`;
        const attachmentBlobKey = `attachments/${uuid.v4()}`;
        const sanitizedHtmlBlobKey = `sanitized/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, Buffer.from("raw"));
        await blobStore.put(attachmentBlobKey, Buffer.from("attachment"));
        await blobStore.put(sanitizedHtmlBlobKey, Buffer.from("<p>html</p>"));
        const recipientA = await createMailbox();
        const custodian = await createMailbox();
        const recipientC = await createMailbox();
        // The custodian is under a legal hold: erasing another recipient must not destroy its copy's content.
        await matterRepo.save(
            new MatterSQL({
                name: "Held",
                escrowScopeId: uuid.v4(),
                custodianMailboxUids: [custodian.uid],
                dateRangeStart: new Date("2020-01-01"),
                dateRangeEnd: new Date("2030-01-01"),
            }),
        );
        const saveCopy = async (mailboxUid: string): Promise<void> => {
            const message = await messageRepo.save(
                new MessageSQL({
                    mailboxUid,
                    folderUid: uuid.v4(),
                    messageId: "shared@example.com",
                    subject: "Hi",
                    from: { address: "alice@example.com", type: RecipientType.TO },
                    recipients: [],
                    sentDate: new Date(),
                    receivedDate: new Date(),
                    bodyBlobKey: rawBlobKey,
                    sanitizedHtmlBlobKey,
                    flags: { read: false, flagged: false, answered: false, forwarded: false },
                    references: [],
                    hasAttachments: true,
                }),
            );
            await attachmentRepo.save(
                new AttachmentSQL({ mailboxUid, folderUid: message.folderUid, messageUid: message.uid, filename: "a.txt", mimeType: "text/plain", blobKey: attachmentBlobKey }),
            );
        };
        await saveCopy(recipientA.uid);
        await saveCopy(custodian.uid);
        // Recipient C's copy is still waiting in the ingest queue.
        await ingestQueueEntryRepo.save(
            new IngestQueueEntrySQL({ mailboxUid: recipientC.uid, envelopeFrom: "alice@example.com", envelopeTo: ["c@example.com"], rawBlobKey, status: "pending" as any }),
        );

        await createRequest({ mailboxUid: recipientA.uid });
        await job.run();
        expect(await blobStore.exists(rawBlobKey)).toBe(true);
        expect(await blobStore.exists(attachmentBlobKey)).toBe(true);
        expect(await blobStore.exists(sanitizedHtmlBlobKey)).toBe(true);

        // A soft-deleted copy is still recoverable, so it still counts as a reference.
        await messageRepo.update({ mailboxUid: custodian.uid }, { deleted: true });
        await matterRepo.clear();
        await createRequest({ mailboxUid: recipientC.uid });
        await job.run();
        expect(await blobStore.exists(rawBlobKey)).toBe(true);
        expect(await blobStore.exists(sanitizedHtmlBlobKey)).toBe(true);

        await createRequest({ mailboxUid: custodian.uid });
        await job.run();
        expect(await blobStore.exists(rawBlobKey)).toBe(false);
        expect(await blobStore.exists(attachmentBlobKey)).toBe(false);
        expect(await blobStore.exists(sanitizedHtmlBlobKey)).toBe(false);
    });

    it("Deletes the draft bodies an erased message kept for a (released) legal hold, but never a non-body key listed there (round 6).", async () => {
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const mailbox = await createMailbox();
        const [kept, notABody] = [`bodies/${uuid.v4()}`, `attachments/${uuid.v4()}`];
        await blobStore.put(kept, Buffer.from("old draft"));
        await blobStore.put(notABody, Buffer.from("someone else's"));
        await messageRepo.save(
            new MessageSQL({
                mailboxUid: mailbox.uid,
                folderUid: uuid.v4(),
                messageId: `${uuid.v4()}@example.com`,
                subject: "Draft",
                from: { address: "alice@example.com", type: RecipientType.TO },
                recipients: [],
                sentDate: new Date(),
                receivedDate: new Date(),
                bodyBlobKey: `bodies/${uuid.v4()}`,
                flags: { read: false, flagged: false, answered: false, forwarded: false },
                references: [],
                hasAttachments: false,
                retainedBodyBlobKeys: [kept, notABody],
            }),
        );
        await createRequest({ mailboxUid: mailbox.uid });

        await job.run();

        expect(await blobStore.exists(kept)).toBe(false);
        expect(await blobStore.exists(notABody)).toBe(true);
    });

    it("Does not touch another mailbox's content.", async () => {
        const mailbox = await createMailbox();
        const otherMailbox = await createMailbox();
        await contactRepo.save(new ContactSQL({ mailboxUid: mailbox.uid, folderUid: uuid.v4(), displayName: "Mine" }));
        await contactRepo.save(new ContactSQL({ mailboxUid: otherMailbox.uid, folderUid: uuid.v4(), displayName: "Not Mine" }));
        const request = await createRequest({ mailboxUid: mailbox.uid });

        await job.run();

        expect(await requestRepo.findOne({ where: { uid: request.uid } }).then((r) => r!.status)).toBe("completed");
        expect((await contactRepo.find({ where: { mailboxUid: mailbox.uid } })).length).toBe(0);
        expect((await contactRepo.find({ where: { mailboxUid: otherMailbox.uid } })).length).toBe(1);
        expect(await mailboxRepo.findOne({ where: { uid: otherMailbox.uid } })).toBeDefined();
    });

    it("Marks completed even when the mailbox row itself no longer exists, having still purged its children.", async () => {
        const mailboxUid = uuid.v4();
        await contactRepo.save(new ContactSQL({ mailboxUid, folderUid: uuid.v4(), displayName: "Orphaned" }));
        const request = await createRequest({ mailboxUid });

        await job.run();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("completed");
        expect(updated!.purgedCount).toBe(1);
    });

    it("Logs a warning and continues the cascade when one row's own delete throws.", async () => {
        const mailbox = await createMailbox();
        await contactRepo.save(new ContactSQL({ mailboxUid: mailbox.uid, folderUid: uuid.v4(), displayName: "A" }));
        await contactRepo.save(new ContactSQL({ mailboxUid: mailbox.uid, folderUid: uuid.v4(), displayName: "B" }));
        const request = await createRequest({ mailboxUid: mailbox.uid });

        const originalNewInstance = objectFactory.newInstance.bind(objectFactory);
        let contactRepoUtilsCreated = 0;
        vi.spyOn(objectFactory, "newInstance").mockImplementation(async (...args: any[]) => {
            const instance: any = await originalNewInstance(...args);
            if (args[1]?.name === "ContactSQL" && contactRepoUtilsCreated++ === 0) {
                vi.spyOn(instance, "delete").mockRejectedValueOnce(new Error("simulated delete failure"));
            }
            return instance;
        });

        await job.run();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("completed");
        // One contact failed to delete and is still there; everything else (including the mailbox) is gone.
        expect((await contactRepo.find({ where: { mailboxUid: mailbox.uid } })).length).toBe(1);
    });

    it("Logs an error when the mailbox's own purge fails, still marking the request completed.", async () => {
        const mailbox = await createMailbox();
        const request = await createRequest({ mailboxUid: mailbox.uid });

        vi.spyOn((job as any).mailboxRepo, "delete").mockRejectedValueOnce(new Error("simulated mailbox delete failure"));

        await job.run();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("completed");
        expect(await mailboxRepo.findOne({ where: { uid: mailbox.uid } })).toBeDefined();
    });

    it("Logs an error but doesn't crash the run when processing one request throws unexpectedly.", async () => {
        const request = await createRequest({ mailboxUid: uuid.v4() });
        vi.spyOn((job as any).mailboxRepo, "findOne").mockRejectedValueOnce(new Error("simulated lookup failure"));

        await expect(job.run()).resolves.toBeUndefined();

        const stillApproved = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(stillApproved!.status).toBe("approved");
    });

    it("Rejects a second markCompleted() call using the originally-fetched (now-stale) request object, rather than silently overwriting the first call's purgedCount - the optimistic-lock protection a multi-instance deployment relies on to keep two concurrent job runs from double-processing the same request.", async () => {
        const mailbox = await createMailbox();
        const request = await createRequest({ mailboxUid: mailbox.uid });

        await (job as any).markCompleted(request, 5);
        const firstResult = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(firstResult!.status).toBe("completed");
        expect(firstResult!.purgedCount).toBe(5);

        // Simulates a second, concurrently-racing job instance's own call - it would hold the SAME
        // originally-fetched `request` object (from its own top-of-run() `find()`), now stale relative to
        // what the first call above just wrote.
        await expect((job as any).markCompleted(request, 1)).rejects.toThrow();

        const stillFirst = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(stillFirst!.purgedCount).toBe(5);
    });

    it("Removes the search index documents of every purged message, contact, calendar event, task and note.", async () => {
        const mailbox = await createMailbox();
        const folderUid = uuid.v4();
        const message = await messageRepo.save(
            new MessageSQL({
                mailboxUid: mailbox.uid,
                folderUid,
                messageId: `${uuid.v4()}@example.com`,
                subject: "Hi",
                from: { address: "alice@example.com", type: RecipientType.TO },
                recipients: [],
                sentDate: new Date(),
                receivedDate: new Date(),
                bodyBlobKey: `bodies/${uuid.v4()}`,
                flags: { read: false, flagged: false, answered: false, forwarded: false },
                references: [],
                hasAttachments: false,
            }),
        );
        const softDeletedContact = await contactRepo.save(new ContactSQL({ mailboxUid: mailbox.uid, folderUid, displayName: "Deleted" }));
        await contactRepo.update({ uid: softDeletedContact.uid }, { deleted: true });
        const event = await calendarEventRepo.save(new CalendarEventSQL({ mailboxUid: mailbox.uid, folderUid, title: "An Event" }));
        const task = await taskRepo.save(new TaskSQL({ mailboxUid: mailbox.uid, folderUid, title: "A Task" }));
        const note = await noteRepo.save(new NoteSQL({ mailboxUid: mailbox.uid, folderUid, title: "A Note", body: "Body" }));
        const otherContact = await contactRepo.save(new ContactSQL({ mailboxUid: uuid.v4(), folderUid, displayName: "Not mine" }));
        await createRequest({ mailboxUid: mailbox.uid });
        const searchProvider: any = objectFactory.getInstance("SearchProvider");
        const removeSpy = vi.spyOn(searchProvider, "remove");

        await job.run();

        const removed = removeSpy.mock.calls.map((call) => `${call[0]}:${call[1]}`).sort();
        expect(removed).toEqual(
            [`message:${message.uid}`, `contact:${softDeletedContact.uid}`, `calendarEvent:${event.uid}`, `task:${task.uid}`, `note:${note.uid}`].sort(),
        );
        expect(removed).not.toContain(`contact:${otherContact.uid}`);
    });

    it("Purges every row across several keyset pages, including rows written behind the cursor mid-purge.", async () => {
        const mailbox = await createMailbox();
        for (let i = 0; i < 7; i++) {
            await contactRepo.save(new ContactSQL({ mailboxUid: mailbox.uid, folderUid: uuid.v4(), displayName: `C${i}` }));
        }
        const request = await createRequest({ mailboxUid: mailbox.uid });
        (job as any).purgePageSize = 2;
        const searchProvider: any = objectFactory.getInstance("SearchProvider");
        let injected = false;
        vi.spyOn(searchProvider, "remove").mockImplementation(async (entityType: any) => {
            if (entityType === "contact" && !injected) {
                injected = true;
                // A concurrent write whose uid sorts before the cursor - a single keyset pass would miss it.
                const late = await contactRepo.save(new ContactSQL({ mailboxUid: mailbox.uid, folderUid: uuid.v4(), displayName: "Late" }));
                await contactRepo.update({ uid: late.uid }, { uid: "00000000-0000-0000-0000-000000000000" });
            }
        });

        try {
            await job.run();
        } finally {
            (job as any).purgePageSize = 500;
        }

        expect(await contactRepo.count({ where: { mailboxUid: mailbox.uid } })).toBe(0);
        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("completed");
        // 8 contacts + mailbox
        expect(updated!.purgedCount).toBe(9);
    });

    it("Claims a request before running it, so a second worker holding the same stale read skips it.", async () => {
        const mailbox = await createMailbox();
        await contactRepo.save(new ContactSQL({ mailboxUid: mailbox.uid, folderUid: uuid.v4(), displayName: "A" }));
        const request = await createRequest({ mailboxUid: mailbox.uid });
        const stale = await requestRepo.findOne({ where: { uid: request.uid } });
        let statusDuringCascade: string | undefined;
        const originalFindOne = (job as any).mailboxRepo.findOne.bind((job as any).mailboxRepo);
        vi.spyOn((job as any).mailboxRepo, "findOne").mockImplementationOnce(async (...args: any[]) => {
            statusDuringCascade = (await requestRepo.findOne({ where: { uid: request.uid } }))!.status;
            return await originalFindOne(...args);
        });

        await job.run();

        expect(statusDuringCascade).toBe("in_progress");
        const completed = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(completed!.status).toBe("completed");

        const markSpy = vi.spyOn(job as any, "markCompleted");
        await (job as any).processRequest(stale);
        expect(markSpy).not.toHaveBeenCalled();
        expect((await requestRepo.findOne({ where: { uid: request.uid } }))!.purgedCount).toBe(completed!.purgedCount);
        expect(await auditLogRepo.count({ where: { action: AuditAction.ERASURE_REQUEST_COMPLETED } })).toBe(1);
    });

    it("Leaves a freshly claimed in-progress request alone, but takes over one whose claim went stale.", async () => {
        const mailbox = await createMailbox();
        const request = await createRequest({ mailboxUid: mailbox.uid, status: "in_progress" });

        await job.run();
        expect((await requestRepo.findOne({ where: { uid: request.uid } }))!.status).toBe("in_progress");
        expect(await mailboxRepo.findOne({ where: { uid: mailbox.uid } })).not.toBeNull();

        await requestRepo.update({ uid: request.uid }, { dateModified: new Date(Date.now() - 3600 * 1000) });
        await job.run();
        expect((await requestRepo.findOne({ where: { uid: request.uid } }))!.status).toBe("completed");
        expect(await mailboxRepo.findOne({ where: { uid: mailbox.uid } })).toBeNull();
    });

    it("Renews its claim during a long cascade and stops if the claim was taken over.", async () => {
        const mailbox = await createMailbox();
        await contactRepo.save(new ContactSQL({ mailboxUid: mailbox.uid, folderUid: uuid.v4(), displayName: "A" }));
        const request = await createRequest({ mailboxUid: mailbox.uid });
        (job as any).claimLeaseSeconds = 0;
        const originalFindOne = (job as any).mailboxRepo.findOne.bind((job as any).mailboxRepo);
        vi.spyOn((job as any).mailboxRepo, "findOne").mockImplementationOnce(async (...args: any[]) => {
            await requestRepo.increment({ uid: request.uid }, "version", 1);
            return await originalFindOne(...args);
        });

        try {
            await job.run();
        } finally {
            (job as any).claimLeaseSeconds = 900;
        }

        expect(await contactRepo.count({ where: { mailboxUid: mailbox.uid } })).toBe(1);
        expect(await mailboxRepo.findOne({ where: { uid: mailbox.uid } })).not.toBeNull();
        expect(await auditLogRepo.count({ where: { action: AuditAction.ERASURE_REQUEST_COMPLETED } })).toBe(0);
    });

    it("Hands a stale in-progress request found under a legal hold back as approved, leaving its mailbox alone.", async () => {
        const mailbox = await createMailbox();
        await matterRepo.save(
            new MatterSQL({
                name: "Held",
                escrowScopeId: uuid.v4(),
                custodianMailboxUids: [mailbox.uid],
                dateRangeStart: new Date("2020-01-01"),
                dateRangeEnd: new Date("2030-01-01"),
            }),
        );
        await contactRepo.save(new ContactSQL({ mailboxUid: mailbox.uid, folderUid: uuid.v4(), displayName: "A" }));
        const request = await createRequest({ mailboxUid: mailbox.uid, status: "in_progress" });
        await requestRepo.update({ uid: request.uid }, { dateModified: new Date(Date.now() - 3600 * 1000) });

        await job.run();

        // Reads as waiting (retried once the hold ends), not as a cascade still running.
        expect((await requestRepo.findOne({ where: { uid: request.uid } }))!.status).toBe("approved");
        expect(await mailboxRepo.findOne({ where: { uid: mailbox.uid } })).not.toBeNull();
        expect(await contactRepo.count({ where: { mailboxUid: mailbox.uid } })).toBe(1);
        expect(await auditLogRepo.count({ where: { action: AuditAction.ERASURE_REQUEST_COMPLETED } })).toBe(0);
    });

    it("Renews its claim on every page of a long cascade and completes using the renewed claim.", async () => {
        const mailbox = await createMailbox();
        for (let i = 0; i < 3; i++) {
            await contactRepo.save(new ContactSQL({ mailboxUid: mailbox.uid, folderUid: uuid.v4(), displayName: `C${i}` }));
        }
        const request = await createRequest({ mailboxUid: mailbox.uid });
        const updateSpy = vi.spyOn((job as any).requestRepo, "update");
        (job as any).claimLeaseSeconds = 0;
        (job as any).purgePageSize = 1;

        try {
            await job.run();
        } finally {
            (job as any).claimLeaseSeconds = 900;
            (job as any).purgePageSize = 500;
        }

        // The claim, at least one renewal per purged page, then the completion - each version-checked against the last.
        expect(updateSpy.mock.calls.length).toBeGreaterThanOrEqual(2 + 3);
        const completed = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(completed!.status).toBe("completed");
        expect(completed!.purgedCount).toBe(4);
        expect(await contactRepo.count({ where: { mailboxUid: mailbox.uid } })).toBe(0);
        expect(await mailboxRepo.findOne({ where: { uid: mailbox.uid } })).toBeNull();
        expect(await auditLogRepo.count({ where: { action: AuditAction.ERASURE_REQUEST_COMPLETED } })).toBe(1);
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
