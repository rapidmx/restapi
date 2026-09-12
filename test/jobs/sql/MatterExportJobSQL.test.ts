///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for MatterExportJobSQL - see DataExportJobSQL.test.ts's/
// QuarantineRetentionJobSQL.test.ts's file headers for the full rationale (bypasses `Server`, wires a real
// ObjectFactory/ConnectionManager directly).
import { ACLUtils, AccessControlListSQL, ConnectionManager, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import config from "../../config.sql.js";
import { MatterExportJobSQL } from "../../../src/jobs/sql/MatterExportJobSQL.js";
import { AttachmentSQL } from "../../../src/models/sql/AttachmentSQL.js";
import { AuditLogEntrySQL } from "../../../src/models/sql/AuditLogEntrySQL.js";
import { CalendarEventSQL } from "../../../src/models/sql/CalendarEventSQL.js";
import { ContactSQL } from "../../../src/models/sql/ContactSQL.js";
import { ContactListSQL } from "../../../src/models/sql/ContactListSQL.js";
import { EscrowAuditLogEntrySQL } from "../../../src/models/sql/EscrowAuditLogEntrySQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { MatterExportRequestSQL } from "../../../src/models/sql/MatterExportRequestSQL.js";
import { MatterSQL } from "../../../src/models/sql/MatterSQL.js";
import { MessageSQL } from "../../../src/models/sql/MessageSQL.js";
import { NoteSQL } from "../../../src/models/sql/NoteSQL.js";
import { TaskSQL } from "../../../src/models/sql/TaskSQL.js";
import { AuditAction, EscrowAuditAction, RecipientType } from "../../../src/models/types.js";
import { InMemoryBlobStore, registerTestDoubles } from "../../testDoubles.js";

describe("MatterExportJobSQL Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: MatterExportJobSQL;
    let requestRepo: Repository<MatterExportRequestSQL>;
    let matterRepo: Repository<MatterSQL>;
    let mailboxRepo: Repository<MailboxSQL>;
    let messageRepo: Repository<MessageSQL>;
    let contactRepo: Repository<ContactSQL>;
    let contactListRepo: Repository<ContactListSQL>;
    let calendarEventRepo: Repository<CalendarEventSQL>;
    let taskRepo: Repository<TaskSQL>;
    let noteRepo: Repository<NoteSQL>;
    let attachmentRepo: Repository<AttachmentSQL>;
    let escrowAuditLogRepo: Repository<EscrowAuditLogEntrySQL>;
    let auditLogRepo: Repository<AuditLogEntrySQL>;

    const createMailbox = async (data?: Partial<MailboxSQL>): Promise<MailboxSQL> =>
        await mailboxRepo.save(
            new MailboxSQL({
                ownerUserUid: uuid.v4(),
                primarySmtpAddress: `${uuid.v4()}@example.com`,
                aliasAddresses: [],
                displayName: "Test Mailbox",
                timezone: "UTC",
                quotaBytes: 1_000_000_000,
                usedBytes: 0,
                ...data,
            }),
        );

    const createMatter = async (data: Partial<MatterSQL>): Promise<MatterSQL> =>
        await matterRepo.save(
            new MatterSQL({
                name: "Investigation A",
                escrowScopeId: uuid.v4(),
                custodianMailboxUids: [],
                dateRangeStart: new Date("2026-01-01"),
                dateRangeEnd: new Date("2026-06-01"),
                ...data,
            }),
        );

    const createRequest = async (data: Partial<MatterExportRequestSQL>): Promise<MatterExportRequestSQL> =>
        await requestRepo.save(new MatterExportRequestSQL({ matterId: uuid.v4(), requestedByUserUid: uuid.v4(), status: "pending", ...data }));

    beforeAll(async () => {
        objectFactory = new ObjectFactory(config, logger);
        objectFactory.register(ACLUtils);
        registerTestDoubles(objectFactory);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("AccessControlListSQL", AccessControlListSQL);
        models.set("MatterExportRequestSQL", MatterExportRequestSQL);
        models.set("MatterSQL", MatterSQL);
        models.set("MailboxSQL", MailboxSQL);
        models.set("MessageSQL", MessageSQL);
        models.set("ContactSQL", ContactSQL);
        models.set("ContactListSQL", ContactListSQL);
        models.set("CalendarEventSQL", CalendarEventSQL);
        models.set("TaskSQL", TaskSQL);
        models.set("NoteSQL", NoteSQL);
        models.set("AttachmentSQL", AttachmentSQL);
        models.set("EscrowAuditLogEntrySQL", EscrowAuditLogEntrySQL);
        models.set("AuditLogEntrySQL", AuditLogEntrySQL);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        requestRepo = conn.getRepository(MatterExportRequestSQL);
        matterRepo = conn.getRepository(MatterSQL);
        mailboxRepo = conn.getRepository(MailboxSQL);
        messageRepo = conn.getRepository(MessageSQL);
        contactRepo = conn.getRepository(ContactSQL);
        contactListRepo = conn.getRepository(ContactListSQL);
        calendarEventRepo = conn.getRepository(CalendarEventSQL);
        taskRepo = conn.getRepository(TaskSQL);
        noteRepo = conn.getRepository(NoteSQL);
        attachmentRepo = conn.getRepository(AttachmentSQL);
        escrowAuditLogRepo = conn.getRepository(EscrowAuditLogEntrySQL);
        auditLogRepo = conn.getRepository(AuditLogEntrySQL);

        job = await objectFactory.newInstance(MatterExportJobSQL, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
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

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("failed");
        expect(updated!.errorMessage).toContain("no longer exists");

        const entries = await auditLogRepo.find({ where: { action: AuditAction.MATTER_EXPORT_FAILED } });
        expect(entries).toHaveLength(1);
    });

    it("Builds a combined bundle across every custodian mailbox, narrowed to the matter's date range for messages.", async () => {
        const escrowScopeId = uuid.v4();
        const mailboxA = await createMailbox({ escrowScopeId });
        const mailboxB = await createMailbox({ escrowScopeId });
        const matter = await createMatter({
            escrowScopeId,
            custodianMailboxUids: [mailboxA.uid, mailboxB.uid],
            dateRangeStart: new Date("2026-03-01"),
            dateRangeEnd: new Date("2026-03-31"),
        });
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;

        // In-range message for mailboxA.
        await messageRepo.save(
            new MessageSQL({
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
            new MessageSQL({
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
        await contactRepo.save(new ContactSQL({ mailboxUid: mailboxB.uid, folderUid: uuid.v4(), displayName: "A Contact" }));

        const request = await createRequest({ matterId: matter.uid });

        await job.run();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("ready");

        const bundle = (await blobStore.get(updated!.blobKey!)).toString("utf-8");
        const lines = bundle.split("\n").map((line) => JSON.parse(line));
        const messageLines = lines.filter((l) => l.entityType === "message");
        expect(messageLines.length).toBe(1);
        expect(messageLines[0].subject).toBe("In range");
        expect(lines.some((l) => l.entityType === "contact" && l.displayName === "A Contact")).toBe(true);
        expect(lines.filter((l) => l.entityType === "Mailbox").length).toBe(2);

        const entries = await escrowAuditLogRepo.find({ where: { action: EscrowAuditAction.MATTER_EXPORT_READY } });
        expect(entries.length).toBe(2);
        expect(entries.map((e) => e.mailboxUid).sort()).toEqual([mailboxA.uid, mailboxB.uid].sort());
    });

    it("Skips a custodian mailbox that no longer exists, still exporting the rest.", async () => {
        const escrowScopeId = uuid.v4();
        const mailbox = await createMailbox({ escrowScopeId });
        const matter = await createMatter({ escrowScopeId, custodianMailboxUids: [uuid.v4(), mailbox.uid] });
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const request = await createRequest({ matterId: matter.uid });

        await job.run();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("ready");
        const bundle = (await blobStore.get(updated!.blobKey!)).toString("utf-8");
        const lines = bundle.split("\n").filter(Boolean).map((line) => JSON.parse(line));
        expect(lines.filter((l) => l.entityType === "Mailbox").length).toBe(1);

        const entries = await escrowAuditLogRepo.find({ where: { action: EscrowAuditAction.MATTER_EXPORT_READY } });
        expect(entries).toHaveLength(1);
    });

    it("Skips a custodian mailbox whose own escrowScopeId doesn't actually match the matter's - a holder cannot export a mailbox just by naming it as a custodian.", async () => {
        // Real, not hypothetical: `custodianMailboxUids` is holder-set, unvalidated free text
        // (`BaseMatterRoute.validateMatter()` only checks it's a non-empty array of non-empty strings) -
        // without this check, any holder could list an arbitrary mailbox (one never assigned to their
        // scope at all) as a "custodian" and export its full content with no dual-control approval, the
        // exact bypass `BaseEscrowAccessRequestRoute.create()`'s own escrowScopeId-matching check exists
        // to prevent for the real escrow-access workflow.
        const mailboxInScope = await createMailbox({ escrowScopeId: undefined });
        const matter = await createMatter({ custodianMailboxUids: [mailboxInScope.uid] });
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const request = await createRequest({ matterId: matter.uid });

        await job.run();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("ready");
        const bundle = (await blobStore.get(updated!.blobKey!)).toString("utf-8");
        const lines = bundle.split("\n").filter(Boolean).map((line) => JSON.parse(line));
        expect(lines).toHaveLength(0);

        const entries = await escrowAuditLogRepo.find({ where: { action: EscrowAuditAction.MATTER_EXPORT_READY } });
        expect(entries).toHaveLength(0);
    });

    it("Produces an empty bundle (still marked ready) when the matter has no custodian mailboxes.", async () => {
        const matter = await createMatter({ custodianMailboxUids: [] });
        const request = await createRequest({ matterId: matter.uid });

        await job.run();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("ready");
    });

    it("Logs an error and marks the request failed when the aggregation step throws.", async () => {
        const mailbox = await createMailbox();
        const matter = await createMatter({ custodianMailboxUids: [mailbox.uid] });
        const request = await createRequest({ matterId: matter.uid });

        vi.spyOn((job as any).mailboxRepo, "findOne").mockRejectedValueOnce(new Error("simulated failure"));

        await expect(job.run()).resolves.toBeUndefined();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("failed");
        expect(updated!.errorMessage).toBe("simulated failure");
    });

    it("Marks the request failed when a custodian mailbox's content exceeds the configured max_content_rows cap, rather than risking unbounded memory growth.", async () => {
        const escrowScopeId = uuid.v4();
        const mailbox = await createMailbox({ escrowScopeId });
        await contactRepo.save(new ContactSQL({ mailboxUid: mailbox.uid, folderUid: uuid.v4(), displayName: "A" }));
        await contactRepo.save(new ContactSQL({ mailboxUid: mailbox.uid, folderUid: uuid.v4(), displayName: "B" }));
        const matter = await createMatter({ escrowScopeId, custodianMailboxUids: [mailbox.uid] });
        const request = await createRequest({ matterId: matter.uid });

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

    it("Logs an error when even marking a request failed itself throws.", async () => {
        const request = await createRequest({ matterId: uuid.v4() });
        const repoUtils = (job as any).requestRepo;
        vi.spyOn(repoUtils, "update").mockRejectedValueOnce(new Error("update also failed"));

        await expect(job.run()).resolves.toBeUndefined();

        const stillPending = await requestRepo.findOne({ where: { uid: request.uid } });
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
