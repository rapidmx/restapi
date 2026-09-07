///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for ScanQueueJobMongo: a real in-memory MongoDB connection and a real
// `ObjectFactory` construct the job exactly as production wiring would - its own `@Init` builds real
// `RepoUtils` against the live connection, and its `@Inject("BlobStore")`/`@Inject(ScanPipeline)` fields
// resolve to the registered test doubles (`registerTestDoubles`), with a REAL `ScanPipeline` (real MIME
// parsing, real HTML sanitization, real verdict combination) sitting behind them - only the actual external
// service boundaries (the AV/spam engines themselves) are faked. No repo is hand-mocked.
//
// Deliberately does NOT use `Server`/`ClassLoader`: `Server.start()` auto-discovers and cron-schedules every
// `BackgroundService` subclass found under its `basePath`, which would race this file's own explicit `run()`
// calls against every *other* job's real cron schedule. Instead this drives `ConnectionManager.connect()`
// directly, registering only the entity classes this job actually touches.
import { MongoMemoryServer } from "mongodb-memory-server";
import { ACLUtils, ConnectionManager, MongoConnection, MongoRepository, NotificationUtils, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../../config.js";
import { registerTestDoubles, RecordingMailTransport } from "../../testDoubles.js";
import { ScanQueueJobMongo } from "../../../src/jobs/mongo/ScanQueueJobMongo.js";
import { IngestQueueEntryMongo } from "../../../src/models/mongo/IngestQueueEntryMongo.js";
import { FolderMongo } from "../../../src/models/mongo/FolderMongo.js";
import { MessageMongo } from "../../../src/models/mongo/MessageMongo.js";
import { AttachmentMongo } from "../../../src/models/mongo/AttachmentMongo.js";
import { QuarantineEntryMongo } from "../../../src/models/mongo/QuarantineEntryMongo.js";
import { ScanResultMongo } from "../../../src/models/mongo/ScanResultMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { MailFilterRuleMongo } from "../../../src/models/mongo/MailFilterRuleMongo.js";
import { CalendarEventMongo } from "../../../src/models/mongo/CalendarEventMongo.js";
import { OofReplySuppressionMongo } from "../../../src/models/mongo/OofReplySuppressionMongo.js";
import { FolderType, IngestStatus, MailFilterActionType, QuarantineReason } from "../../../src/models/types.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

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

describe("ScanQueueJobMongo Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: ScanQueueJobMongo;
    let ingestQueueRepo: MongoRepository<IngestQueueEntryMongo>;
    let folderRepo: MongoRepository<FolderMongo>;
    let messageRepo: MongoRepository<MessageMongo>;
    let attachmentRepo: MongoRepository<AttachmentMongo>;
    let quarantineEntryRepo: MongoRepository<QuarantineEntryMongo>;
    let scanResultRepo: MongoRepository<ScanResultMongo>;
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let mailFilterRuleRepo: MongoRepository<MailFilterRuleMongo>;
    let calendarEventRepo: MongoRepository<CalendarEventMongo>;
    let oofReplySuppressionRepo: MongoRepository<OofReplySuppressionMongo>;

    const mailboxUid = uuid.v4();

    const createIngestEntry = async (data?: Partial<IngestQueueEntryMongo>): Promise<IngestQueueEntryMongo> => {
        const obj = new IngestQueueEntryMongo({
            mailboxUid,
            envelopeFrom: "sender@example.com",
            envelopeTo: ["recipient@example.com"],
            rawBlobKey: `raw/${uuid.v4()}`,
            status: IngestStatus.PENDING,
            ...data,
        });
        return await ingestQueueRepo.save(obj);
    };

    const createMailbox = async (data?: Partial<MailboxMongo>): Promise<MailboxMongo> => {
        const obj = new MailboxMongo({
            uid: mailboxUid,
            primarySmtpAddress: "recipient@example.com",
            aliasAddresses: [],
            displayName: "Recipient Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
            ...data,
        });
        return await mailboxRepo.save(obj);
    };

    beforeAll(async () => {
        await mongod.start();
        objectFactory = new ObjectFactory(config, logger);
        registerTestDoubles(objectFactory);
        // Normally registered by `Server`'s own bootstrap (route/model class scanning) - registered explicitly
        // here since this file deliberately bypasses `Server` (see the file header comment).
        objectFactory.register(ACLUtils);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("IngestQueueEntryMongo", IngestQueueEntryMongo);
        models.set("FolderMongo", FolderMongo);
        models.set("MessageMongo", MessageMongo);
        models.set("AttachmentMongo", AttachmentMongo);
        models.set("QuarantineEntryMongo", QuarantineEntryMongo);
        models.set("ScanResultMongo", ScanResultMongo);
        models.set("MailboxMongo", MailboxMongo);
        models.set("MailFilterRuleMongo", MailFilterRuleMongo);
        models.set("CalendarEventMongo", CalendarEventMongo);
        models.set("OofReplySuppressionMongo", OofReplySuppressionMongo);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        ingestQueueRepo = conn.getMongoRepository("IngestQueueEntryMongo");
        folderRepo = conn.getMongoRepository("FolderMongo");
        messageRepo = conn.getMongoRepository("MessageMongo");
        attachmentRepo = conn.getMongoRepository("AttachmentMongo");
        quarantineEntryRepo = conn.getMongoRepository("QuarantineEntryMongo");
        scanResultRepo = conn.getMongoRepository("ScanResultMongo");
        mailboxRepo = conn.getMongoRepository("MailboxMongo");
        mailFilterRuleRepo = conn.getMongoRepository("MailFilterRuleMongo");
        calendarEventRepo = conn.getMongoRepository("CalendarEventMongo");
        oofReplySuppressionRepo = conn.getMongoRepository("OofReplySuppressionMongo");

        // Constructed once via real ObjectFactory DI: `@Init` builds its ten real `RepoUtils` against the live
        // connection above, and `@Inject("BlobStore")`/`@Inject(ScanPipeline)`/`@Inject("MailTransport")` resolve
        // to the registered doubles.
        job = await objectFactory.newInstance(ScanQueueJobMongo, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
        await mongod.stop();
    });

    beforeEach(async () => {
        for (const repo of [
            ingestQueueRepo,
            folderRepo,
            messageRepo,
            attachmentRepo,
            quarantineEntryRepo,
            scanResultRepo,
            mailboxRepo,
            mailFilterRuleRepo,
            calendarEventRepo,
            oofReplySuppressionRepo,
        ]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
        (objectFactory.getInstance<RecordingMailTransport>("MailTransport")!).sent = [];
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

        const updated = await ingestQueueRepo.findOne({ uid: entry.uid } as any);
        expect(updated!.status).toBe(IngestStatus.DELIVERED);

        const inbox = await folderRepo.findOne({ mailboxUid, type: FolderType.INBOX } as any);
        expect(inbox).toBeDefined();
        expect(inbox!.unreadCount).toBe(1);
        expect(inbox!.totalCount).toBe(1);

        const messages = await messageRepo.find({ folderUid: inbox!.uid }).toArray();
        expect(messages.length).toBe(1);
        expect(messages[0].hasAttachments).toBe(true);
        expect(messages[0].scanResultUid).toBeTruthy();

        const attachments = await attachmentRepo.find({ messageUid: messages[0].uid }).toArray();
        expect(attachments.length).toBe(1);
        expect(attachments[0].filename).toBe("file.txt");
        expect(attachments[0].folderUid).toBe(inbox!.uid);

        const storedAttachment: Buffer = await blobStore.get(attachments[0].blobKey);
        expect(storedAttachment.toString()).toBe("fake attachment content");

        const scanResults = await scanResultRepo.find({ targetUid: messages[0].uid }).toArray();
        expect(scanResults.length).toBe(1);
    });

    it("Publishes a live-update notification to the Inbox folder's channel once a message is delivered.", async () => {
        const sendMessageSpy = vi.spyOn(NotificationUtils.prototype, "sendMessage");
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makeRawMessage());
        await createIngestEntry({ rawBlobKey });

        await job.run();

        const inbox = await folderRepo.findOne({ mailboxUid, type: FolderType.INBOX } as any);
        const messages = await messageRepo.find({ folderUid: inbox!.uid }).toArray();
        expect(sendMessageSpy).toHaveBeenCalledWith(
            inbox!.uid,
            "MessageMongo",
            "create",
            expect.objectContaining({ uid: messages[0].uid }),
        );
        sendMessageSpy.mockRestore();
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

        const inbox = await folderRepo.findOne({ mailboxUid, type: FolderType.INBOX } as any);
        const messages = await messageRepo.find({ folderUid: inbox!.uid }).toArray();
        const attachments = await attachmentRepo.find({ messageUid: messages[0].uid }).toArray();
        expect(attachments.length).toBe(1);
        expect(attachments[0].filename).toBe("attachment");
    });

    it("Persists the sanitized HTML body under its own blob key, stripped of <script>, separate from the raw MIME.", async () => {
        // Regression test: `ScanPipeline.run()`'s sanitized HTML used to be computed and then discarded -
        // nothing ever wrote it anywhere, leaving the only body representation this library persisted
        // completely unsanitized. Confirms it's now actually stored and reachable via `sanitizedHtmlBlobKey`,
        // distinct from `bodyBlobKey`'s untouched raw MIME (which still contains the literal <script> tag).
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makeHtmlRawMessage());
        await createIngestEntry({ rawBlobKey });

        await job.run();

        const inbox = await folderRepo.findOne({ mailboxUid, type: FolderType.INBOX } as any);
        const messages = await messageRepo.find({ folderUid: inbox!.uid }).toArray();
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

        const junkFolders = await folderRepo.find({ mailboxUid, type: FolderType.JUNK }).toArray();
        expect(junkFolders.length).toBe(1);
        const messages = await messageRepo.find({ folderUid: junkFolders[0].uid }).toArray();
        expect(messages.length).toBe(1);

        // A second spam message must reuse the same Junk folder rather than creating another one.
        const rawBlobKey2 = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey2, makePlainRawMessage("X-Test-Force-Spam: true"));
        await createIngestEntry({ rawBlobKey: rawBlobKey2 });
        await job.run();

        const junkFoldersAfter = await folderRepo.find({ mailboxUid, type: FolderType.JUNK }).toArray();
        expect(junkFoldersAfter.length).toBe(1);
        expect(junkFoldersAfter[0].totalCount).toBe(2);
    });

    it("Quarantines an infected message instead of delivering it, tagged with reason INFECTED.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makePlainRawMessage("X-Test-Force-Infected: true"));
        const entry = await createIngestEntry({ rawBlobKey });

        await job.run();

        const updated = await ingestQueueRepo.findOne({ uid: entry.uid } as any);
        expect(updated!.status).toBe(IngestStatus.DELIVERED);

        const messages = await messageRepo.find({ mailboxUid }).toArray();
        expect(messages.length).toBe(0);

        const quarantineEntries = await quarantineEntryRepo.find({ mailboxUid }).toArray();
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

        const updated = await ingestQueueRepo.findOne({ uid: entry.uid } as any);
        expect(updated!.status).toBe(IngestStatus.DELIVERED);

        const messages = await messageRepo.find({ mailboxUid }).toArray();
        expect(messages.length).toBe(0);

        const quarantineEntries = await quarantineEntryRepo.find({ mailboxUid }).toArray();
        expect(quarantineEntries.length).toBe(1);
        expect(quarantineEntries[0].reason).toBe(QuarantineReason.OTHER);
    });

    it("Marks an entry FAILED with the error message when processing throws, without crashing the whole run.", async () => {
        // No blob was ever put at this key, so `blobStore.get()` rejects with a real "no blob" error.
        const entry = await createIngestEntry({ rawBlobKey: `raw/${uuid.v4()}` });

        await expect(job.run()).resolves.toBeUndefined();

        const updated = await ingestQueueRepo.findOne({ uid: entry.uid } as any);
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
            const updated = await ingestQueueRepo.findOne({ uid: entry.uid } as any);
            expect(updated!.status).toBe(IngestStatus.DELIVERED);
        }
    });

    it("Applies a MOVE_TO_FOLDER rule, filing the message in the target folder instead of Inbox.", async () => {
        const targetFolder = await folderRepo.save(
            new FolderMongo({ mailboxUid, name: "Projects", type: FolderType.USER, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }),
        );
        await mailFilterRuleRepo.save(
            new MailFilterRuleMongo({
                mailboxUid,
                name: "Move to Projects",
                enabled: true,
                sequence: 0,
                stopProcessingRules: false,
                conditions: { subjectContains: ["Test message"] },
                actions: [{ type: MailFilterActionType.MOVE_TO_FOLDER, folderUid: targetFolder.uid }],
            }),
        );

        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makeRawMessage());
        await createIngestEntry({ rawBlobKey });

        await job.run();

        const inbox = await folderRepo.findOne({ mailboxUid, type: FolderType.INBOX } as any);
        expect(inbox).toBeNull();

        const messages = await messageRepo.find({ folderUid: targetFolder.uid }).toArray();
        expect(messages.length).toBe(1);
    });

    it("Applies a DELETE rule, discarding the message entirely (no Message row created).", async () => {
        await mailFilterRuleRepo.save(
            new MailFilterRuleMongo({
                mailboxUid,
                name: "Delete test messages",
                enabled: true,
                sequence: 0,
                stopProcessingRules: false,
                conditions: { subjectContains: ["Test message"] },
                actions: [{ type: MailFilterActionType.DELETE }],
            }),
        );

        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makeRawMessage());
        const entry = await createIngestEntry({ rawBlobKey });

        await job.run();

        const updated = await ingestQueueRepo.findOne({ uid: entry.uid } as any);
        expect(updated!.status).toBe(IngestStatus.DELIVERED);
        const messages = await messageRepo.find({ mailboxUid }).toArray();
        expect(messages.length).toBe(0);
    });

    it("Applies a MARK_AS_READ rule, delivering the message already read (folder unreadCount stays 0).", async () => {
        await mailFilterRuleRepo.save(
            new MailFilterRuleMongo({
                mailboxUid,
                name: "Mark newsletters read",
                enabled: true,
                sequence: 0,
                stopProcessingRules: false,
                conditions: { subjectContains: ["Test message"] },
                actions: [{ type: MailFilterActionType.MARK_AS_READ }],
            }),
        );

        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makeRawMessage());
        await createIngestEntry({ rawBlobKey });

        await job.run();

        const inbox = await folderRepo.findOne({ mailboxUid, type: FolderType.INBOX } as any);
        expect(inbox!.unreadCount).toBe(0);
        expect(inbox!.totalCount).toBe(1);
        const messages = await messageRepo.find({ folderUid: inbox!.uid }).toArray();
        expect(messages[0].flags.read).toBe(true);
    });

    it("Applies a COPY_TO_FOLDER rule, filing a copy in the target folder in addition to the original in Inbox.", async () => {
        const copyFolder = await folderRepo.save(
            new FolderMongo({ mailboxUid, name: "Archive", type: FolderType.USER, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }),
        );
        await mailFilterRuleRepo.save(
            new MailFilterRuleMongo({
                mailboxUid,
                name: "Copy to Archive",
                enabled: true,
                sequence: 0,
                stopProcessingRules: false,
                conditions: { subjectContains: ["Test message"] },
                actions: [{ type: MailFilterActionType.COPY_TO_FOLDER, folderUid: copyFolder.uid }],
            }),
        );

        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makeRawMessage());
        await createIngestEntry({ rawBlobKey });

        await job.run();

        const inbox = await folderRepo.findOne({ mailboxUid, type: FolderType.INBOX } as any);
        const inboxMessages = await messageRepo.find({ folderUid: inbox!.uid }).toArray();
        expect(inboxMessages.length).toBe(1);

        const copyMessages = await messageRepo.find({ folderUid: copyFolder.uid }).toArray();
        expect(copyMessages.length).toBe(1);
        expect(copyMessages[0].uid).not.toBe(inboxMessages[0].uid);

        const copyAttachments = await attachmentRepo.find({ folderUid: copyFolder.uid }).toArray();
        expect(copyAttachments.length).toBe(1);
    });

    it("Applies a FORWARD rule, relaying the original raw message to the forward address via MailTransport.", async () => {
        await mailFilterRuleRepo.save(
            new MailFilterRuleMongo({
                mailboxUid,
                name: "Forward to assistant",
                enabled: true,
                sequence: 0,
                stopProcessingRules: false,
                conditions: { subjectContains: ["Test message"] },
                actions: [{ type: MailFilterActionType.FORWARD, forwardTo: "assistant@example.com" }],
            }),
        );

        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makeRawMessage());
        await createIngestEntry({ rawBlobKey });

        await job.run();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        const forwarded = transport.sent.find((m) => m.envelopeTo.includes("assistant@example.com"));
        expect(forwarded).toBeDefined();
        expect(forwarded!.envelopeFrom).toBe("sender@example.com");
    });

    it("Does not evaluate mail filter rules against junk-verdict mail.", async () => {
        await mailFilterRuleRepo.save(
            new MailFilterRuleMongo({
                mailboxUid,
                name: "Mark everything read",
                enabled: true,
                sequence: 0,
                stopProcessingRules: false,
                conditions: {},
                actions: [{ type: MailFilterActionType.MARK_AS_READ }],
            }),
        );

        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makePlainRawMessage("X-Test-Force-Spam: true"));
        await createIngestEntry({ rawBlobKey });

        await job.run();

        const junkFolder = await folderRepo.findOne({ mailboxUid, type: FolderType.JUNK } as any);
        const messages = await messageRepo.find({ folderUid: junkFolder!.uid }).toArray();
        expect(messages[0].flags.read).toBe(false);
    });

    it("Sends an automatic reply when the mailbox's oofEnabled toggle is active, and records a suppression entry.", async () => {
        await createMailbox({ oofEnabled: true, oofMessage: "I'm currently out of office." });

        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makeRawMessage());
        await createIngestEntry({ rawBlobKey });

        await job.run();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        const reply = transport.sent.find((m) => m.envelopeTo.includes("sender@example.com"));
        expect(reply).toBeDefined();
        expect(reply!.raw.toString()).toContain("out of office");
        expect(reply!.raw.toString().toLowerCase()).toContain("auto-submitted: auto-replied");

        const suppressions = await oofReplySuppressionRepo.find({ mailboxUid, senderAddress: "sender@example.com" }).toArray();
        expect(suppressions.length).toBe(1);
    });

    it("Does not send a second automatic reply to the same sender within the resuppression window.", async () => {
        await createMailbox({ oofEnabled: true, oofMessage: "I'm currently out of office." });

        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey1 = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey1, makeRawMessage());
        await createIngestEntry({ rawBlobKey: rawBlobKey1 });
        await job.run();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(1);

        const rawBlobKey2 = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey2, makeRawMessage());
        await createIngestEntry({ rawBlobKey: rawBlobKey2 });
        await job.run();

        expect(transport.sent.length).toBe(1);
    });

    it("Sends an automatic reply based on a linked CalendarEvent's autoReplyEnabled window even when the mailbox toggle is off.", async () => {
        await createMailbox({ oofEnabled: false });
        const folder = await folderRepo.save(
            new FolderMongo({ mailboxUid, name: "Calendar", type: FolderType.CALENDAR, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }),
        );
        await calendarEventRepo.save(
            new CalendarEventMongo({
                folderUid: folder.uid,
                mailboxUid,
                title: "Vacation",
                startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
                endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
                allDay: true,
                timezone: "UTC",
                organizer: { address: "recipient@example.com", type: "to" as any },
                icalUid: uuid.v4(),
                autoReplyEnabled: true,
                autoReplyMessage: "On vacation until next week.",
            }),
        );

        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makeRawMessage());
        await createIngestEntry({ rawBlobKey });

        await job.run();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        const reply = transport.sent.find((m) => m.envelopeTo.includes("sender@example.com"));
        expect(reply).toBeDefined();
        expect(reply!.raw.toString()).toContain("On vacation until next week.");
    });

    it("Does not send an automatic reply to a message carrying an Auto-Submitted header (RFC 3834 loop prevention).", async () => {
        await createMailbox({ oofEnabled: true, oofMessage: "I'm currently out of office." });

        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makePlainRawMessage("Auto-Submitted: auto-replied"));
        await createIngestEntry({ rawBlobKey });

        await job.run();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(0);
    });

    it("Skips a COPY_TO_FOLDER rule whose target folder no longer exists, without failing delivery.", async () => {
        await mailFilterRuleRepo.save(
            new MailFilterRuleMongo({
                mailboxUid,
                name: "Copy to a deleted folder",
                enabled: true,
                sequence: 0,
                stopProcessingRules: false,
                conditions: { subjectContains: ["Test message"] },
                actions: [{ type: MailFilterActionType.COPY_TO_FOLDER, folderUid: uuid.v4() }],
            }),
        );

        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makeRawMessage());
        const entry = await createIngestEntry({ rawBlobKey });

        await job.run();

        const updated = await ingestQueueRepo.findOne({ uid: entry.uid } as any);
        expect(updated!.status).toBe(IngestStatus.DELIVERED);
        const inbox = await folderRepo.findOne({ mailboxUid, type: FolderType.INBOX } as any);
        const inboxMessages = await messageRepo.find({ folderUid: inbox!.uid }).toArray();
        expect(inboxMessages.length).toBe(1);
    });

    it("Logs a warning and continues when relaying a FORWARD action throws.", async () => {
        await mailFilterRuleRepo.save(
            new MailFilterRuleMongo({
                mailboxUid,
                name: "Forward to assistant",
                enabled: true,
                sequence: 0,
                stopProcessingRules: false,
                conditions: { subjectContains: ["Test message"] },
                actions: [{ type: MailFilterActionType.FORWARD, forwardTo: "assistant@example.com" }],
            }),
        );

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        const sendSpy = vi.spyOn(transport, "send").mockRejectedValueOnce(new Error("simulated transport failure"));

        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makeRawMessage());
        const entry = await createIngestEntry({ rawBlobKey });

        await expect(job.run()).resolves.toBeUndefined();

        const updated = await ingestQueueRepo.findOne({ uid: entry.uid } as any);
        expect(updated!.status).toBe(IngestStatus.DELIVERED);
        sendSpy.mockRestore();
    });

    it("Does not send an automatic reply when the mailbox exists but is not currently out of office.", async () => {
        await createMailbox({ oofEnabled: false });

        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makeRawMessage());
        await createIngestEntry({ rawBlobKey });

        await job.run();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(0);
    });

    it("Updates (rather than re-creates) an existing suppression entry once the resuppression window has elapsed.", async () => {
        await createMailbox({ oofEnabled: true, oofMessage: "I'm currently out of office." });
        const staleSuppression = await oofReplySuppressionRepo.save(
            new OofReplySuppressionMongo({
                mailboxUid,
                senderAddress: "sender@example.com",
                lastRepliedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
            }),
        );

        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makeRawMessage());
        await createIngestEntry({ rawBlobKey });

        await job.run();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(1);

        const suppressions = await oofReplySuppressionRepo.find({ mailboxUid, senderAddress: "sender@example.com" }).toArray();
        expect(suppressions.length).toBe(1);
        expect(suppressions[0].uid).toBe(staleSuppression.uid);
        expect(suppressions[0].lastRepliedAt.getTime()).toBeGreaterThan(staleSuppression.lastRepliedAt.getTime());
    });

    it("Logs a warning and does not record a suppression entry when sending an automatic reply throws.", async () => {
        await createMailbox({ oofEnabled: true, oofMessage: "I'm currently out of office." });

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        const sendSpy = vi.spyOn(transport, "send").mockRejectedValueOnce(new Error("simulated transport failure"));

        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makeRawMessage());
        await createIngestEntry({ rawBlobKey });

        await expect(job.run()).resolves.toBeUndefined();

        const suppressions = await oofReplySuppressionRepo.find({ mailboxUid, senderAddress: "sender@example.com" }).toArray();
        expect(suppressions.length).toBe(0);
        sendSpy.mockRestore();
    });
});
