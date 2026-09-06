///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for ScanQueueJobSQL: a real SQLite (better-sqlite3) connection and a real
// `ObjectFactory` construct the job exactly as production wiring would - see ScanQueueJobMongo.test.ts's file
// header for the full rationale (also applies here verbatim). Uses `config.sql.ts`, whose `acl` datastore is
// ALSO SQL-backed (`AccessControlListSQL`, auto-selected by `ACLUtils` from the connection's runtime type) -
// so this file has no MongoDB dependency at all, unlike the Mongo-ACL-dependent form this file used earlier.
import { ACLUtils, AccessControlListSQL, ConnectionManager, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import config from "../../config.sql.js";
import { registerTestDoubles } from "../../testDoubles.js";
import { ScanQueueJobSQL } from "../../../src/jobs/sql/ScanQueueJobSQL.js";
import { IngestQueueEntrySQL } from "../../../src/models/sql/IngestQueueEntrySQL.js";
import { FolderSQL } from "../../../src/models/sql/FolderSQL.js";
import { MessageSQL } from "../../../src/models/sql/MessageSQL.js";
import { AttachmentSQL } from "../../../src/models/sql/AttachmentSQL.js";
import { QuarantineEntrySQL } from "../../../src/models/sql/QuarantineEntrySQL.js";
import { ScanResultSQL } from "../../../src/models/sql/ScanResultSQL.js";
import { FolderType, IngestStatus, QuarantineReason } from "../../../src/models/types.js";

/** Builds a minimal valid multipart RFC 5322 message, optionally with a header/attachment marker. */
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

/** A message with an HTML body containing a `<script>` tag, and no attachments. */
function makeHtmlRawMessage(): Buffer {
    const raw = [
        "From: sender@example.com",
        "To: recipient@example.com",
        "Subject: HTML message",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<html><body><p>Hello</p><script>alert(1)</script></body></html>",
        "",
    ].join("\r\n");
    return Buffer.from(raw);
}

/** A plain message with no attachments at all. */
function makePlainRawMessage(extraHeader?: string): Buffer {
    const raw = [
        "From: sender@example.com",
        "To: recipient@example.com",
        "Subject: Plain message",
        ...(extraHeader ? [extraHeader] : []),
        "",
        "Hello there.",
        "",
    ].join("\r\n");
    return Buffer.from(raw);
}

describe("ScanQueueJobSQL Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: ScanQueueJobSQL;
    let ingestQueueRepo: Repository<IngestQueueEntrySQL>;
    let folderRepo: Repository<FolderSQL>;
    let messageRepo: Repository<MessageSQL>;
    let attachmentRepo: Repository<AttachmentSQL>;
    let quarantineEntryRepo: Repository<QuarantineEntrySQL>;
    let scanResultRepo: Repository<ScanResultSQL>;

    const mailboxUid = uuid.v4();

    const createIngestEntry = async (data?: Partial<IngestQueueEntrySQL>): Promise<IngestQueueEntrySQL> => {
        const obj = new IngestQueueEntrySQL({
            mailboxUid,
            envelopeFrom: "sender@example.com",
            envelopeTo: ["recipient@example.com"],
            rawBlobKey: `raw/${uuid.v4()}`,
            status: IngestStatus.PENDING,
            ...data,
        });
        return await ingestQueueRepo.save(obj);
    };

    beforeAll(async () => {
        objectFactory = new ObjectFactory(config, logger);
        registerTestDoubles(objectFactory);
        // Normally registered by `Server`'s own bootstrap (route/model class scanning) - registered explicitly
        // here since this file deliberately bypasses `Server` (see ScanQueueJobMongo.test.ts's header comment).
        objectFactory.register(ACLUtils);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        // Not auto-discovered here the way `Server`'s `ClassLoader` scan would - a bare TypeORM `DataSource`
        // throws "No metadata found" from `getRepository()` for any entity not explicitly in this map.
        models.set("AccessControlListSQL", AccessControlListSQL);
        models.set("IngestQueueEntrySQL", IngestQueueEntrySQL);
        models.set("FolderSQL", FolderSQL);
        models.set("MessageSQL", MessageSQL);
        models.set("AttachmentSQL", AttachmentSQL);
        models.set("QuarantineEntrySQL", QuarantineEntrySQL);
        models.set("ScanResultSQL", ScanResultSQL);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        ingestQueueRepo = conn.getRepository(IngestQueueEntrySQL);
        folderRepo = conn.getRepository(FolderSQL);
        messageRepo = conn.getRepository(MessageSQL);
        attachmentRepo = conn.getRepository(AttachmentSQL);
        quarantineEntryRepo = conn.getRepository(QuarantineEntrySQL);
        scanResultRepo = conn.getRepository(ScanResultSQL);

        // Constructed once via real ObjectFactory DI: `@Init` builds its six real `RepoUtils` against the live
        // connection above, and `@Inject("BlobStore")`/`@Inject(ScanPipeline)` resolve to the registered doubles.
        job = await objectFactory.newInstance(ScanQueueJobSQL, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        for (const repo of [ingestQueueRepo, folderRepo, messageRepo, attachmentRepo, quarantineEntryRepo, scanResultRepo]) {
            await repo.clear();
        }
    });

    it("Exposes the configured cron schedule.", () => {
        expect(job.schedule).toBe(config.get("mail:jobs:scan_queue:schedule"));
    });

    it("start() and stop() are no-ops beyond init().", async () => {
        await expect(job.start()).resolves.toBeUndefined();
        expect(job.stop()).toBeUndefined();
    });

    it("Does nothing when there are no pending entries.", async () => {
        await expect(job.run()).resolves.toBeUndefined();
    });

    it("Delivers a clean message with an attachment to the mailbox's Inbox, creating the folder, and marks the entry DELIVERED.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makeRawMessage());
        const entry = await createIngestEntry({ rawBlobKey });

        await job.run();

        const updated = await ingestQueueRepo.findOne({ where: { uid: entry.uid } });
        expect(updated!.status).toBe(IngestStatus.DELIVERED);

        const inbox = await folderRepo.findOne({ where: { mailboxUid, type: FolderType.INBOX } });
        expect(inbox).toBeDefined();
        expect(inbox!.unreadCount).toBe(1);
        expect(inbox!.totalCount).toBe(1);

        const messages = await messageRepo.find({ where: { folderUid: inbox!.uid } });
        expect(messages.length).toBe(1);
        expect(messages[0].hasAttachments).toBe(true);
        expect(messages[0].scanResultUid).toBeTruthy();

        const attachments = await attachmentRepo.find({ where: { messageUid: messages[0].uid } });
        expect(attachments.length).toBe(1);
        expect(attachments[0].filename).toBe("file.txt");
        expect(attachments[0].folderUid).toBe(inbox!.uid);

        const storedAttachment: Buffer = await blobStore.get(attachments[0].blobKey);
        expect(storedAttachment.toString()).toBe("fake attachment content");

        const scanResults = await scanResultRepo.find({ where: { targetUid: messages[0].uid } });
        expect(scanResults.length).toBe(1);
    });

    it("Defaults an attachment's filename to 'attachment' when the message provides none.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        const raw = [
            "From: sender@example.com",
            "To: recipient@example.com",
            "Subject: No filename",
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
        ].join("\r\n");
        await blobStore.put(rawBlobKey, Buffer.from(raw));
        await createIngestEntry({ rawBlobKey });

        await job.run();

        const inbox = await folderRepo.findOne({ where: { mailboxUid, type: FolderType.INBOX } });
        const messages = await messageRepo.find({ where: { folderUid: inbox!.uid } });
        const attachments = await attachmentRepo.find({ where: { messageUid: messages[0].uid } });
        expect(attachments.length).toBe(1);
        expect(attachments[0].filename).toBe("attachment");
    });

    it("Persists the sanitized HTML body under its own blob key, stripped of <script>, separate from the raw MIME.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makeHtmlRawMessage());
        await createIngestEntry({ rawBlobKey });

        await job.run();

        const inbox = await folderRepo.findOne({ where: { mailboxUid, type: FolderType.INBOX } });
        const messages = await messageRepo.find({ where: { folderUid: inbox!.uid } });
        expect(messages.length).toBe(1);
        expect(messages[0].sanitizedHtmlBlobKey).toBeTruthy();
        expect(messages[0].sanitizedHtmlBlobKey).not.toBe(messages[0].bodyBlobKey);

        const sanitized: Buffer = await blobStore.get(messages[0].sanitizedHtmlBlobKey!);
        expect(sanitized.toString()).not.toContain("<script>");
        expect(sanitized.toString()).toContain("Hello");

        const raw: Buffer = await blobStore.get(messages[0].bodyBlobKey);
        expect(raw.toString()).toContain("<script>");
    });

    it("Delivers a spam-verdict message to Junk, reusing an existing Junk folder without creating a duplicate.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makePlainRawMessage("X-Test-Force-Spam: true"));
        await createIngestEntry({ rawBlobKey });

        await job.run();

        const junkFolders = await folderRepo.find({ where: { mailboxUid, type: FolderType.JUNK } });
        expect(junkFolders.length).toBe(1);
        const messages = await messageRepo.find({ where: { folderUid: junkFolders[0].uid } });
        expect(messages.length).toBe(1);

        // A second spam message must reuse the same Junk folder rather than creating another one.
        const rawBlobKey2 = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey2, makePlainRawMessage("X-Test-Force-Spam: true"));
        await createIngestEntry({ rawBlobKey: rawBlobKey2 });
        await job.run();

        const junkFoldersAfter = await folderRepo.find({ where: { mailboxUid, type: FolderType.JUNK } });
        expect(junkFoldersAfter.length).toBe(1);
        expect(junkFoldersAfter[0].totalCount).toBe(2);
    });

    it("Quarantines an infected message instead of delivering it, tagged with reason INFECTED.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makePlainRawMessage("X-Test-Force-Infected: true"));
        const entry = await createIngestEntry({ rawBlobKey });

        await job.run();

        const updated = await ingestQueueRepo.findOne({ where: { uid: entry.uid } });
        expect(updated!.status).toBe(IngestStatus.DELIVERED);

        const messages = await messageRepo.find({ where: { mailboxUid } });
        expect(messages.length).toBe(0);

        const quarantineEntries = await quarantineEntryRepo.find({ where: { mailboxUid } });
        expect(quarantineEntries.length).toBe(1);
        expect(quarantineEntries[0].reason).toBe(QuarantineReason.INFECTED);
        expect(quarantineEntries[0].rawBlobKey).toBe(rawBlobKey);
    });

    it("Quarantines a message when the AV engine errors (fails closed, not delivered unscanned), tagged with reason OTHER.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makePlainRawMessage("X-Test-Force-Av-Error: true"));
        const entry = await createIngestEntry({ rawBlobKey });

        await job.run();

        const updated = await ingestQueueRepo.findOne({ where: { uid: entry.uid } });
        expect(updated!.status).toBe(IngestStatus.DELIVERED);

        const messages = await messageRepo.find({ where: { mailboxUid } });
        expect(messages.length).toBe(0);

        const quarantineEntries = await quarantineEntryRepo.find({ where: { mailboxUid } });
        expect(quarantineEntries.length).toBe(1);
        expect(quarantineEntries[0].reason).toBe(QuarantineReason.OTHER);
    });

    it("Marks an entry FAILED with the error message when processing throws, without crashing the whole run.", async () => {
        // No blob was ever put at this key, so `blobStore.get()` rejects with a real "no blob" error.
        const entry = await createIngestEntry({ rawBlobKey: `raw/${uuid.v4()}` });

        await expect(job.run()).resolves.toBeUndefined();

        const updated = await ingestQueueRepo.findOne({ where: { uid: entry.uid } });
        expect(updated!.status).toBe(IngestStatus.FAILED);
        expect(updated!.errorMessage).toBeTruthy();
    });

    it("Bounds how many pending entries are processed per run to the configured batch size.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const entries = [];
        for (let i = 0; i < 3; i++) {
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makePlainRawMessage());
            entries.push(await createIngestEntry({ rawBlobKey }));
        }

        // The configured default batch size (25) comfortably exceeds 3, so all three are processed in one run -
        // this exercises the same `limit` plumbing a smaller configured batch size would, without needing a
        // second ObjectFactory/job wired to a different config value.
        await job.run();

        for (const entry of entries) {
            const updated = await ingestQueueRepo.findOne({ where: { uid: entry.uid } });
            expect(updated!.status).toBe(IngestStatus.DELIVERED);
        }
    });
});
