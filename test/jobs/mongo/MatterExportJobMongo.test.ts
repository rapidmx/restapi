///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for MatterExportJobMongo - see DataExportJobMongo.test.ts's/
// QuarantineRetentionJobMongo.test.ts's file headers for the full rationale (bypasses `Server`, wires a
// real ObjectFactory/ConnectionManager directly).
import { MongoMemoryServer } from "mongodb-memory-server";
import { ACLUtils, ConnectionManager, MongoConnection, MongoRepository, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../../config.js";
import { MatterExportJobMongo } from "../../../src/jobs/mongo/MatterExportJobMongo.js";
import { AttachmentMongo } from "../../../src/models/mongo/AttachmentMongo.js";
import { AuditLogEntryMongo } from "../../../src/models/mongo/AuditLogEntryMongo.js";
import { CalendarEventMongo } from "../../../src/models/mongo/CalendarEventMongo.js";
import { ContactMongo } from "../../../src/models/mongo/ContactMongo.js";
import { ContactListMongo } from "../../../src/models/mongo/ContactListMongo.js";
import { EscrowAuditLogEntryMongo } from "../../../src/models/mongo/EscrowAuditLogEntryMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { MatterExportRequestMongo } from "../../../src/models/mongo/MatterExportRequestMongo.js";
import { MatterMongo } from "../../../src/models/mongo/MatterMongo.js";
import { MessageMongo } from "../../../src/models/mongo/MessageMongo.js";
import { NoteMongo } from "../../../src/models/mongo/NoteMongo.js";
import { TaskMongo } from "../../../src/models/mongo/TaskMongo.js";
import { AuditAction, EscrowAuditAction, RecipientType } from "../../../src/models/types.js";
import { InMemoryBlobStore, registerTestDoubles } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("MatterExportJobMongo Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: MatterExportJobMongo;
    let requestRepo: MongoRepository<MatterExportRequestMongo>;
    let matterRepo: MongoRepository<MatterMongo>;
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let messageRepo: MongoRepository<MessageMongo>;
    let contactRepo: MongoRepository<ContactMongo>;
    let contactListRepo: MongoRepository<ContactListMongo>;
    let calendarEventRepo: MongoRepository<CalendarEventMongo>;
    let taskRepo: MongoRepository<TaskMongo>;
    let noteRepo: MongoRepository<NoteMongo>;
    let attachmentRepo: MongoRepository<AttachmentMongo>;
    let escrowAuditLogRepo: MongoRepository<EscrowAuditLogEntryMongo>;
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

    const createMatter = async (data: Partial<MatterMongo>): Promise<MatterMongo> =>
        await matterRepo.save(
            new MatterMongo({
                name: "Investigation A",
                escrowScopeId: uuid.v4(),
                custodianMailboxUids: [],
                dateRangeStart: new Date("2026-01-01"),
                dateRangeEnd: new Date("2026-06-01"),
                ...data,
            }),
        );

    const createRequest = async (data: Partial<MatterExportRequestMongo>): Promise<MatterExportRequestMongo> =>
        await requestRepo.save(new MatterExportRequestMongo({ matterId: uuid.v4(), requestedByUserUid: uuid.v4(), status: "pending", ...data }));

    beforeAll(async () => {
        await mongod.start();
        objectFactory = new ObjectFactory(config, logger);
        objectFactory.register(ACLUtils);
        registerTestDoubles(objectFactory);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("MatterExportRequestMongo", MatterExportRequestMongo);
        models.set("MatterMongo", MatterMongo);
        models.set("MailboxMongo", MailboxMongo);
        models.set("MessageMongo", MessageMongo);
        models.set("ContactMongo", ContactMongo);
        models.set("ContactListMongo", ContactListMongo);
        models.set("CalendarEventMongo", CalendarEventMongo);
        models.set("TaskMongo", TaskMongo);
        models.set("NoteMongo", NoteMongo);
        models.set("AttachmentMongo", AttachmentMongo);
        models.set("EscrowAuditLogEntryMongo", EscrowAuditLogEntryMongo);
        models.set("AuditLogEntryMongo", AuditLogEntryMongo);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        requestRepo = conn.getMongoRepository("MatterExportRequestMongo");
        matterRepo = conn.getMongoRepository("MatterMongo");
        mailboxRepo = conn.getMongoRepository("MailboxMongo");
        messageRepo = conn.getMongoRepository("MessageMongo");
        contactRepo = conn.getMongoRepository("ContactMongo");
        contactListRepo = conn.getMongoRepository("ContactListMongo");
        calendarEventRepo = conn.getMongoRepository("CalendarEventMongo");
        taskRepo = conn.getMongoRepository("TaskMongo");
        noteRepo = conn.getMongoRepository("NoteMongo");
        attachmentRepo = conn.getMongoRepository("AttachmentMongo");
        escrowAuditLogRepo = conn.getMongoRepository("EscrowAuditLogEntryMongo");
        auditLogRepo = conn.getMongoRepository("AuditLogEntryMongo");

        job = await objectFactory.newInstance(MatterExportJobMongo, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
        await mongod.stop();
    });

    beforeEach(async () => {
        for (const repo of [
            requestRepo,
            matterRepo,
            mailboxRepo,
            messageRepo,
            contactRepo,
            contactListRepo,
            calendarEventRepo,
            taskRepo,
            noteRepo,
            attachmentRepo,
            escrowAuditLogRepo,
            auditLogRepo,
        ]) {
            await repo.clear();
        }
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("Exposes the configured cron schedule.", () => {
        expect(job.schedule).toBe(config.get("mail:jobs:matter_export:schedule"));
    });

    it("start() and stop() are no-ops beyond init().", async () => {
        await expect(job.start()).resolves.toBeUndefined();
        expect(job.stop()).toBeUndefined();
    });

    it("Does nothing when there are no pending requests.", async () => {
        await expect(job.run()).resolves.toBeUndefined();
    });

    it("Marks a request failed via the general audit log when its matter no longer exists.", async () => {
        const request = await createRequest({ matterId: uuid.v4() });

        await job.run();

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        expect(updated!.status).toBe("failed");
        expect(updated!.errorMessage).toContain("no longer exists");

        const entries = await auditLogRepo.find({ action: AuditAction.MATTER_EXPORT_FAILED }).toArray();
        expect(entries).toHaveLength(1);
    });

    it("Builds a combined bundle across every custodian mailbox, narrowed to the matter's date range for messages.", async () => {
        const mailboxA = await createMailbox();
        const mailboxB = await createMailbox();
        const matter = await createMatter({
            custodianMailboxUids: [mailboxA.uid, mailboxB.uid],
            dateRangeStart: new Date("2026-03-01"),
            dateRangeEnd: new Date("2026-03-31"),
        });
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;

        // In-range message for mailboxA.
        await messageRepo.save(
            new MessageMongo({
                mailboxUid: mailboxA.uid,
                folderUid: uuid.v4(),
                messageId: `${uuid.v4()}@example.com`,
                subject: "In range",
                from: { address: "alice@example.com", type: RecipientType.TO },
                recipients: [],
                sentDate: new Date("2026-03-15"),
                receivedDate: new Date("2026-03-15"),
                bodyBlobKey: `bodies/${uuid.v4()}`,
                flags: { read: false, flagged: false, answered: false, forwarded: false },
                references: [],
                hasAttachments: false,
            }),
        );
        // Out-of-range message for mailboxA (before the matter's own dateRangeStart).
        await messageRepo.save(
            new MessageMongo({
                mailboxUid: mailboxA.uid,
                folderUid: uuid.v4(),
                messageId: `${uuid.v4()}@example.com`,
                subject: "Out of range",
                from: { address: "alice@example.com", type: RecipientType.TO },
                recipients: [],
                sentDate: new Date("2026-01-15"),
                receivedDate: new Date("2026-01-15"),
                bodyBlobKey: `bodies/${uuid.v4()}`,
                flags: { read: false, flagged: false, answered: false, forwarded: false },
                references: [],
                hasAttachments: false,
            }),
        );
        await contactRepo.save(new ContactMongo({ mailboxUid: mailboxB.uid, folderUid: uuid.v4(), displayName: "A Contact" }));

        const request = await createRequest({ matterId: matter.uid });

        await job.run();

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        expect(updated!.status).toBe("ready");

        const bundle = (await blobStore.get(updated!.blobKey!)).toString("utf-8");
        const lines = bundle.split("\n").map((line) => JSON.parse(line));
        const messageLines = lines.filter((l) => l.entityType === "message");
        expect(messageLines.length).toBe(1);
        expect(messageLines[0].subject).toBe("In range");
        expect(lines.some((l) => l.entityType === "contact" && l.displayName === "A Contact")).toBe(true);
        expect(lines.filter((l) => l.entityType === "Mailbox").length).toBe(2);

        const entries = await escrowAuditLogRepo.find({ action: EscrowAuditAction.MATTER_EXPORT_READY }).toArray();
        expect(entries.length).toBe(2);
        expect(entries.map((e) => e.mailboxUid).sort()).toEqual([mailboxA.uid, mailboxB.uid].sort());
    });

    it("Skips a custodian mailbox that no longer exists, still exporting the rest.", async () => {
        const mailbox = await createMailbox();
        const matter = await createMatter({ custodianMailboxUids: [uuid.v4(), mailbox.uid] });
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const request = await createRequest({ matterId: matter.uid });

        await job.run();

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        expect(updated!.status).toBe("ready");
        const bundle = (await blobStore.get(updated!.blobKey!)).toString("utf-8");
        const lines = bundle.split("\n").filter(Boolean).map((line) => JSON.parse(line));
        expect(lines.filter((l) => l.entityType === "Mailbox").length).toBe(1);

        const entries = await escrowAuditLogRepo.find({ action: EscrowAuditAction.MATTER_EXPORT_READY }).toArray();
        expect(entries).toHaveLength(1);
    });

    it("Produces an empty bundle (still marked ready) when the matter has no custodian mailboxes.", async () => {
        const matter = await createMatter({ custodianMailboxUids: [] });
        const request = await createRequest({ matterId: matter.uid });

        await job.run();

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        expect(updated!.status).toBe("ready");
    });

    it("Logs an error and marks the request failed when the aggregation step throws.", async () => {
        const mailbox = await createMailbox();
        const matter = await createMatter({ custodianMailboxUids: [mailbox.uid] });
        const request = await createRequest({ matterId: matter.uid });

        vi.spyOn((job as any).mailboxRepo, "findOne").mockRejectedValueOnce(new Error("simulated failure"));

        await expect(job.run()).resolves.toBeUndefined();

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        expect(updated!.status).toBe("failed");
        expect(updated!.errorMessage).toBe("simulated failure");
    });

    it("Logs an error when even marking a request failed itself throws.", async () => {
        const request = await createRequest({ matterId: uuid.v4() });
        const repoUtils = (job as any).requestRepo;
        vi.spyOn(repoUtils, "update").mockRejectedValueOnce(new Error("update also failed"));

        await expect(job.run()).resolves.toBeUndefined();

        const stillPending = await requestRepo.findOne({ uid: request.uid } as any);
        expect(stillPending!.status).toBe("pending");
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
