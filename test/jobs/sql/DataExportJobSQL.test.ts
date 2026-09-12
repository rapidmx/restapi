///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for DataExportJobSQL - see QuarantineRetentionJobSQL.test.ts's file
// header for the full rationale (bypasses `Server`, wires a real ObjectFactory/ConnectionManager
// directly).
import { ACLUtils, AccessControlListSQL, ConnectionManager, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import config from "../../config.sql.js";
import { DataExportJobSQL } from "../../../src/jobs/sql/DataExportJobSQL.js";
import { AttachmentSQL } from "../../../src/models/sql/AttachmentSQL.js";
import { AuditLogEntrySQL } from "../../../src/models/sql/AuditLogEntrySQL.js";
import { CalendarEventSQL } from "../../../src/models/sql/CalendarEventSQL.js";
import { ContactSQL } from "../../../src/models/sql/ContactSQL.js";
import { ContactListSQL } from "../../../src/models/sql/ContactListSQL.js";
import { DataExportRequestSQL } from "../../../src/models/sql/DataExportRequestSQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { MessageSQL } from "../../../src/models/sql/MessageSQL.js";
import { NoteSQL } from "../../../src/models/sql/NoteSQL.js";
import { TaskSQL } from "../../../src/models/sql/TaskSQL.js";
import { AuditAction, RecipientType } from "../../../src/models/types.js";
import { InMemoryBlobStore, registerTestDoubles } from "../../testDoubles.js";

describe("DataExportJobSQL Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: DataExportJobSQL;
    let requestRepo: Repository<DataExportRequestSQL>;
    let mailboxRepo: Repository<MailboxSQL>;
    let messageRepo: Repository<MessageSQL>;
    let contactRepo: Repository<ContactSQL>;
    let contactListRepo: Repository<ContactListSQL>;
    let calendarEventRepo: Repository<CalendarEventSQL>;
    let taskRepo: Repository<TaskSQL>;
    let noteRepo: Repository<NoteSQL>;
    let attachmentRepo: Repository<AttachmentSQL>;
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

    const createRequest = async (data: Partial<DataExportRequestSQL>): Promise<DataExportRequestSQL> =>
        await requestRepo.save(
            new DataExportRequestSQL({ mailboxUid: uuid.v4(), requestedByUserUid: uuid.v4(), format: "json", status: "pending", ...data }),
        );

    beforeAll(async () => {
        objectFactory = new ObjectFactory(config, logger);
        objectFactory.register(ACLUtils);
        registerTestDoubles(objectFactory);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("AccessControlListSQL", AccessControlListSQL);
        models.set("DataExportRequestSQL", DataExportRequestSQL);
        models.set("MailboxSQL", MailboxSQL);
        models.set("MessageSQL", MessageSQL);
        models.set("ContactSQL", ContactSQL);
        models.set("ContactListSQL", ContactListSQL);
        models.set("CalendarEventSQL", CalendarEventSQL);
        models.set("TaskSQL", TaskSQL);
        models.set("NoteSQL", NoteSQL);
        models.set("AttachmentSQL", AttachmentSQL);
        models.set("AuditLogEntrySQL", AuditLogEntrySQL);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        requestRepo = conn.getRepository(DataExportRequestSQL);
        mailboxRepo = conn.getRepository(MailboxSQL);
        messageRepo = conn.getRepository(MessageSQL);
        contactRepo = conn.getRepository(ContactSQL);
        contactListRepo = conn.getRepository(ContactListSQL);
        calendarEventRepo = conn.getRepository(CalendarEventSQL);
        taskRepo = conn.getRepository(TaskSQL);
        noteRepo = conn.getRepository(NoteSQL);
        attachmentRepo = conn.getRepository(AttachmentSQL);
        auditLogRepo = conn.getRepository(AuditLogEntrySQL);

        job = await objectFactory.newInstance(DataExportJobSQL, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
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
            await repo.clear();
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

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("failed");
        expect(updated!.errorMessage).toContain("no longer exists");

        const entries = await auditLogRepo.find({ where: { action: AuditAction.DATA_EXPORT_FAILED } });
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
            new MessageSQL({
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
            new MessageSQL({
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

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("ready");
        expect(updated!.blobKey).toBeTruthy();

        const bundle = await blobStore.get(updated!.blobKey!);
        expect(bundle.toString("utf-8")).toContain("First body.");
        expect(bundle.toString("utf-8")).toContain("Second body.");
        expect(bundle.toString("utf-8")).toMatch(/^From alice@example\.com /);

        const entries = await auditLogRepo.find({ where: { action: AuditAction.DATA_EXPORT_READY } });
        expect(entries.length).toBe(1);
    });

    it("Builds a JSON bundle covering every entity type this mailbox owns.", async () => {
        const mailbox = await createMailbox();
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const folderUid = uuid.v4();

        await messageRepo.save(
            new MessageSQL({
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
        await contactRepo.save(new ContactSQL({ mailboxUid: mailbox.uid, folderUid, displayName: "A Contact" }));
        await contactListRepo.save(new ContactListSQL({ mailboxUid: mailbox.uid, name: "A Contact List" }));
        await calendarEventRepo.save(new CalendarEventSQL({ mailboxUid: mailbox.uid, folderUid, title: "An Event" }));
        await taskRepo.save(new TaskSQL({ mailboxUid: mailbox.uid, folderUid, title: "A Task" }));
        await noteRepo.save(new NoteSQL({ mailboxUid: mailbox.uid, folderUid, title: "A Note", body: "Note body" }));
        await attachmentRepo.save(
            new AttachmentSQL({ mailboxUid: mailbox.uid, folderUid, messageUid: uuid.v4(), filename: "file.txt", mimeType: "text/plain" }),
        );
        const request = await createRequest({ mailboxUid: mailbox.uid, format: "json" });

        await job.run();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
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
        await contactRepo.save(new ContactSQL({ mailboxUid: mailbox.uid, folderUid: uuid.v4(), displayName: "Mine" }));
        await contactRepo.save(new ContactSQL({ mailboxUid: otherMailbox.uid, folderUid: uuid.v4(), displayName: "Not Mine" }));
        const request = await createRequest({ mailboxUid: mailbox.uid, format: "json" });

        await job.run();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        const bundle = (await blobStore.get(updated!.blobKey!)).toString("utf-8");
        expect(bundle).toContain("Mine");
        expect(bundle).not.toContain("Not Mine");
    });

    it("Logs an error and marks the request failed when building the bundle throws.", async () => {
        const mailbox = await createMailbox();
        const request = await createRequest({ mailboxUid: mailbox.uid, format: "json" });

        vi.spyOn(job as any, "buildJsonBundle").mockRejectedValueOnce(new Error("simulated failure"));

        await expect(job.run()).resolves.toBeUndefined();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("failed");
        expect(updated!.errorMessage).toBe("simulated failure");
    });

    it("Marks the request failed when the mailbox's content exceeds the configured max_content_rows cap, rather than risking unbounded memory growth.", async () => {
        const mailbox = await createMailbox();
        await contactRepo.save(new ContactSQL({ mailboxUid: mailbox.uid, folderUid: uuid.v4(), displayName: "A" }));
        await contactRepo.save(new ContactSQL({ mailboxUid: mailbox.uid, folderUid: uuid.v4(), displayName: "B" }));
        const request = await createRequest({ mailboxUid: mailbox.uid, format: "json" });

        const original = (job as any).maxContentRows;
        (job as any).maxContentRows = 1;
        try {
            await expect(job.run()).resolves.toBeUndefined();

            const updated = await requestRepo.findOne({ where: { uid: request.uid } });
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
            new MessageSQL({
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
            new MessageSQL({
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

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("ready");
        const bundle = (await blobStore.get(updated!.blobKey!)).toString("utf-8");
        expect(bundle).toContain("Good body.");
        expect(bundle).not.toContain("Missing Blob");
    });

    it("run()'s own outer catch marks the request failed when the claim-to-'processing' transition itself throws.", async () => {
        const mailbox = await createMailbox();
        const request = await createRequest({ mailboxUid: mailbox.uid, format: "json" });

        vi.spyOn((job as any).dataExportRequestRepo, "update").mockRejectedValueOnce(new Error("simulated claim failure"));

        await expect(job.run()).resolves.toBeUndefined();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("failed");
        expect(updated!.errorMessage).toBe("simulated claim failure");
    });

    it("A second, concurrently-racing call using the same originally-fetched request object fails at the claim step - before ever building a bundle or writing to BlobStore - rather than racing all the way to a duplicate/inconsistent blob write.", async () => {
        const mailbox = await createMailbox();
        const request = await createRequest({ mailboxUid: mailbox.uid, format: "json" });
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const putSpy = vi.spyOn(blobStore, "put");

        await (job as any).processRequest(request);
        const firstResult = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(firstResult!.status).toBe("ready");
        expect(putSpy).toHaveBeenCalledTimes(1);

        // Simulates a second, concurrently-racing job instance's own call - it would hold the SAME
        // originally-fetched `request` object (from its own top-of-run() find()), now stale relative to
        // what the first call above just wrote.
        await expect((job as any).processRequest(request)).rejects.toThrow();

        // The claim step itself is what rejected the second call - it never got far enough to build a
        // second bundle or write a second (possibly different) blob under the same key.
        expect(putSpy).toHaveBeenCalledTimes(1);
        const stillFirst = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(stillFirst!.status).toBe("ready");
        expect(stillFirst!.blobKey).toBe(firstResult!.blobKey);
    });

    it("Logs an error when even marking a request failed itself throws.", async () => {
        const request = await createRequest({ mailboxUid: uuid.v4() });
        const repoUtils = (job as any).dataExportRequestRepo;
        vi.spyOn(repoUtils, "update").mockRejectedValueOnce(new Error("update also failed"));

        await expect(job.run()).resolves.toBeUndefined();

        const stillPending = await requestRepo.findOne({ where: { uid: request.uid } });
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
