///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for MatterExportJobSQL - see DataExportJobSQL.test.ts's/
// QuarantineRetentionJobSQL.test.ts's file headers for the full rationale (bypasses `Server`, wires a real
// ObjectFactory/ConnectionManager directly).
import { ACLUtils, AccessControlListSQL, ConnectionManager, ObjectFactory, RepoUtils, isSqlDataSource } from "@rapidrest/service-core";
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
        // Out-of-range message for mailboxA (after the matter's own dateRangeEnd) - the upper bound is part of
        // the query itself (range(...)), not an in-memory filter.
        await messageRepo.save(
            new MessageSQL({
                mailboxUid: mailboxA.uid,
                folderUid: uuid.v4(),
                messageId: `${uuid.v4()}@example.com`,
                subject: "After range",
                from: { address: "alice@example.com", type: RecipientType.TO },
                recipients: [],
                sentDate: new Date("2026-04-15"),
                receivedDate: new Date("2026-04-15"),
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

    it("Records no escrow audit entries at all when a LATER custodian mailbox fails - an earlier mailbox's own successful collection must not be permanently attested to an export that, as a whole, never completed.", async () => {
        const escrowScopeId = uuid.v4();
        const mailboxA = await createMailbox({ escrowScopeId });
        const mailboxB = await createMailbox({ escrowScopeId });
        await contactRepo.save(new ContactSQL({ mailboxUid: mailboxB.uid, folderUid: uuid.v4(), displayName: "A" }));
        await contactRepo.save(new ContactSQL({ mailboxUid: mailboxB.uid, folderUid: uuid.v4(), displayName: "B" }));
        const matter = await createMatter({ escrowScopeId, custodianMailboxUids: [mailboxA.uid, mailboxB.uid] });
        const request = await createRequest({ matterId: matter.uid });

        const original = (job as any).maxContentRows;
        // mailboxA has no content beyond its own "Mailbox" line (1, within the cap); mailboxB's two
        // contacts push its own total to 3, over the cap - mailboxA is processed (and would previously
        // have gotten its own MATTER_EXPORT_READY entry) BEFORE mailboxB's failure aborts the whole request.
        (job as any).maxContentRows = 2;
        try {
            await expect(job.run()).resolves.toBeUndefined();

            const updated = await requestRepo.findOne({ where: { uid: request.uid } });
            expect(updated!.status).toBe("failed");

            const entries = await escrowAuditLogRepo.find({ where: { action: EscrowAuditAction.MATTER_EXPORT_READY } });
            expect(entries).toHaveLength(0);
        } finally {
            (job as any).maxContentRows = original;
        }
    });

    it("Leaves the request 'ready' (not stuck/failed) when recording one mailbox's own escrow audit entry fails after the bundle is already stored - the disclosure already happened and must not be silently un-attested nor mistaken for a failed export.", async () => {
        const escrowScopeId = uuid.v4();
        const mailboxA = await createMailbox({ escrowScopeId });
        const mailboxB = await createMailbox({ escrowScopeId });
        const matter = await createMatter({ escrowScopeId, custodianMailboxUids: [mailboxA.uid, mailboxB.uid] });
        const request = await createRequest({ matterId: matter.uid });

        // `recordEscrowAuditEntry()`'s own internal `EscrowAuditLogEntrySQL` `RepoUtils` instance is
        // constructed and cached (`EscrowAuditUtils.ts`'s own module-level `WeakMap`) independently of
        // this test file's own `escrowAuditLogRepo` - patched at the shared `RepoUtils.prototype.create`
        // level instead, filtered to that one target class, so mailboxA's first 5 attempts
        // (MAX_APPEND_ATTEMPTS, see EscrowAuditUtils.ts) genuinely exhaust its retry loop and throw,
        // simulating real concurrent `sequence` contention without needing to actually win that race;
        // mailboxB's own later attempt (and every other entity type's own `RepoUtils.create()` call this
        // job makes) is unaffected and behaves normally.
        const originalCreate = RepoUtils.prototype.create;
        let escrowCreateAttempts = 0;
        vi.spyOn(RepoUtils.prototype, "create").mockImplementation(async function (this: any, obj: any, options: any) {
            if (this.modelClass?.name === "EscrowAuditLogEntrySQL" && escrowCreateAttempts < 5) {
                escrowCreateAttempts++;
                throw new Error("simulated sequence contention");
            }
            return originalCreate.call(this, obj, options);
        });

        await expect(job.run()).resolves.toBeUndefined();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("ready");
        expect(updated!.blobKey).toBeTruthy();

        // mailboxA's own attestation failed and was not retried; mailboxB's own later attestation still
        // succeeded despite mailboxA's failure not blocking the rest of the loop.
        const entries = await escrowAuditLogRepo.find({ where: { action: EscrowAuditAction.MATTER_EXPORT_READY } });
        expect(entries.map((e) => e.mailboxUid)).toEqual([mailboxB.uid]);
    });

    it("Marks a request failed, without claiming it or writing a bundle, when looking up its matter throws.", async () => {
        const request = await createRequest({ matterId: uuid.v4() });
        vi.spyOn((job as any).matterRepo, "findOne").mockRejectedValueOnce(new Error("simulated matter lookup failure"));
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const putSpy = vi.spyOn(blobStore, "put");

        await expect(job.run()).resolves.toBeUndefined();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("failed");
        expect(updated!.errorMessage).toBe("simulated matter lookup failure");
        expect(updated!.processingAttempts ?? 0).toBe(0);
        expect(putSpy).not.toHaveBeenCalled();
        expect(await auditLogRepo.find({ where: { action: AuditAction.MATTER_EXPORT_FAILED } })).toHaveLength(1);
    });

    it("Logs an error when even marking a request failed itself throws.", async () => {
        const request = await createRequest({ matterId: uuid.v4() });
        const repoUtils = (job as any).requestRepo;
        vi.spyOn(repoUtils, "update").mockRejectedValueOnce(new Error("update also failed"));

        await expect(job.run()).resolves.toBeUndefined();

        const stillPending = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(stillPending!.status).toBe("pending");
    });

    const withJobField = async (field: string, value: any, fn: () => Promise<void>): Promise<void> => {
        const original = (job as any)[field];
        (job as any)[field] = value;
        try {
            await fn();
        } finally {
            (job as any)[field] = original;
        }
    };

    it("Claims a request into 'processing' (bumping processingAttempts) and streams the bundle to an attempt-scoped blob key.", async () => {
        const escrowScopeId = uuid.v4();
        const mailbox = await createMailbox({ escrowScopeId });
        const matter = await createMatter({ escrowScopeId, custodianMailboxUids: [mailbox.uid] });
        const request = await createRequest({ matterId: matter.uid });
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const putSpy = vi.spyOn(blobStore, "put");

        await job.run();

        const updated = (await requestRepo.findOne({ where: { uid: request.uid } }));
        expect(updated!.status).toBe("ready");
        expect(updated!.processingAttempts).toBe(1);
        expect(updated!.blobKey).toBe(`matter-exports/${request.uid}-1.ndjson`);
        expect(Buffer.isBuffer(putSpy.mock.calls[0][1])).toBe(false);
        // claim + ready (the lease isn't due for renewal yet)
        expect(updated!.version).toBe(request.version + 2);
    });

    it("Only one of two overlapping runs holding the same stale request row wins the claim - the loser builds no bundle and records no attestations.", async () => {
        const escrowScopeId = uuid.v4();
        const mailbox = await createMailbox({ escrowScopeId });
        const matter = await createMatter({ escrowScopeId, custodianMailboxUids: [mailbox.uid] });
        const request = await createRequest({ matterId: matter.uid });
        const repoUtils = (job as any).requestRepo;
        const [stale] = await repoUtils.find({ status: "pending", limit: 5 } as any, { ignoreACL: true, limit: 5 });
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const putSpy = vi.spyOn(blobStore, "put");

        await (job as any).processRequest(stale);
        await expect((job as any).processRequest(stale)).rejects.toThrow();

        expect(putSpy).toHaveBeenCalledTimes(1);
        const updated = (await requestRepo.findOne({ where: { uid: request.uid } }));
        expect(updated!.status).toBe("ready");
        expect(updated!.processingAttempts).toBe(1);
        expect((await escrowAuditLogRepo.find({ where: { action: EscrowAuditAction.MATTER_EXPORT_READY } })).length).toBe(1);
    });

    it("Reclaims a 'processing' request whose lease expired and processes it again in the same run.", async () => {
        const matter = await createMatter({ custodianMailboxUids: [] });
        const request = await createRequest({
            matterId: matter.uid,
            status: "processing",
            processingAttempts: 1,
            dateModified: new Date(Date.now() - 2 * 60 * 60_000),
        });

        await job.run();

        const updated = (await requestRepo.findOne({ where: { uid: request.uid } }));
        expect(updated!.status).toBe("ready");
        expect(updated!.processingAttempts).toBe(2);
        expect(updated!.blobKey).toBe(`matter-exports/${request.uid}-2.ndjson`);
    });

    it("Leaves a 'processing' request alone while its lease is still fresh.", async () => {
        const matter = await createMatter({ custodianMailboxUids: [] });
        const request = await createRequest({ matterId: matter.uid, status: "processing", processingAttempts: 1 });

        await job.run();

        const updated = (await requestRepo.findOne({ where: { uid: request.uid } }));
        expect(updated!.status).toBe("processing");
        expect(updated!.version).toBe(request.version);
    });

    it("Marks an abandoned request failed instead of reclaiming it once max_attempts is reached.", async () => {
        const matter = await createMatter({ custodianMailboxUids: [] });
        const request = await createRequest({
            matterId: matter.uid,
            status: "processing",
            processingAttempts: 3,
            dateModified: new Date(Date.now() - 2 * 60 * 60_000),
        });

        await job.run();

        const updated = (await requestRepo.findOne({ where: { uid: request.uid } }));
        expect(updated!.status).toBe("failed");
        expect(updated!.errorMessage).toContain("did not complete after 3 attempt(s)");
        expect((await auditLogRepo.find({ where: { action: AuditAction.MATTER_EXPORT_FAILED } })).length).toBe(1);
    });

    it("Fails an export that exceeds mail:export:max_bytes, leaving no partial blob and no attestations behind.", async () => {
        const escrowScopeId = uuid.v4();
        const mailbox = await createMailbox({ escrowScopeId, displayName: "x".repeat(500) });
        const matter = await createMatter({ escrowScopeId, custodianMailboxUids: [mailbox.uid] });
        const request = await createRequest({ matterId: matter.uid });
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;

        await withJobField("maxBytes", 100, async () => {
            await job.run();
        });

        const updated = (await requestRepo.findOne({ where: { uid: request.uid } }));
        expect(updated!.status).toBe("failed");
        expect(updated!.errorMessage).toBe("Export exceeds the maximum export size of 100 bytes.");
        expect(await blobStore.exists(`matter-exports/${request.uid}-1.ndjson`)).toBe(false);
        expect((await escrowAuditLogRepo.find({ where: { action: EscrowAuditAction.MATTER_EXPORT_READY } })).length).toBe(0);
    });

    it("Renews its lease after each custodian while streaming, and still completes.", async () => {
        const escrowScopeId = uuid.v4();
        const mailboxA = await createMailbox({ escrowScopeId });
        const mailboxB = await createMailbox({ escrowScopeId });
        const matter = await createMatter({ escrowScopeId, custodianMailboxUids: [mailboxA.uid, mailboxB.uid] });
        const request = await createRequest({ matterId: matter.uid });

        await withJobField("leaseMinutes", 0, async () => {
            await (job as any).processRequest(request);
        });

        const updated = (await requestRepo.findOne({ where: { uid: request.uid } }));
        expect(updated!.status).toBe("ready");
        // claim + one renewal per custodian + ready
        expect(updated!.version).toBe(request.version + 4);
    });

    it("A run that lost its lease mid-export (another replica reclaimed the request) neither marks it ready nor leaves its blob or attestations behind.", async () => {
        const escrowScopeId = uuid.v4();
        const mailbox = await createMailbox({ escrowScopeId });
        const matter = await createMatter({ escrowScopeId, custodianMailboxUids: [mailbox.uid] });
        const request = await createRequest({ matterId: matter.uid });
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const realPut = blobStore.put.bind(blobStore);
        vi.spyOn(blobStore, "put").mockImplementationOnce(async (key: string, data: any, options?: any) => {
            await realPut(key, data, options);
            const current = (await requestRepo.findOne({ where: { uid: request.uid } }))!;
            await requestRepo.update({ uid: request.uid }, { version: current.version + 1, status: "pending" });
        });

        await (job as any).processRequest(request);

        const updated = (await requestRepo.findOne({ where: { uid: request.uid } }));
        expect(updated!.status).toBe("pending");
        expect(updated!.blobKey).toBeFalsy();
        expect(await blobStore.exists(`matter-exports/${request.uid}-1.ndjson`)).toBe(false);
        expect((await escrowAuditLogRepo.find({ where: { action: EscrowAuditAction.MATTER_EXPORT_READY } })).length).toBe(0);
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
