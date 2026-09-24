///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for MailboxImportJobSQL - see DataExportJobSQL.test.ts's/
// QuarantineRetentionJobSQL.test.ts's file headers for the full rationale (bypasses `Server`, wires a real
// ObjectFactory/ConnectionManager directly).
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ACLUtils, NotificationUtils, AccessControlListSQL, ConnectionManager, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import config from "../../config.sql.js";
import { MailboxImportJobSQL } from "../../../src/jobs/sql/MailboxImportJobSQL.js";
import { LocalFsBlobStore } from "../../../src/blob/LocalFsBlobStore.js";
import { AttachmentSQL } from "../../../src/models/sql/AttachmentSQL.js";
import { AuditLogEntrySQL } from "../../../src/models/sql/AuditLogEntrySQL.js";
import { FolderSQL } from "../../../src/models/sql/FolderSQL.js";
import { MailboxImportRequestSQL } from "../../../src/models/sql/MailboxImportRequestSQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { MessageSQL } from "../../../src/models/sql/MessageSQL.js";
import { AuditAction, RecipientType } from "../../../src/models/types.js";
import { buildMboxEntry } from "../../../src/util/MboxUtils.js";
import { InMemoryBlobStore, registerTestDoubles } from "../../testDoubles.js";

const PST_FIXTURE_PATH = path.join(process.cwd(), "node_modules/pst-extractor/example/testdata/enron.pst");

/** Builds a minimal valid multipart RFC 5322 message, optionally with a header/attachment marker - mirrors
 * `ScanQueueJobSQL.test.ts`'s own identical helper. */
function makeRawMessage(opts: { extraHeader?: string; attachmentMarker?: string } = {}): Buffer {
    const attachmentContent = opts.attachmentMarker ?? "fake attachment content";
    const raw = [
        "From: sender@example.com",
        "To: recipient@example.com",
        "Subject: Test message",
        "MIME-Version: 1.0",
        ...(opts.extraHeader ? [opts.extraHeader] : []),
        'Content-Type: multipart/mixed; boundary="BOUNDARY"',
        "",
        "--BOUNDARY",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Hello there.",
        "",
        "--BOUNDARY",
        'Content-Type: application/octet-stream; name="file.txt"',
        'Content-Disposition: attachment; filename="file.txt"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from(attachmentContent).toString("base64"),
        "",
        "--BOUNDARY--",
        "",
    ].join("\r\n");
    return Buffer.from(raw);
}

describe("MailboxImportJobSQL Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: MailboxImportJobSQL;
    let requestRepo: Repository<MailboxImportRequestSQL>;
    let mailboxRepo: Repository<MailboxSQL>;
    let folderRepo: Repository<FolderSQL>;
    let messageRepo: Repository<MessageSQL>;
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

    const createFolder = async (mailboxUid: string): Promise<FolderSQL> => await folderRepo.save(new FolderSQL({ mailboxUid, name: "Imported" }));

    const createRequest = async (data: Partial<MailboxImportRequestSQL>): Promise<MailboxImportRequestSQL> =>
        await requestRepo.save(
            new MailboxImportRequestSQL({
                mailboxUid: uuid.v4(),
                requestedByUserUid: uuid.v4(),
                targetFolderUid: uuid.v4(),
                format: "mbox",
                sourceBlobKey: `mailbox-imports/${uuid.v4()}`,
                status: "pending",
                ...data,
            }),
        );

    beforeAll(async () => {
        objectFactory = new ObjectFactory(config, logger);
        objectFactory.register(ACLUtils);
        registerTestDoubles(objectFactory);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("AccessControlListSQL", AccessControlListSQL);
        models.set("MailboxImportRequestSQL", MailboxImportRequestSQL);
        models.set("MailboxSQL", MailboxSQL);
        models.set("FolderSQL", FolderSQL);
        models.set("MessageSQL", MessageSQL);
        models.set("AttachmentSQL", AttachmentSQL);
        models.set("AuditLogEntrySQL", AuditLogEntrySQL);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        requestRepo = conn.getRepository(MailboxImportRequestSQL);
        mailboxRepo = conn.getRepository(MailboxSQL);
        folderRepo = conn.getRepository(FolderSQL);
        messageRepo = conn.getRepository(MessageSQL);
        attachmentRepo = conn.getRepository(AttachmentSQL);
        auditLogRepo = conn.getRepository(AuditLogEntrySQL);

        job = await objectFactory.newInstance(MailboxImportJobSQL, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        for (const repo of [requestRepo, mailboxRepo, folderRepo, messageRepo, attachmentRepo, auditLogRepo]) {
            await repo.clear();
        }
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("Exposes the configured cron schedule.", () => {
        expect(job.schedule).toBe(config.get("mail:jobs:mailbox_import:schedule"));
    });

    it("start() and stop() are no-ops beyond init().", async () => {
        await expect(job.start()).resolves.toBeUndefined();
        expect(job.stop()).toBeUndefined();
    });

    it("Does nothing when there are no pending requests.", async () => {
        await expect(job.run()).resolves.toBeUndefined();
    });

    it("Marks a request failed when its target mailbox no longer exists.", async () => {
        const request = await createRequest({ mailboxUid: uuid.v4() });

        await job.run();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("failed");
        expect(updated!.errorMessage).toContain("no longer exists");

        const entries = await auditLogRepo.find({ where: { action: AuditAction.MAILBOX_IMPORT_FAILED } });
        expect(entries.length).toBe(1);
    });

    it("Marks a request failed when its target folder no longer exists.", async () => {
        const mailbox = await createMailbox();
        const request = await createRequest({ mailboxUid: mailbox.uid, targetFolderUid: uuid.v4() });

        await job.run();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("failed");
        expect(updated!.errorMessage).toContain("no longer exists");
    });

    it("Deletes the already-uploaded source blob even when the target mailbox is gone before the job ever reads it - not just on a successful/quota-rejected import.", async () => {
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const sourceBlobKey = `mailbox-imports/${uuid.v4()}`;
        await blobStore.put(sourceBlobKey, buildMboxEntry(makeRawMessage(), "alice@example.com", new Date("2020-01-01")));
        const request = await createRequest({ mailboxUid: uuid.v4(), sourceBlobKey });

        await job.run();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("failed");
        expect(await blobStore.exists(sourceBlobKey)).toBe(false);
    });

    it("Imports every message from an mbox source into the target folder, bumping its counters.", async () => {
        const mailbox = await createMailbox();
        const folder = await createFolder(mailbox.uid);
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const sourceBlobKey = `mailbox-imports/${uuid.v4()}`;
        const mbox = Buffer.concat([
            buildMboxEntry(makeRawMessage(), "alice@example.com", new Date("2020-01-01")),
            buildMboxEntry(makeRawMessage(), "bob@example.com", new Date("2020-01-02")),
        ]);
        await blobStore.put(sourceBlobKey, mbox);
        const request = await createRequest({ mailboxUid: mailbox.uid, targetFolderUid: folder.uid, format: "mbox", sourceBlobKey });
        const sendMessageSpy = vi.spyOn(NotificationUtils.prototype, "sendMessage");

        await job.run();

        // The folder's counts are derived from the imported messages and published once for the whole import.
        const countEvents = sendMessageSpy.mock.calls.filter(([, type, action]) => /^Folder/.test(String(type)) && action === "update");
        sendMessageSpy.mockRestore();
        expect(countEvents).toEqual([
            [[folder.uid, mailbox.uid], "FolderSQL", "update", { uid: folder.uid, mailboxUid: mailbox.uid, unreadCount: 0, totalCount: 2 }],
        ]);

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("completed");
        expect(updated!.importedCount).toBe(2);
        expect(updated!.failedCount).toBe(0);

        const messages = await messageRepo.find({ where: { folderUid: folder.uid } });
        expect(messages.length).toBe(2);
        expect(messages.every((m) => m.mailboxUid === mailbox.uid)).toBe(true);
        expect(messages.every((m) => m.flags.read === true)).toBe(true);
        // An mbox/PST import is never the user's own export, so it never carries a verification seal.
        expect(messages.every((m) => m.verificationSeal == null && m.verificationSealGeneration == null)).toBe(true);

        const attachments = await attachmentRepo.find({ where: { folderUid: folder.uid } });
        expect(attachments.length).toBe(2);
        expect(attachments[0].filename).toBe("file.txt");

        const updatedFolder = await folderRepo.findOne({ where: { uid: folder.uid } });
        expect(updatedFolder!.totalCount).toBe(2);
        expect(updatedFolder!.syncKeyVersion).toBe(1);

        const entries = await auditLogRepo.find({ where: { action: AuditAction.MAILBOX_IMPORT_COMPLETED } });
        expect(entries.length).toBe(1);
        // The uploaded source blob is removed once this request completes successfully - the only other
        // caller that ever deletes a sourceBlobKey blob is ErasureExecutionJob, on GDPR erasure alone, not
        // ordinary import completion, so this job must clean up its own upload itself.
        expect(await blobStore.exists(sourceBlobKey)).toBe(false);
    });

    it("Preserves a message's own real Date: header as sentDate/receivedDate, rather than stamping import time.", async () => {
        const mailbox = await createMailbox();
        const folder = await createFolder(mailbox.uid);
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const sourceBlobKey = `mailbox-imports/${uuid.v4()}`;
        // A real historical date, years before "now" - if this job silently stamped import time instead
        // (the bug this test guards against), a legal hold whose date range covers 2019 would fail to
        // recognize this message as ever having been in scope for it.
        const mbox = buildMboxEntry(makeRawMessage({ extraHeader: "Date: Tue, 15 Jan 2019 10:30:00 +0000" }), "alice@example.com", new Date());
        await blobStore.put(sourceBlobKey, mbox);
        const request = await createRequest({ mailboxUid: mailbox.uid, targetFolderUid: folder.uid, format: "mbox", sourceBlobKey });

        await job.run();

        expect((await requestRepo.findOne({ where: { uid: request.uid } }))!.importedCount).toBe(1);
        const messages = await messageRepo.find({ where: { folderUid: folder.uid } });
        expect(messages.length).toBe(1);
        expect(messages[0].sentDate.toISOString()).toBe(new Date("2019-01-15T10:30:00.000Z").toISOString());
        expect(messages[0].receivedDate.toISOString()).toBe(new Date("2019-01-15T10:30:00.000Z").toISOString());
    });

    it("Falls back to the import time when a message has no Date: header at all.", async () => {
        const mailbox = await createMailbox();
        const folder = await createFolder(mailbox.uid);
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const sourceBlobKey = `mailbox-imports/${uuid.v4()}`;
        const mbox = buildMboxEntry(makeRawMessage(), "alice@example.com", new Date());
        await blobStore.put(sourceBlobKey, mbox);
        const request = await createRequest({ mailboxUid: mailbox.uid, targetFolderUid: folder.uid, format: "mbox", sourceBlobKey });
        const before = Date.now();

        await job.run();

        expect((await requestRepo.findOne({ where: { uid: request.uid } }))!.importedCount).toBe(1);
        const messages = await messageRepo.find({ where: { folderUid: folder.uid } });
        expect(messages[0].sentDate.getTime()).toBeGreaterThanOrEqual(before);
    });

    it("Skips an AV-infected message instead of importing it, counting it as failed.", async () => {
        const mailbox = await createMailbox();
        const folder = await createFolder(mailbox.uid);
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const sourceBlobKey = `mailbox-imports/${uuid.v4()}`;
        const mbox = Buffer.concat([
            buildMboxEntry(makeRawMessage({ extraHeader: "X-Test-Force-Infected: true" }), "eve@example.com", new Date("2020-01-01")),
            buildMboxEntry(makeRawMessage(), "bob@example.com", new Date("2020-01-02")),
        ]);
        await blobStore.put(sourceBlobKey, mbox);
        const request = await createRequest({ mailboxUid: mailbox.uid, targetFolderUid: folder.uid, format: "mbox", sourceBlobKey });

        await job.run();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("completed");
        expect(updated!.importedCount).toBe(1);
        expect(updated!.failedCount).toBe(1);

        const messages = await messageRepo.find({ where: { folderUid: folder.uid } });
        expect(messages.length).toBe(1);
    });

    it("Skips the entire message when only one of its attachments is AV-infected, rather than laundering it minus the attachment.", async () => {
        // `ScanPipelineResult.av` is the worst of the raw message's own scan and every attachment's own scan
        // (see `ScanPipeline.run()`'s own doc comment) - an infected attachment therefore already fails this
        // job's single `result.av.verdict === INFECTED` gate, same as a raw-level infection.
        const mailbox = await createMailbox();
        const folder = await createFolder(mailbox.uid);
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const sourceBlobKey = `mailbox-imports/${uuid.v4()}`;
        const mbox = buildMboxEntry(makeRawMessage({ attachmentMarker: "X-Test-Force-Infected: true" }), "eve@example.com", new Date("2020-01-01"));
        await blobStore.put(sourceBlobKey, mbox);
        const request = await createRequest({ mailboxUid: mailbox.uid, targetFolderUid: folder.uid, format: "mbox", sourceBlobKey });

        await job.run();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.importedCount).toBe(0);
        expect(updated!.failedCount).toBe(1);

        const messages = await messageRepo.find({ where: { folderUid: folder.uid } });
        expect(messages.length).toBe(0);

        const attachments = await attachmentRepo.find({ where: { folderUid: folder.uid } });
        expect(attachments.length).toBe(0);
    });

    it("Imports every real mail item from a real PST fixture, including its attachments.", async () => {
        const mailbox = await createMailbox();
        const folder = await createFolder(mailbox.uid);
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const sourceBlobKey = `mailbox-imports/${uuid.v4()}`;
        await blobStore.put(sourceBlobKey, fs.readFileSync(PST_FIXTURE_PATH));
        const request = await createRequest({ mailboxUid: mailbox.uid, targetFolderUid: folder.uid, format: "pst", sourceBlobKey });

        await job.run();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("completed");
        expect(updated!.importedCount).toBe(71);
        expect(updated!.failedCount).toBe(0);

        const messages = await messageRepo.find({ where: { folderUid: folder.uid } });
        expect(messages.length).toBe(71);

        const attachments = await attachmentRepo.find({ where: { folderUid: folder.uid } });
        expect(attachments.length).toBeGreaterThan(0);
    }, 30000);

    describe("resolveLocalSourcePath() - reading the source file without a full in-memory buffer", () => {
        it("Uses BlobStore.localPath() directly - no getStream()/temp-file download at all - when the store is filesystem-backed.", async () => {
            const mailbox = await createMailbox();
            const folder = await createFolder(mailbox.uid);
            const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "restapi-localfs-blobstore-test-"));
            const localStore = new LocalFsBlobStore();
            (localStore as any).root = tempRoot;
            const sourceBlobKey = `mailbox-imports/${uuid.v4()}`;
            await localStore.put(sourceBlobKey, buildMboxEntry(makeRawMessage(), "alice@example.com", new Date("2020-01-01")));
            const getStreamSpy = vi.spyOn(localStore, "getStream");
            const getSpy = vi.spyOn(localStore, "get");

            const originalBlobStore = (job as any).blobStore;
            (job as any).blobStore = localStore;
            try {
                const request = await createRequest({ mailboxUid: mailbox.uid, targetFolderUid: folder.uid, format: "mbox", sourceBlobKey });

                await job.run();

                const updated = await requestRepo.findOne({ where: { uid: request.uid } });
                expect(updated!.status).toBe("completed");
                expect(updated!.importedCount).toBe(1);
                // Read directly off the blob's own real path - never a full get() buffer, never a getStream()
                // download-to-temp-file (that fallback is only for a store with no local path to offer at all).
                expect(getStreamSpy).not.toHaveBeenCalled();
                expect(getSpy).not.toHaveBeenCalled();
            } finally {
                (job as any).blobStore = originalBlobStore;
                await fs.promises.rm(tempRoot, { recursive: true, force: true });
            }
        });

        it("Streams to a temp file (never a full get() buffer) when the store has no localPath() (e.g. S3BlobStore), and cleans the temp file up again once the request is done.", async () => {
            const mailbox = await createMailbox();
            const folder = await createFolder(mailbox.uid);
            const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
            const sourceBlobKey = `mailbox-imports/${uuid.v4()}`;
            await blobStore.put(sourceBlobKey, buildMboxEntry(makeRawMessage(), "alice@example.com", new Date("2020-01-01")));
            // `MailboxImportJob` itself must never call `get()` directly (a full-buffer read) - only
            // `getStream()`. `InMemoryBlobStore.getStream()` happens to be implemented via its own internal
            // `get()` call (a test-double-only implementation detail, unlike a real streaming `getStream()`
            // such as `S3BlobStore`'s own), so `get()` is deliberately not asserted un-called here - only
            // that the JOB reaches the blob through `getStream()`, not by calling `get()` on it itself.
            const getStreamSpy = vi.spyOn(blobStore, "getStream");
            const tempFilesBefore = (await fs.promises.readdir(os.tmpdir())).filter((f) => f.startsWith("mailbox-import-"));

            const request = await createRequest({ mailboxUid: mailbox.uid, targetFolderUid: folder.uid, format: "mbox", sourceBlobKey });
            await job.run();

            expect(getStreamSpy).toHaveBeenCalledWith(sourceBlobKey);
            const updated = await requestRepo.findOne({ where: { uid: request.uid } });
            expect(updated!.status).toBe("completed");
            expect(updated!.importedCount).toBe(1);
            // The temp file used mid-import is removed once the request is done, whether it succeeded or not - no leak.
            const tempFilesAfter = (await fs.promises.readdir(os.tmpdir())).filter((f) => f.startsWith("mailbox-import-"));
            expect(tempFilesAfter.length).toBe(tempFilesBefore.length);
        });

        it("Cleans up the partially-written temp file (and marks the request failed) when the download itself fails partway through, not just when processing afterward fails.", async () => {
            const mailbox = await createMailbox();
            const folder = await createFolder(mailbox.uid);
            const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
            const sourceBlobKey = `mailbox-imports/${uuid.v4()}`;
            await blobStore.put(sourceBlobKey, buildMboxEntry(makeRawMessage(), "alice@example.com", new Date("2020-01-01")));
            // A stream that writes some real bytes (so `createWriteStream()` has already created and
            // started filling the temp file) before erroring, so `pipeline()` itself rejects - simulating a
            // dropped connection partway through a real `S3BlobStore.getStream()` download, as opposed to
            // `getStream()` itself rejecting up front (already covered by the "reading the source blob
            // throws" test elsewhere in this file, which never gets as far as creating a temp file at all).
            const { Readable } = await import("stream");
            vi.spyOn(blobStore, "getStream").mockImplementationOnce(async () => {
                return new Readable({
                    read() {
                        this.push(Buffer.from("partial content that will never be completed"));
                        process.nextTick(() => this.destroy(new Error("simulated connection drop mid-download")));
                    },
                });
            });
            const tempFilesBefore = (await fs.promises.readdir(os.tmpdir())).filter((f) => f.startsWith("mailbox-import-"));

            const request = await createRequest({ mailboxUid: mailbox.uid, targetFolderUid: folder.uid, format: "mbox", sourceBlobKey });
            await expect(job.run()).resolves.toBeUndefined();

            const updated = await requestRepo.findOne({ where: { uid: request.uid } });
            expect(updated!.status).toBe("failed");
            expect(updated!.errorMessage).toContain("simulated connection drop mid-download");
            // The partially-written temp file must not survive the failed download.
            const tempFilesAfter = (await fs.promises.readdir(os.tmpdir())).filter((f) => f.startsWith("mailbox-import-"));
            expect(tempFilesAfter.length).toBe(tempFilesBefore.length);
        });
    });

    it("Logs a warning and continues importing the rest when one message fails.", async () => {
        const mailbox = await createMailbox();
        const folder = await createFolder(mailbox.uid);
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const sourceBlobKey = `mailbox-imports/${uuid.v4()}`;
        const mbox = Buffer.concat([
            buildMboxEntry(makeRawMessage(), "alice@example.com", new Date("2020-01-01")),
            buildMboxEntry(makeRawMessage(), "bob@example.com", new Date("2020-01-02")),
        ]);
        await blobStore.put(sourceBlobKey, mbox);
        const request = await createRequest({ mailboxUid: mailbox.uid, targetFolderUid: folder.uid, format: "mbox", sourceBlobKey });

        const messageRepoUtils = (job as any).messageRepo;
        vi.spyOn(messageRepoUtils, "create").mockRejectedValueOnce(new Error("simulated failure"));

        await job.run();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("completed");
        expect(updated!.importedCount).toBe(1);
        expect(updated!.failedCount).toBe(1);
    });

    it("Skips the folder counter bump when the target folder was deleted mid-run (a race, not an error).", async () => {
        const mailbox = await createMailbox();
        const folder = await createFolder(mailbox.uid);
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const sourceBlobKey = `mailbox-imports/${uuid.v4()}`;
        await blobStore.put(sourceBlobKey, buildMboxEntry(makeRawMessage(), "alice@example.com", new Date("2020-01-01")));
        const request = await createRequest({ mailboxUid: mailbox.uid, targetFolderUid: folder.uid, format: "mbox", sourceBlobKey });

        const folderRepoUtils = (job as any).folderRepo;
        vi.spyOn(folderRepoUtils, "findOne")
            .mockResolvedValueOnce(folder) // processRequest()'s own initial existence check
            .mockResolvedValueOnce(undefined); // gone by the time the counter bump re-fetches it

        await job.run();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("completed");
        expect(updated!.importedCount).toBe(1);
    });

    it("Still reports the import as completed (not failed) when the folder counter update itself throws - e.g. a real version conflict against mail concurrently delivered into the same folder.", async () => {
        const mailbox = await createMailbox();
        const folder = await createFolder(mailbox.uid);
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const sourceBlobKey = `mailbox-imports/${uuid.v4()}`;
        await blobStore.put(sourceBlobKey, buildMboxEntry(makeRawMessage(), "alice@example.com", new Date("2020-01-01")));
        const request = await createRequest({ mailboxUid: mailbox.uid, targetFolderUid: folder.uid, format: "mbox", sourceBlobKey });

        const folderRepoUtils = (job as any).folderRepo;
        vi.spyOn(folderRepoUtils, "update").mockRejectedValueOnce(new Error("version conflict"));

        await job.run();

        // Every message was already durably persisted before the counter bump ran - a caller trusting a
        // "failed" status here would be invited to re-run the same import, duplicating every message.
        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("completed");
        expect(updated!.importedCount).toBe(1);
        const messages = await messageRepo.find({ where: { folderUid: folder.uid } });
        expect(messages.length).toBe(1);
    });

    it("Defaults subject/from-address to empty strings and an attachment's filename to 'attachment' when the message provides none.", async () => {
        const mailbox = await createMailbox();
        const folder = await createFolder(mailbox.uid);
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const sourceBlobKey = `mailbox-imports/${uuid.v4()}`;
        // No `Subject`/`From` header at all, and an attachment with no filename - mirrors
        // `ScanQueueJobSQL.test.ts`'s own identical "no filename" fixture.
        const raw = Buffer.from(
            [
                "To: recipient@example.com",
                "MIME-Version: 1.0",
                'Content-Type: multipart/mixed; boundary="BOUNDARY"',
                "",
                "--BOUNDARY",
                "Content-Type: text/plain; charset=utf-8",
                "",
                "Hello there.",
                "",
                "--BOUNDARY",
                "Content-Type: application/octet-stream",
                "Content-Disposition: attachment",
                "Content-Transfer-Encoding: base64",
                "",
                Buffer.from("no name attachment").toString("base64"),
                "",
                "--BOUNDARY--",
                "",
            ].join("\r\n"),
        );
        await blobStore.put(sourceBlobKey, buildMboxEntry(raw, "", new Date("2020-01-01")));
        const request = await createRequest({ mailboxUid: mailbox.uid, targetFolderUid: folder.uid, format: "mbox", sourceBlobKey });

        await job.run();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.importedCount).toBe(1);

        const messages = await messageRepo.find({ where: { folderUid: folder.uid } });
        expect(messages[0].subject).toBe("");
        expect(messages[0].from.address).toBe("");

        const attachments = await attachmentRepo.find({ where: { folderUid: folder.uid } });
        expect(attachments[0].filename).toBe("attachment");
    });

    it("Records an imported message's own To and Cc recipients, and the sender's display name alone.", async () => {
        const mailbox = await createMailbox();
        const folder = await createFolder(mailbox.uid);
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const sourceBlobKey = `mailbox-imports/${uuid.v4()}`;
        // An import has no SMTP envelope of its own - the message's own headers are the only record of who it
        // was addressed to, and every imported message used to be stored with none at all.
        const raw = Buffer.from(
            [
                'From: "Bob Allen" <bob@partner.test>',
                'To: "Nguyen, Carol" <carol@partner.test>, recipient@example.com',
                "Cc: Dave <dave@partner.test>",
                "Subject: Archived message",
                "",
                "Hello there.",
                "",
            ].join("\r\n"),
        );
        await blobStore.put(sourceBlobKey, buildMboxEntry(raw, "bob@partner.test", new Date("2020-01-01")));
        const request = await createRequest({ mailboxUid: mailbox.uid, targetFolderUid: folder.uid, format: "mbox", sourceBlobKey });

        await job.run();

        expect((await requestRepo.findOne({ where: { uid: request.uid } }))!.importedCount).toBe(1);
        const messages = await messageRepo.find({ where: { folderUid: folder.uid } });
        expect(messages[0].from).toEqual({ address: "bob@partner.test", displayName: "Bob Allen", type: RecipientType.TO });
        expect(messages[0].recipients).toEqual([
            { address: "carol@partner.test", displayName: "Nguyen, Carol", type: RecipientType.TO },
            { address: "recipient@example.com", type: RecipientType.TO },
            { address: "dave@partner.test", displayName: "Dave", type: RecipientType.CC },
        ]);
    });

    it("Stores a sanitized HTML blob for an imported message that has an HTML body.", async () => {
        const mailbox = await createMailbox();
        const folder = await createFolder(mailbox.uid);
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const sourceBlobKey = `mailbox-imports/${uuid.v4()}`;
        const htmlMessage = Buffer.from(
            ["From: sender@example.com", "To: recipient@example.com", "Subject: HTML message", "Content-Type: text/html", "", "<p>Hi</p>"].join(
                "\r\n",
            ),
        );
        await blobStore.put(sourceBlobKey, buildMboxEntry(htmlMessage, "sender@example.com", new Date("2020-01-01")));
        const request = await createRequest({ mailboxUid: mailbox.uid, targetFolderUid: folder.uid, format: "mbox", sourceBlobKey });

        await job.run();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.importedCount).toBe(1);

        const messages = await messageRepo.find({ where: { folderUid: folder.uid } });
        expect(messages[0].sanitizedHtmlBlobKey).toBeTruthy();
        const sanitized = await blobStore.get(messages[0].sanitizedHtmlBlobKey!);
        expect(sanitized.toString("utf-8")).toContain("Hi");
    });

    it("Marks the request failed via run()'s own outer catch when a lookup throws before the processing transition.", async () => {
        const mailbox = await createMailbox();
        const folder = await createFolder(mailbox.uid);
        const request = await createRequest({ mailboxUid: mailbox.uid, targetFolderUid: folder.uid, format: "mbox" });

        vi.spyOn((job as any).mailboxRepo, "findOne").mockRejectedValueOnce(new Error("simulated lookup failure"));

        await expect(job.run()).resolves.toBeUndefined();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("failed");
        expect(updated!.errorMessage).toBe("simulated lookup failure");
    });

    it("Logs an error and marks the request failed when reading the source blob throws.", async () => {
        const mailbox = await createMailbox();
        const folder = await createFolder(mailbox.uid);
        const request = await createRequest({
            mailboxUid: mailbox.uid,
            targetFolderUid: folder.uid,
            format: "mbox",
            sourceBlobKey: `mailbox-imports/${uuid.v4()}-does-not-exist`,
        });

        await expect(job.run()).resolves.toBeUndefined();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("failed");
    });

    it("Logs an error when even marking a request failed itself throws.", async () => {
        const request = await createRequest({ mailboxUid: uuid.v4() });
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

    const putMbox = async (entries: Buffer[]): Promise<string> => {
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const sourceBlobKey = `mailbox-imports/${uuid.v4()}`;
        await blobStore.put(sourceBlobKey, Buffer.concat(entries));
        return sourceBlobKey;
    };

    it("Skips (never imports as clean) a message whose AV scan errored, counting it as failed.", async () => {
        const mailbox = await createMailbox();
        const folder = await createFolder(mailbox.uid);
        const sourceBlobKey = await putMbox([
            buildMboxEntry(makeRawMessage({ extraHeader: "X-Test-Force-Av-Error: true" }), "eve@example.com", new Date("2020-01-01")),
            buildMboxEntry(makeRawMessage(), "bob@example.com", new Date("2020-01-02")),
        ]);
        const request = await createRequest({ mailboxUid: mailbox.uid, targetFolderUid: folder.uid, format: "mbox", sourceBlobKey });

        await job.run();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("completed");
        expect(updated!.importedCount).toBe(1);
        expect(updated!.failedCount).toBe(1);
        expect((await messageRepo.find({ where: { folderUid: folder.uid } })).length).toBe(1);
    });

    it("Stops the import with a clear quota error once the next message would exceed the mailbox quota, keeping what was already imported.", async () => {
        const raw = makeRawMessage();
        // Room for exactly one message (raw + its decoded attachment), not two.
        const mailbox = await mailboxRepo.save(
            new MailboxSQL({
                ownerUserUid: uuid.v4(),
                primarySmtpAddress: `${uuid.v4()}@example.com`,
                aliasAddresses: [],
                displayName: "Small Mailbox",
                timezone: "UTC",
                quotaBytes: 1_000 + raw.length * 2,
                usedBytes: 1_000,
            }),
        );
        const folder = await createFolder(mailbox.uid);
        const sourceBlobKey = await putMbox([
            buildMboxEntry(raw, "alice@example.com", new Date("2020-01-01")),
            buildMboxEntry(raw, "bob@example.com", new Date("2020-01-02")),
            buildMboxEntry(raw, "carol@example.com", new Date("2020-01-03")),
        ]);
        const request = await createRequest({ mailboxUid: mailbox.uid, targetFolderUid: folder.uid, format: "mbox", sourceBlobKey });

        await job.run();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("failed");
        expect(updated!.errorMessage).toContain("mailbox quota");
        expect(updated!.importedCount).toBe(1);
        expect((await messageRepo.find({ where: { folderUid: folder.uid } })).length).toBe(1);
        expect((await auditLogRepo.find({ where: { action: AuditAction.MAILBOX_IMPORT_FAILED } })).length).toBe(1);
        // The uploaded source blob is removed once this request is done being processed, quota-rejected or
        // not - otherwise every quota-rejected import would permanently orphan its uploaded file in storage.
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        expect(await blobStore.exists(sourceBlobKey)).toBe(false);
    });

    it("Translates the shared chargeMailboxQuota()'s MailboxQuotaExceededError into this job's own type/message when the AUTHORITATIVE charge catches it, not just assertWithinQuota()'s own cheap local pre-check.", async () => {
        const raw = makeRawMessage();
        const mailbox = await mailboxRepo.save(
            new MailboxSQL({
                ownerUserUid: uuid.v4(),
                primarySmtpAddress: `${uuid.v4()}@example.com`,
                aliasAddresses: [],
                displayName: "Tiny Mailbox",
                timezone: "UTC",
                quotaBytes: 1,
                usedBytes: 0,
            }),
        );
        const folder = await createFolder(mailbox.uid);
        const sourceBlobKey = await putMbox([buildMboxEntry(raw, "alice@example.com", new Date("2020-01-01"))]);
        const request = await createRequest({ mailboxUid: mailbox.uid, targetFolderUid: folder.uid, format: "mbox", sourceBlobKey });

        // Bypasses the job's own cheap local pre-check (assertWithinQuota(), against its in-memory ImportQuota
        // cache) so the real, authoritative chargeMailboxQuota() call - re-reading the persisted Mailbox row -
        // is what actually catches this, exercising chargeQuota()'s own catch-and-translate branch rather than
        // assertWithinQuota()'s separate throw of the same error type.
        vi.spyOn(job as any, "assertWithinQuota").mockImplementation(() => undefined);

        await job.run();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("failed");
        expect(updated!.errorMessage).toContain("mailbox quota");
        expect(updated!.importedCount).toBe(0);
    });

    it("Treats a quotaBytes of 0 as unlimited.", async () => {
        const mailbox = await mailboxRepo.save(
            new MailboxSQL({
                ownerUserUid: uuid.v4(),
                primarySmtpAddress: `${uuid.v4()}@example.com`,
                aliasAddresses: [],
                displayName: "Unlimited Mailbox",
                timezone: "UTC",
                quotaBytes: 0,
                usedBytes: 5_000_000,
            }),
        );
        const folder = await createFolder(mailbox.uid);
        const sourceBlobKey = await putMbox([buildMboxEntry(makeRawMessage(), "alice@example.com", new Date("2020-01-01"))]);
        const request = await createRequest({ mailboxUid: mailbox.uid, targetFolderUid: folder.uid, format: "mbox", sourceBlobKey });

        await job.run();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("completed");
        expect(updated!.importedCount).toBe(1);
    });

    it("Reclaims an abandoned 'processing' import and, on the retry, skips messages the dead attempt already persisted (by Message-ID).", async () => {
        const mailbox = await createMailbox();
        const folder = await createFolder(mailbox.uid);
        await messageRepo.save(
            new MessageSQL({
                mailboxUid: mailbox.uid,
                folderUid: folder.uid,
                messageId: "already-imported@example.com",
                subject: "Test message",
                from: { address: "sender@example.com", type: RecipientType.TO },
                recipients: [],
                sentDate: new Date("2020-01-01"),
                receivedDate: new Date("2020-01-01"),
                bodyBlobKey: `imported/${uuid.v4()}`,
                flags: { read: true, flagged: false, answered: false, forwarded: false },
                references: [],
                hasAttachments: false,
            }),
        );
        const sourceBlobKey = await putMbox([
            buildMboxEntry(makeRawMessage({ extraHeader: "Message-ID: <already-imported@example.com>" }), "alice@example.com", new Date("2020-01-01")),
            buildMboxEntry(makeRawMessage({ extraHeader: "Message-ID: <new@example.com>" }), "bob@example.com", new Date("2020-01-02")),
        ]);
        const request = await createRequest({
            mailboxUid: mailbox.uid,
            targetFolderUid: folder.uid,
            format: "mbox",
            sourceBlobKey,
            status: "processing",
            processingAttempts: 1,
            dateModified: new Date(Date.now() - 3 * 60 * 60_000),
        });

        await job.run();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("completed");
        expect(updated!.processingAttempts).toBe(2);
        expect(updated!.importedCount).toBe(2);
        expect((await messageRepo.find({ where: { folderUid: folder.uid, messageId: "already-imported@example.com" } })).length).toBe(1);
        expect((await messageRepo.find({ where: { folderUid: folder.uid, messageId: "new@example.com" } })).length).toBe(1);
    });

    it("Leaves a 'processing' import alone while its lease is still fresh, and fails one abandoned max_attempts times - deleting its uploaded source blob too, the one terminal outcome processRequest() itself never sees.", async () => {
        const fresh = await createRequest({ status: "processing", processingAttempts: 1 });
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const exhaustedSourceBlobKey = `mailbox-imports/${uuid.v4()}`;
        await blobStore.put(exhaustedSourceBlobKey, buildMboxEntry(makeRawMessage(), "alice@example.com", new Date("2020-01-01")));
        const exhausted = await createRequest({
            status: "processing",
            processingAttempts: 3,
            dateModified: new Date(Date.now() - 3 * 60 * 60_000),
            sourceBlobKey: exhaustedSourceBlobKey,
        });

        await job.run();

        const freshAfter = await requestRepo.findOne({ where: { uid: fresh.uid } });
        expect(freshAfter!.status).toBe("processing");
        expect(freshAfter!.version).toBe(fresh.version);
        const exhaustedAfter = await requestRepo.findOne({ where: { uid: exhausted.uid } });
        expect(exhaustedAfter!.status).toBe("failed");
        expect(exhaustedAfter!.errorMessage).toContain("did not complete after 3 attempt(s)");
        expect(await blobStore.exists(exhaustedSourceBlobKey)).toBe(false);
    });

    it("Still records a failed import's own outcome when deleting its uploaded source blob afterward itself fails - a cleanup failure is logged, never surfaced in place of the real result.", async () => {
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const sourceBlobKey = `mailbox-imports/${uuid.v4()}`;
        await blobStore.put(sourceBlobKey, buildMboxEntry(makeRawMessage(), "alice@example.com", new Date("2020-01-01")));
        const request = await createRequest({ mailboxUid: uuid.v4(), sourceBlobKey });
        const deleteSpy = vi.spyOn(blobStore, "delete").mockRejectedValue(new Error("simulated blob delete failure"));

        let deleteCalls: any[][];
        try {
            await job.run();
        } finally {
            deleteCalls = [...deleteSpy.mock.calls];
            deleteSpy.mockRestore();
        }

        expect(deleteCalls).toContainEqual([sourceBlobKey]);
        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("failed");
        expect(updated!.errorMessage).toContain("no longer exists");
    });

    it("Still marks an abandoned import failed after max_attempts when deleting its uploaded source blob itself fails - logged, not a reason to leave the request stuck 'processing'.", async () => {
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const sourceBlobKey = `mailbox-imports/${uuid.v4()}`;
        await blobStore.put(sourceBlobKey, buildMboxEntry(makeRawMessage(), "alice@example.com", new Date("2020-01-01")));
        const exhausted = await createRequest({
            status: "processing",
            processingAttempts: 3,
            dateModified: new Date(Date.now() - 3 * 60 * 60_000),
            sourceBlobKey,
        });
        const deleteSpy = vi.spyOn(blobStore, "delete").mockRejectedValue(new Error("simulated blob delete failure"));

        let deleteCalls: any[][];
        try {
            await job.run();
        } finally {
            deleteCalls = [...deleteSpy.mock.calls];
            deleteSpy.mockRestore();
        }

        expect(deleteCalls).toContainEqual([sourceBlobKey]);
        const updated = await requestRepo.findOne({ where: { uid: exhausted.uid } });
        expect(updated!.status).toBe("failed");
        expect(updated!.errorMessage).toContain("did not complete after 3 attempt(s)");
    });

    it("Aborts without completing when its lease is lost mid-import (another replica reclaimed the request).", async () => {
        const mailbox = await createMailbox();
        const folder = await createFolder(mailbox.uid);
        const sourceBlobKey = await putMbox([
            buildMboxEntry(makeRawMessage(), "alice@example.com", new Date("2020-01-01")),
            buildMboxEntry(makeRawMessage(), "bob@example.com", new Date("2020-01-02")),
        ]);
        const request = await createRequest({ mailboxUid: mailbox.uid, targetFolderUid: folder.uid, format: "mbox", sourceBlobKey });
        const realPersist = (job as any).persistImportedMessage.bind(job);
        vi.spyOn(job as any, "persistImportedMessage").mockImplementationOnce(async (...args: any[]) => {
            const result = await realPersist(...args);
            // Simulates another replica reclaiming the request while this run was still importing.
            const current = (await requestRepo.findOne({ where: { uid: request.uid } }))!;
            await requestRepo.update({ uid: request.uid }, { version: current.version + 1, status: "pending" });
            return result;
        });

        // A 0-minute lease makes every per-message renewal due, so the second message's renewal hits the conflict.
        await withJobField("leaseMinutes", 0, async () => {
            await (job as any).processRequest(request);
        });

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("pending");
        expect((await messageRepo.find({ where: { folderUid: folder.uid } })).length).toBe(1);
    });

    const importTwoMessages = async (): Promise<{ mailbox: any; folder: any; request: any }> => {
        const mailbox = await createMailbox();
        const folder = await createFolder(mailbox.uid);
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const sourceBlobKey = `mailbox-imports/${uuid.v4()}`;
        await blobStore.put(
            sourceBlobKey,
            Buffer.concat([
                buildMboxEntry(makeRawMessage(), "alice@example.com", new Date("2020-01-01")),
                buildMboxEntry(makeRawMessage(), "bob@example.com", new Date("2020-01-02")),
            ]),
        );
        const request = await createRequest({ mailboxUid: mailbox.uid, targetFolderUid: folder.uid, format: "mbox", sourceBlobKey });
        return { mailbox, folder, request };
    };

    const storedBytes = async (folderUid: string): Promise<number> => {
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        let total = 0;
        for (const message of await messageRepo.find({ where: { folderUid: folderUid } })) {
            total += await blobStore.size(message.bodyBlobKey);
        }
        for (const attachment of await attachmentRepo.find({ where: { folderUid: folderUid } })) {
            total += attachment.sizeBytes;
        }
        return total;
    };

    it("Persists each imported message's size to Mailbox.usedBytes (not just in memory).", async () => {
        const { mailbox, folder } = await importTwoMessages();

        await job.run();

        const updated = (await mailboxRepo.findOne({ where: { uid: mailbox.uid } }));
        const expected = await storedBytes(folder.uid);
        expect(expected).toBeGreaterThan(0);
        expect(Number(updated!.usedBytes)).toBe(expected);
        expect(updated!.version).toBe(mailbox.version + 2);
    });

    it("Does not clobber a concurrent usedBytes change made mid-import (version-checked charge, retried on conflict).", async () => {
        const { mailbox, folder } = await importTwoMessages();
        const messageRepoUtils = (job as any).messageRepo;
        const realCreate = messageRepoUtils.create.bind(messageRepoUtils);
        vi.spyOn(messageRepoUtils, "create").mockImplementationOnce(async (...args: any[]) => {
            // e.g. concurrent delivery or another import charging the same mailbox after this run's first charge.
            const current = (await mailboxRepo.findOne({ where: { uid: mailbox.uid } }))!;
            await mailboxRepo.update({ uid: mailbox.uid }, { version: current.version + 1, usedBytes: Number(current.usedBytes) + 777 });
            return await realCreate(...args);
        });

        await job.run();

        const updated = (await mailboxRepo.findOne({ where: { uid: mailbox.uid } }));
        expect(Number(updated!.usedBytes)).toBe(777 + (await storedBytes(folder.uid)));
    });

    it("Refunds the quota charge of a message that failed to store.", async () => {
        const { mailbox, folder, request } = await importTwoMessages();
        const messageRepoUtils = (job as any).messageRepo;
        vi.spyOn(messageRepoUtils, "create").mockRejectedValueOnce(new Error("simulated failure"));

        await job.run();

        const updatedRequest = (await requestRepo.findOne({ where: { uid: request.uid } }));
        expect(updatedRequest!.importedCount).toBe(1);
        expect(updatedRequest!.failedCount).toBe(1);
        const updated = (await mailboxRepo.findOne({ where: { uid: mailbox.uid } }));
        expect(Number(updated!.usedBytes)).toBe(await storedBytes(folder.uid));
    });

    it("On a reclaimed retry, still dedups a message whose Message-ID is over 255 characters (stored bounded as sha256:<hex>).", async () => {
        const mailbox = await createMailbox();
        const folder = await createFolder(mailbox.uid);
        const longId = `${"x".repeat(300)}@example.com`;
        await messageRepo.save(
            new MessageSQL({
                mailboxUid: mailbox.uid,
                folderUid: folder.uid,
                messageId: longId,
                subject: "Test message",
                from: { address: "sender@example.com", type: RecipientType.TO },
                recipients: [],
                sentDate: new Date("2020-01-01"),
                receivedDate: new Date("2020-01-01"),
                bodyBlobKey: `imported/${uuid.v4()}`,
                flags: { read: true, flagged: false, answered: false, forwarded: false },
                references: [],
                hasAttachments: false,
            }),
        );
        const sourceBlobKey = await putMbox([
            buildMboxEntry(makeRawMessage({ extraHeader: `Message-ID: <${longId}>` }), "alice@example.com", new Date("2020-01-01")),
        ]);
        const request = await createRequest({
            mailboxUid: mailbox.uid,
            targetFolderUid: folder.uid,
            format: "mbox",
            sourceBlobKey,
            status: "processing",
            processingAttempts: 1,
            dateModified: new Date(Date.now() - 3 * 60 * 60_000),
        });

        await job.run();

        const updated = await requestRepo.findOne({ where: { uid: request.uid } });
        expect(updated!.status).toBe("completed");
        expect(updated!.importedCount).toBe(1);
        const messages = await messageRepo.find({ where: { folderUid: folder.uid } });
        expect(messages.length).toBe(1);
        expect(messages[0].messageId).toMatch(/^sha256:[0-9a-f]{64}$/);
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
