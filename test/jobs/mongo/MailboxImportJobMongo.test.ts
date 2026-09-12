///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for MailboxImportJobMongo - see DataExportJobMongo.test.ts's/
// QuarantineRetentionJobMongo.test.ts's file headers for the full rationale (bypasses `Server`, wires a
// real ObjectFactory/ConnectionManager directly).
import * as fs from "fs";
import * as path from "path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ACLUtils, ConnectionManager, MongoConnection, MongoRepository, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../../config.js";
import { MailboxImportJobMongo } from "../../../src/jobs/mongo/MailboxImportJobMongo.js";
import { AttachmentMongo } from "../../../src/models/mongo/AttachmentMongo.js";
import { AuditLogEntryMongo } from "../../../src/models/mongo/AuditLogEntryMongo.js";
import { FolderMongo } from "../../../src/models/mongo/FolderMongo.js";
import { MailboxImportRequestMongo } from "../../../src/models/mongo/MailboxImportRequestMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { MessageMongo } from "../../../src/models/mongo/MessageMongo.js";
import { AuditAction } from "../../../src/models/types.js";
import { buildMboxEntry } from "../../../src/util/MboxUtils.js";
import { InMemoryBlobStore, registerTestDoubles } from "../../testDoubles.js";

const PST_FIXTURE_PATH = path.join(process.cwd(), "node_modules/pst-extractor/example/testdata/enron.pst");

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

/** Builds a minimal valid multipart RFC 5322 message, optionally with a header/attachment marker - mirrors
 * `ScanQueueJobMongo.test.ts`'s own identical helper. */
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

describe("MailboxImportJobMongo Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: MailboxImportJobMongo;
    let requestRepo: MongoRepository<MailboxImportRequestMongo>;
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let folderRepo: MongoRepository<FolderMongo>;
    let messageRepo: MongoRepository<MessageMongo>;
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

    const createFolder = async (mailboxUid: string): Promise<FolderMongo> => await folderRepo.save(new FolderMongo({ mailboxUid, name: "Imported" }));

    const createRequest = async (data: Partial<MailboxImportRequestMongo>): Promise<MailboxImportRequestMongo> =>
        await requestRepo.save(
            new MailboxImportRequestMongo({
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
        await mongod.start();
        objectFactory = new ObjectFactory(config, logger);
        objectFactory.register(ACLUtils);
        registerTestDoubles(objectFactory);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("MailboxImportRequestMongo", MailboxImportRequestMongo);
        models.set("MailboxMongo", MailboxMongo);
        models.set("FolderMongo", FolderMongo);
        models.set("MessageMongo", MessageMongo);
        models.set("AttachmentMongo", AttachmentMongo);
        models.set("AuditLogEntryMongo", AuditLogEntryMongo);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        requestRepo = conn.getMongoRepository("MailboxImportRequestMongo");
        mailboxRepo = conn.getMongoRepository("MailboxMongo");
        folderRepo = conn.getMongoRepository("FolderMongo");
        messageRepo = conn.getMongoRepository("MessageMongo");
        attachmentRepo = conn.getMongoRepository("AttachmentMongo");
        auditLogRepo = conn.getMongoRepository("AuditLogEntryMongo");

        job = await objectFactory.newInstance(MailboxImportJobMongo, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
        await mongod.stop();
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

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        expect(updated!.status).toBe("failed");
        expect(updated!.errorMessage).toContain("no longer exists");

        const entries = await auditLogRepo.find({ action: AuditAction.MAILBOX_IMPORT_FAILED }).toArray();
        expect(entries.length).toBe(1);
    });

    it("Marks a request failed when its target folder no longer exists.", async () => {
        const mailbox = await createMailbox();
        const request = await createRequest({ mailboxUid: mailbox.uid, targetFolderUid: uuid.v4() });

        await job.run();

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        expect(updated!.status).toBe("failed");
        expect(updated!.errorMessage).toContain("no longer exists");
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

        await job.run();

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        expect(updated!.status).toBe("completed");
        expect(updated!.importedCount).toBe(2);
        expect(updated!.failedCount).toBe(0);

        const messages = await messageRepo.find({ folderUid: folder.uid }).toArray();
        expect(messages.length).toBe(2);
        expect(messages.every((m) => m.mailboxUid === mailbox.uid)).toBe(true);
        expect(messages.every((m) => m.flags.read === true)).toBe(true);

        const attachments = await attachmentRepo.find({ folderUid: folder.uid }).toArray();
        expect(attachments.length).toBe(2);
        expect(attachments[0].filename).toBe("file.txt");

        const updatedFolder = await folderRepo.findOne({ uid: folder.uid } as any);
        expect(updatedFolder!.totalCount).toBe(2);
        expect(updatedFolder!.syncKeyVersion).toBe(1);

        const entries = await auditLogRepo.find({ action: AuditAction.MAILBOX_IMPORT_COMPLETED }).toArray();
        expect(entries.length).toBe(1);
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

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        expect(updated!.status).toBe("completed");
        expect(updated!.importedCount).toBe(1);
        expect(updated!.failedCount).toBe(1);

        const messages = await messageRepo.find({ folderUid: folder.uid }).toArray();
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

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        expect(updated!.importedCount).toBe(0);
        expect(updated!.failedCount).toBe(1);

        const messages = await messageRepo.find({ folderUid: folder.uid }).toArray();
        expect(messages.length).toBe(0);

        const attachments = await attachmentRepo.find({ folderUid: folder.uid }).toArray();
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

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        expect(updated!.status).toBe("completed");
        expect(updated!.importedCount).toBe(71);
        expect(updated!.failedCount).toBe(0);

        const messages = await messageRepo.find({ folderUid: folder.uid }).toArray();
        expect(messages.length).toBe(71);

        const attachments = await attachmentRepo.find({ folderUid: folder.uid }).toArray();
        expect(attachments.length).toBeGreaterThan(0);
    }, 30000);

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

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
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

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        expect(updated!.status).toBe("completed");
        expect(updated!.importedCount).toBe(1);
    });

    it("Defaults subject/from-address to empty strings and an attachment's filename to 'attachment' when the message provides none.", async () => {
        const mailbox = await createMailbox();
        const folder = await createFolder(mailbox.uid);
        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const sourceBlobKey = `mailbox-imports/${uuid.v4()}`;
        // No `Subject`/`From` header at all, and an attachment with no filename - mirrors
        // `ScanQueueJobMongo.test.ts`'s own identical "no filename" fixture.
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

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        expect(updated!.importedCount).toBe(1);

        const messages = await messageRepo.find({ folderUid: folder.uid }).toArray();
        expect(messages[0].subject).toBe("");
        expect(messages[0].from.address).toBe("");

        const attachments = await attachmentRepo.find({ folderUid: folder.uid }).toArray();
        expect(attachments[0].filename).toBe("attachment");
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

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        expect(updated!.importedCount).toBe(1);

        const messages = await messageRepo.find({ folderUid: folder.uid }).toArray();
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

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
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

        const updated = await requestRepo.findOne({ uid: request.uid } as any);
        expect(updated!.status).toBe("failed");
    });

    it("Logs an error when even marking a request failed itself throws.", async () => {
        const request = await createRequest({ mailboxUid: uuid.v4() });
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
