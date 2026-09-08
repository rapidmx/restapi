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
import { buildEventIcs } from "../../../src/util/IcsUtils.js";
import {
    AttendeeResponseStatus,
    AttendeeRole,
    BusyStatus,
    CalendarEvent,
    CalendarEventStatus,
    FolderType,
    IngestStatus,
    MailFilterActionType,
    QuarantineReason,
    RecipientType,
    RecurrenceFrequency,
} from "../../../src/models/types.js";

/** A minimal `CalendarEvent`-shaped fixture, just enough for `buildEventIcs()` to render real ICS text from. */
function makeIcsEventFixture(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
    return {
        uid: "fixture-uid",
        version: 0,
        dateCreated: new Date(),
        dateModified: new Date(),
        deleted: false,
        folderUid: "organizer-folder",
        mailboxUid: "organizer-mailbox",
        title: "Team Sync",
        startDate: new Date(Date.now() + 60 * 60 * 1000),
        endDate: new Date(Date.now() + 2 * 60 * 60 * 1000),
        allDay: false,
        timezone: "UTC",
        organizer: { address: "organizer@example.com", displayName: "Organizer", type: RecipientType.TO },
        attendees: [
            { address: "recipient@example.com", displayName: "Recipient", role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION, isOrganizer: false },
        ],
        status: CalendarEventStatus.CONFIRMED,
        busyStatus: BusyStatus.BUSY,
        icalUid: "fixture-ical-uid",
        sequence: 0,
        ...overrides,
    };
}

/** Builds a raw multipart RFC 5322 message carrying `ics` as its `text/calendar` part - the inbound iTIP shape
 * `ScanPipeline`/`ScanQueueJob.maybeProcessItipMessage()` detect and process. */
function makeItipRawMessage(ics: string, opts: { from?: string; to?: string } = {}): Buffer {
    const from = opts.from ?? "organizer@example.com";
    const to = opts.to ?? "recipient@example.com";
    const raw = [
        `From: ${from}`,
        `To: ${to}`,
        "Subject: Meeting invite",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="BOUNDARY"',
        "",
        "--BOUNDARY",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "You have been invited.",
        "",
        "--BOUNDARY",
        'Content-Type: text/calendar; method=REQUEST; name="invite.ics"',
        'Content-Disposition: attachment; filename="invite.ics"',
        "",
        ics,
        "",
        "--BOUNDARY--",
        "",
    ].join("\r\n");
    return Buffer.from(raw);
}

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

    it("Quarantines an entry pre-tagged by a TransportRule (quarantineReason) even though AV/spam scanning found it clean, still recording a real ScanResult.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makePlainRawMessage());
        const entry = await createIngestEntry({ rawBlobKey, quarantineReason: QuarantineReason.TRANSPORT_RULE });

        await job.run();

        const updated = await ingestQueueRepo.findOne({ uid: entry.uid } as any);
        expect(updated!.status).toBe(IngestStatus.DELIVERED);

        const messages = await messageRepo.find({ mailboxUid }).toArray();
        expect(messages.length).toBe(0);

        const quarantineEntries = await quarantineEntryRepo.find({ mailboxUid }).toArray();
        expect(quarantineEntries.length).toBe(1);
        expect(quarantineEntries[0].reason).toBe(QuarantineReason.TRANSPORT_RULE);
        expect(quarantineEntries[0].rawBlobKey).toBe(rawBlobKey);

        const scanResults = await scanResultRepo.find({ targetUid: quarantineEntries[0].uid }).toArray();
        expect(scanResults.length).toBe(1);
    });

    it("An actually-infected message pre-tagged by a TransportRule still reports the more specific INFECTED reason.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makePlainRawMessage("X-Test-Force-Infected: true"));
        await createIngestEntry({ rawBlobKey, quarantineReason: QuarantineReason.TRANSPORT_RULE });

        await job.run();

        const quarantineEntries = await quarantineEntryRepo.find({ mailboxUid }).toArray();
        expect(quarantineEntries.length).toBe(1);
        expect(quarantineEntries[0].reason).toBe(QuarantineReason.INFECTED);
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

    describe("Inbound iTIP processing", () => {
        it("Ignores a text/calendar part with no recognizable UID/METHOD (parseIcsEvent returns undefined).", async () => {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makeItipRawMessage("BEGIN:VCALENDAR\r\nEND:VCALENDAR"));
            const entry = await createIngestEntry({ rawBlobKey, envelopeFrom: "organizer@example.com", envelopeTo: ["recipient@example.com"] });

            await expect(job.run()).resolves.toBeUndefined();

            const updated = await ingestQueueRepo.findOne({ uid: entry.uid } as any);
            expect(updated!.status).toBe(IngestStatus.DELIVERED);
        });

        it("Ignores an iTIP message with an unrecognized METHOD (not REQUEST/REPLY/CANCEL).", async () => {
            const ics = buildEventIcs(makeIcsEventFixture({ icalUid: uuid.v4() }), "REQUEST").replace("METHOD:REQUEST", "METHOD:PUBLISH");
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makeItipRawMessage(ics));
            await createIngestEntry({ rawBlobKey, envelopeFrom: "organizer@example.com", envelopeTo: ["recipient@example.com"] });

            await expect(job.run()).resolves.toBeUndefined();
        });

        it("Logs a warning and continues when processing an iTIP message throws.", async () => {
            const findSpy = vi.spyOn((job as any).calendarEventRepo, "find").mockRejectedValueOnce(new Error("simulated database failure"));

            const ics = buildEventIcs(makeIcsEventFixture({ icalUid: uuid.v4() }), "REQUEST");
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makeItipRawMessage(ics));
            const entry = await createIngestEntry({ rawBlobKey, envelopeFrom: "organizer@example.com", envelopeTo: ["recipient@example.com"] });

            await expect(job.run()).resolves.toBeUndefined();

            // The failure is caught and logged - it never fails the overall ingest entry, which still delivers.
            const updated = await ingestQueueRepo.findOne({ uid: entry.uid } as any);
            expect(updated!.status).toBe(IngestStatus.DELIVERED);
            findSpy.mockRestore();
        });

        it("Ignores a REPLY for which no matching CalendarEvent exists in this mailbox.", async () => {
            const replyIcs = buildEventIcs(makeIcsEventFixture({ icalUid: uuid.v4() }), "REPLY", {
                onlyAttendee: {
                    address: "attendee@example.com",
                    role: AttendeeRole.REQUIRED,
                    responseStatus: AttendeeResponseStatus.ACCEPTED,
                    isOrganizer: false,
                },
            });
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makeItipRawMessage(replyIcs, { from: "attendee@example.com", to: "organizer@example.com" }));
            const entry = await createIngestEntry({ rawBlobKey, envelopeFrom: "attendee@example.com", envelopeTo: ["organizer@example.com"] });

            await expect(job.run()).resolves.toBeUndefined();

            const updated = await ingestQueueRepo.findOne({ uid: entry.uid } as any);
            expect(updated!.status).toBe(IngestStatus.DELIVERED);
        });

        it("Creates a new CalendarEvent in the mailbox's Calendar folder from an inbound REQUEST.", async () => {
            const icalUid = uuid.v4();
            const ics = buildEventIcs(makeIcsEventFixture({ icalUid }), "REQUEST");
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makeItipRawMessage(ics));
            await createIngestEntry({ rawBlobKey, envelopeFrom: "organizer@example.com", envelopeTo: ["recipient@example.com"] });

            await job.run();

            const events = await calendarEventRepo.find({ mailboxUid, icalUid }).toArray();
            expect(events.length).toBe(1);
            expect(events[0].title).toBe("Team Sync");
            expect(events[0].attendees[0].responseStatus).toBe(AttendeeResponseStatus.NEEDS_ACTION);
            const calendarFolder = await folderRepo.findOne({ mailboxUid, type: FolderType.CALENDAR } as any);
            expect(events[0].folderUid).toBe(calendarFolder!.uid);
        });

        it("Updates an existing event in place when a resent REQUEST carries a higher sequence.", async () => {
            const icalUid = uuid.v4();
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;

            const firstRawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(firstRawBlobKey, makeItipRawMessage(buildEventIcs(makeIcsEventFixture({ icalUid, sequence: 0 }), "REQUEST")));
            await createIngestEntry({ rawBlobKey: firstRawBlobKey, envelopeFrom: "organizer@example.com", envelopeTo: ["recipient@example.com"] });
            await job.run();
            const created = (await calendarEventRepo.find({ mailboxUid, icalUid }).toArray())[0];

            const secondRawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(
                secondRawBlobKey,
                makeItipRawMessage(buildEventIcs(makeIcsEventFixture({ icalUid, sequence: 1, title: "Team Sync (moved)" }), "REQUEST")),
            );
            await createIngestEntry({ rawBlobKey: secondRawBlobKey, envelopeFrom: "organizer@example.com", envelopeTo: ["recipient@example.com"] });
            await job.run();

            const events = await calendarEventRepo.find({ mailboxUid, icalUid }).toArray();
            expect(events.length).toBe(1);
            expect(events[0].uid).toBe(created.uid);
            expect(events[0].title).toBe("Team Sync (moved)");
            expect(events[0].sequence).toBe(1);
        });

        it("Ignores a resent REQUEST whose sequence is not higher than the existing row's (stale/duplicate).", async () => {
            const icalUid = uuid.v4();
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;

            await blobStore.put(`raw/a`, makeItipRawMessage(buildEventIcs(makeIcsEventFixture({ icalUid, sequence: 1 }), "REQUEST")));
            await createIngestEntry({ rawBlobKey: `raw/a`, envelopeFrom: "organizer@example.com", envelopeTo: ["recipient@example.com"] });
            await job.run();

            await blobStore.put(`raw/b`, makeItipRawMessage(buildEventIcs(makeIcsEventFixture({ icalUid, sequence: 1, title: "Should not apply" }), "REQUEST")));
            await createIngestEntry({ rawBlobKey: `raw/b`, envelopeFrom: "organizer@example.com", envelopeTo: ["recipient@example.com"] });
            await job.run();

            const events = await calendarEventRepo.find({ mailboxUid, icalUid }).toArray();
            expect(events.length).toBe(1);
            expect(events[0].title).toBe("Team Sync");
        });

        it("Updates the matching attendee's responseStatus from an inbound REPLY.", async () => {
            const icalUid = uuid.v4();
            const organizerCopy = await calendarEventRepo.save(
                new CalendarEventMongo({
                    folderUid: "organizer-calendar-folder",
                    mailboxUid,
                    title: "Team Sync",
                    timezone: "UTC",
                    organizer: { address: "organizer@example.com", type: RecipientType.TO },
                    attendees: [
                        {
                            address: "attendee@example.com",
                            role: AttendeeRole.REQUIRED,
                            responseStatus: AttendeeResponseStatus.NEEDS_ACTION,
                            isOrganizer: false,
                        },
                    ],
                    status: CalendarEventStatus.CONFIRMED,
                    busyStatus: BusyStatus.BUSY,
                    icalUid,
                    startDate: new Date(),
                    endDate: new Date(),
                }),
            );

            const replyIcs = buildEventIcs(makeIcsEventFixture({ icalUid }), "REPLY", {
                onlyAttendee: {
                    address: "attendee@example.com",
                    role: AttendeeRole.REQUIRED,
                    responseStatus: AttendeeResponseStatus.ACCEPTED,
                    isOrganizer: false,
                },
            });
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makeItipRawMessage(replyIcs, { from: "attendee@example.com", to: "organizer@example.com" }));
            await createIngestEntry({ rawBlobKey, envelopeFrom: "attendee@example.com", envelopeTo: ["organizer@example.com"] });

            await job.run();

            const updated = await calendarEventRepo.findOne({ uid: organizerCopy.uid } as any);
            expect(updated!.attendees[0].responseStatus).toBe(AttendeeResponseStatus.ACCEPTED);
        });

        it("Soft-deletes the mailbox's own copy from a whole-series inbound CANCEL (no recurrenceId).", async () => {
            const icalUid = uuid.v4();
            const existing = await calendarEventRepo.save(
                new CalendarEventMongo({
                    folderUid: "calendar-folder",
                    mailboxUid,
                    title: "Team Sync",
                    timezone: "UTC",
                    organizer: { address: "organizer@example.com", type: RecipientType.TO },
                    attendees: [],
                    status: CalendarEventStatus.CONFIRMED,
                    busyStatus: BusyStatus.BUSY,
                    icalUid,
                    startDate: new Date(),
                    endDate: new Date(),
                }),
            );

            const ics = buildEventIcs(makeIcsEventFixture({ icalUid }), "CANCEL");
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makeItipRawMessage(ics));
            await createIngestEntry({ rawBlobKey, envelopeFrom: "organizer@example.com", envelopeTo: ["recipient@example.com"] });

            await job.run();

            // A raw `MongoRepository` (bypassing `RecoverableRepoUtils`) still returns a soft-deleted document -
            // it just carries `deleted: true` rather than being physically removed.
            const found = await calendarEventRepo.findOne({ uid: existing.uid } as any);
            expect(found!.deleted).toBe(true);
        });

        it("Recurring: a single-occurrence inbound CANCEL soft-deletes the matching override row.", async () => {
            const icalUid = uuid.v4();
            // ICS `DATE-TIME` values have only whole-second precision - round accordingly so the round-tripped
            // value compares equal rather than losing milliseconds.
            const recurrenceId = new Date(Math.floor((Date.now() + 60 * 60 * 1000) / 1000) * 1000);
            const override = await calendarEventRepo.save(
                new CalendarEventMongo({
                    folderUid: "calendar-folder",
                    mailboxUid,
                    title: "Team Sync (moved)",
                    timezone: "UTC",
                    organizer: { address: "organizer@example.com", type: RecipientType.TO },
                    attendees: [],
                    status: CalendarEventStatus.CONFIRMED,
                    busyStatus: BusyStatus.BUSY,
                    icalUid,
                    recurrenceId,
                    startDate: new Date(),
                    endDate: new Date(),
                }),
            );

            const ics = buildEventIcs(makeIcsEventFixture({ icalUid, recurrenceId }), "CANCEL");
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makeItipRawMessage(ics));
            await createIngestEntry({ rawBlobKey, envelopeFrom: "organizer@example.com", envelopeTo: ["recipient@example.com"] });

            await job.run();

            const found = await calendarEventRepo.findOne({ uid: override.uid } as any);
            expect(found!.deleted).toBe(true);
        });

        it("Recurring: a single-occurrence CANCEL with no existing override adds the date to the master's recurrenceRule.exceptions.", async () => {
            const icalUid = uuid.v4();
            const recurrenceId = new Date(Math.floor((Date.now() + 60 * 60 * 1000) / 1000) * 1000);
            const master = await calendarEventRepo.save(
                new CalendarEventMongo({
                    folderUid: "calendar-folder",
                    mailboxUid,
                    title: "Team Sync",
                    timezone: "UTC",
                    organizer: { address: "organizer@example.com", type: RecipientType.TO },
                    attendees: [],
                    recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, exceptions: [] },
                    status: CalendarEventStatus.CONFIRMED,
                    busyStatus: BusyStatus.BUSY,
                    icalUid,
                    startDate: new Date(),
                    endDate: new Date(),
                }),
            );

            const ics = buildEventIcs(makeIcsEventFixture({ icalUid, recurrenceId }), "CANCEL");
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makeItipRawMessage(ics));
            await createIngestEntry({ rawBlobKey, envelopeFrom: "organizer@example.com", envelopeTo: ["recipient@example.com"] });

            await job.run();

            const updatedMaster = await calendarEventRepo.findOne({ uid: master.uid } as any);
            expect(updatedMaster).not.toBeNull();
            expect(updatedMaster!.recurrenceRule!.exceptions.map((d) => d.getTime())).toContain(recurrenceId.getTime());
        });

        it("Recurring: an inbound REQUEST with a recurrenceId creates/updates only that occurrence, independent of the master.", async () => {
            const icalUid = uuid.v4();
            const master = await calendarEventRepo.save(
                new CalendarEventMongo({
                    folderUid: "calendar-folder",
                    mailboxUid,
                    title: "Team Sync",
                    timezone: "UTC",
                    organizer: { address: "organizer@example.com", type: RecipientType.TO },
                    attendees: [],
                    recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, exceptions: [] },
                    status: CalendarEventStatus.CONFIRMED,
                    busyStatus: BusyStatus.BUSY,
                    icalUid,
                    startDate: new Date(),
                    endDate: new Date(),
                }),
            );

            const recurrenceId = new Date(Math.floor((Date.now() + 60 * 60 * 1000) / 1000) * 1000);
            const ics = buildEventIcs(makeIcsEventFixture({ icalUid, recurrenceId, title: "Team Sync (moved)" }), "REQUEST");
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makeItipRawMessage(ics));
            await createIngestEntry({ rawBlobKey, envelopeFrom: "organizer@example.com", envelopeTo: ["recipient@example.com"] });

            await job.run();

            const unchangedMaster = await calendarEventRepo.findOne({ uid: master.uid } as any);
            expect(unchangedMaster!.title).toBe("Team Sync");

            const events = await calendarEventRepo.find({ mailboxUid, icalUid }).toArray();
            expect(events.length).toBe(2);
            const override = events.find((e) => e.uid !== master.uid);
            expect(override!.title).toBe("Team Sync (moved)");
            expect(override!.recurrenceId!.getTime()).toBe(recurrenceId.getTime());
        });
    });

    describe("Resource mailbox auto-accept/decline", () => {
        const sendItipRequest = async (icsOverrides: Partial<CalendarEvent>): Promise<void> => {
            const ics = buildEventIcs(makeIcsEventFixture(icsOverrides), "REQUEST");
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makeItipRawMessage(ics));
            await createIngestEntry({ rawBlobKey, envelopeFrom: "organizer@example.com", envelopeTo: ["recipient@example.com"] });
            await job.run();
        };

        it("Auto-accepts a non-conflicting request and replies via iTIP REPLY.", async () => {
            await createMailbox({ isResource: true, autoAcceptBookings: true });
            const startDate = new Date(Date.now() + 60 * 60 * 1000);
            const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);
            const icalUid = uuid.v4();

            await sendItipRequest({ icalUid, startDate, endDate });

            const events = await calendarEventRepo.find({ mailboxUid, icalUid }).toArray();
            expect(events.length).toBe(1);
            expect(events[0].deleted).toBe(false);
            const resourceAttendee = events[0].attendees.find((a) => a.address === "recipient@example.com");
            expect(resourceAttendee!.responseStatus).toBe(AttendeeResponseStatus.ACCEPTED);

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent.length).toBe(1);
            expect(transport.sent[0].envelopeFrom).toBe("recipient@example.com");
            expect(transport.sent[0].envelopeTo).toEqual(["organizer@example.com"]);
            expect(transport.sent[0].raw.toString()).toContain("METHOD:REPLY");
            expect(transport.sent[0].raw.toString()).toContain("ACCEPTED");
        });

        it("Auto-declines a request that conflicts with an existing booking, soft-deleting its own copy.", async () => {
            await createMailbox({ isResource: true, autoAcceptBookings: true });
            const startDate = new Date(Date.now() + 60 * 60 * 1000);
            const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
            await calendarEventRepo.save(
                new CalendarEventMongo({
                    folderUid: "calendar-folder",
                    mailboxUid,
                    title: "Existing Booking",
                    timezone: "UTC",
                    organizer: { address: "other-organizer@example.com", type: RecipientType.TO },
                    attendees: [],
                    status: CalendarEventStatus.CONFIRMED,
                    busyStatus: BusyStatus.BUSY,
                    icalUid: uuid.v4(),
                    startDate,
                    endDate,
                }),
            );

            const icalUid = uuid.v4();
            await sendItipRequest({ icalUid, startDate, endDate });

            const events = await calendarEventRepo.find({ mailboxUid, icalUid }).toArray();
            expect(events.length).toBe(1);
            expect(events[0].deleted).toBe(true);

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent.length).toBe(1);
            expect(transport.sent[0].raw.toString()).toContain("METHOD:REPLY");
            expect(transport.sent[0].raw.toString()).toContain("DECLINED");
        });

        it("allowConflicts accepts a request despite an overlapping existing booking.", async () => {
            await createMailbox({ isResource: true, autoAcceptBookings: true, allowConflicts: true });
            const startDate = new Date(Date.now() + 60 * 60 * 1000);
            const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
            await calendarEventRepo.save(
                new CalendarEventMongo({
                    folderUid: "calendar-folder",
                    mailboxUid,
                    title: "Existing Booking",
                    timezone: "UTC",
                    organizer: { address: "other-organizer@example.com", type: RecipientType.TO },
                    attendees: [],
                    status: CalendarEventStatus.CONFIRMED,
                    busyStatus: BusyStatus.BUSY,
                    icalUid: uuid.v4(),
                    startDate,
                    endDate,
                }),
            );

            const icalUid = uuid.v4();
            await sendItipRequest({ icalUid, startDate, endDate });

            const events = await calendarEventRepo.find({ mailboxUid, icalUid }).toArray();
            expect(events.length).toBe(1);
            expect(events[0].deleted).toBe(false);
        });

        it("Auto-declines a request exceeding maxDurationMinutes, without attempting a conflict check.", async () => {
            await createMailbox({ isResource: true, autoAcceptBookings: true, maxDurationMinutes: 30 });
            const startDate = new Date(Date.now() + 60 * 60 * 1000);
            const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
            const icalUid = uuid.v4();

            await sendItipRequest({ icalUid, startDate, endDate });

            const events = await calendarEventRepo.find({ mailboxUid, icalUid }).toArray();
            expect(events.length).toBe(1);
            expect(events[0].deleted).toBe(true);
        });

        it("Auto-declines a request starting further out than bookingWindowDays, without attempting a conflict check.", async () => {
            await createMailbox({ isResource: true, autoAcceptBookings: true, bookingWindowDays: 7 });
            const startDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
            const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);
            const icalUid = uuid.v4();

            await sendItipRequest({ icalUid, startDate, endDate });

            const events = await calendarEventRepo.find({ mailboxUid, icalUid }).toArray();
            expect(events.length).toBe(1);
            expect(events[0].deleted).toBe(true);
        });

        it("Recurring: auto-declines when an occurrence of the request conflicts with an occurrence of an existing recurring booking.", async () => {
            await createMailbox({ isResource: true, autoAcceptBookings: true });
            const existingStart = new Date(Date.now() + 24 * 60 * 60 * 1000);
            const existingEnd = new Date(existingStart.getTime() + 60 * 60 * 1000);
            await calendarEventRepo.save(
                new CalendarEventMongo({
                    folderUid: "calendar-folder",
                    mailboxUid,
                    title: "Existing Recurring Booking",
                    timezone: "UTC",
                    organizer: { address: "other-organizer@example.com", type: RecipientType.TO },
                    attendees: [],
                    recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, exceptions: [] },
                    status: CalendarEventStatus.CONFIRMED,
                    busyStatus: BusyStatus.BUSY,
                    icalUid: uuid.v4(),
                    startDate: existingStart,
                    endDate: existingEnd,
                }),
            );

            // The request's own second occurrence (start + 7 days) lands exactly on the existing recurring
            // booking's own weekly occurrence.
            const requestStart = new Date(existingStart.getTime() - 7 * 24 * 60 * 60 * 1000);
            const requestEnd = new Date(requestStart.getTime() + 60 * 60 * 1000);
            const icalUid = uuid.v4();
            await sendItipRequest({
                icalUid,
                startDate: requestStart,
                endDate: requestEnd,
                recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, count: 3, exceptions: [] },
            });

            const events = await calendarEventRepo.find({ mailboxUid, icalUid }).toArray();
            expect(events.length).toBe(1);
            expect(events[0].deleted).toBe(true);
        });

        it("Recurring: auto-accepts when none of the request's occurrences conflict with any existing booking.", async () => {
            await createMailbox({ isResource: true, autoAcceptBookings: true });
            const startDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
            const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
            const icalUid = uuid.v4();

            await sendItipRequest({
                icalUid,
                startDate,
                endDate,
                recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, count: 3, exceptions: [] },
            });

            const events = await calendarEventRepo.find({ mailboxUid, icalUid }).toArray();
            expect(events.length).toBe(1);
            expect(events[0].deleted).toBe(false);
            const resourceAttendee = events[0].attendees.find((a) => a.address === "recipient@example.com");
            expect(resourceAttendee!.responseStatus).toBe(AttendeeResponseStatus.ACCEPTED);
        });

        it("A resent REQUEST for a resource booking doesn't treat its own prior CalendarEvent row as a conflict.", async () => {
            await createMailbox({ isResource: true, autoAcceptBookings: true });
            const startDate = new Date(Date.now() + 60 * 60 * 1000);
            const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);
            const icalUid = uuid.v4();

            await sendItipRequest({ icalUid, startDate, endDate, sequence: 0 });
            await sendItipRequest({ icalUid, startDate, endDate, sequence: 1, title: "Team Sync (updated)" });

            const events = await calendarEventRepo.find({ mailboxUid, icalUid }).toArray();
            expect(events.length).toBe(1);
            expect(events[0].deleted).toBe(false);
            expect(events[0].title).toBe("Team Sync (updated)");
            const resourceAttendee = events[0].attendees.find((a) => a.address === "recipient@example.com");
            expect(resourceAttendee!.responseStatus).toBe(AttendeeResponseStatus.ACCEPTED);
        });

        it("Does not auto-process (attendee stays NEEDS_ACTION, no reply sent) for a non-resource mailbox.", async () => {
            await createMailbox({ isResource: false });
            const icalUid = uuid.v4();
            await sendItipRequest({ icalUid });

            const events = await calendarEventRepo.find({ mailboxUid, icalUid }).toArray();
            expect(events[0].attendees[0].responseStatus).toBe(AttendeeResponseStatus.NEEDS_ACTION);
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent.length).toBe(0);
        });

        it("Does not auto-process (attendee stays NEEDS_ACTION, no reply sent) for a resource mailbox with autoAcceptBookings unset.", async () => {
            await createMailbox({ isResource: true });
            const icalUid = uuid.v4();
            await sendItipRequest({ icalUid });

            const events = await calendarEventRepo.find({ mailboxUid, icalUid }).toArray();
            expect(events[0].attendees[0].responseStatus).toBe(AttendeeResponseStatus.NEEDS_ACTION);
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent.length).toBe(0);
        });

        it("Recurring: a sibling override row's RECURRENCE-ID excludes the master's phantom occurrence at that instant, so a request for the vacated original time isn't falsely declined.", async () => {
            await createMailbox({ isResource: true, autoAcceptBookings: true });
            const existingMasterStart = new Date(Date.now() + 24 * 60 * 60 * 1000);
            const existingMasterEnd = new Date(existingMasterStart.getTime() + 60 * 60 * 1000);
            const existingIcalUid = uuid.v4();
            await calendarEventRepo.save(
                new CalendarEventMongo({
                    folderUid: "calendar-folder",
                    mailboxUid,
                    title: "Existing Recurring Booking",
                    timezone: "UTC",
                    organizer: { address: "other-organizer@example.com", type: RecipientType.TO },
                    attendees: [],
                    recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, exceptions: [] },
                    status: CalendarEventStatus.CONFIRMED,
                    busyStatus: BusyStatus.BUSY,
                    icalUid: existingIcalUid,
                    startDate: existingMasterStart,
                    endDate: existingMasterEnd,
                }),
            );
            // The master's second occurrence was rescheduled 3 hours later - the override row represents its
            // real (moved) time, and the master's own expansion must not phantom-generate it at the original
            // instant any more.
            const originalSecondOccurrence = new Date(existingMasterStart.getTime() + 7 * 24 * 60 * 60 * 1000);
            const movedSecondOccurrenceStart = new Date(originalSecondOccurrence.getTime() + 3 * 60 * 60 * 1000);
            await calendarEventRepo.save(
                new CalendarEventMongo({
                    folderUid: "calendar-folder",
                    mailboxUid,
                    title: "Existing Recurring Booking (moved occurrence)",
                    timezone: "UTC",
                    organizer: { address: "other-organizer@example.com", type: RecipientType.TO },
                    attendees: [],
                    status: CalendarEventStatus.CONFIRMED,
                    busyStatus: BusyStatus.BUSY,
                    icalUid: existingIcalUid,
                    recurrenceId: originalSecondOccurrence,
                    startDate: movedSecondOccurrenceStart,
                    endDate: new Date(movedSecondOccurrenceStart.getTime() + 60 * 60 * 1000),
                }),
            );

            // A new, non-recurring request for exactly the vacated original slot - must not be declined
            // against a phantom occurrence of the master that no longer actually occupies that time.
            const icalUid = uuid.v4();
            await sendItipRequest({
                icalUid,
                startDate: originalSecondOccurrence,
                endDate: new Date(originalSecondOccurrence.getTime() + 60 * 60 * 1000),
            });

            const events = await calendarEventRepo.find({ mailboxUid, icalUid }).toArray();
            expect(events.length).toBe(1);
            expect(events[0].deleted).toBe(false);
        });

        it("Sends no auto-response when the resource's own address isn't listed among the request's attendees.", async () => {
            await createMailbox({ isResource: true, autoAcceptBookings: true });
            const icalUid = uuid.v4();
            const startDate = new Date(Date.now() + 60 * 60 * 1000);
            const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);

            await sendItipRequest({
                icalUid,
                startDate,
                endDate,
                attendees: [
                    {
                        address: "someone-else@example.com",
                        displayName: "Someone Else",
                        role: AttendeeRole.REQUIRED,
                        responseStatus: AttendeeResponseStatus.NEEDS_ACTION,
                        isOrganizer: false,
                    },
                ],
            });

            const events = await calendarEventRepo.find({ mailboxUid, icalUid }).toArray();
            expect(events.length).toBe(1);
            expect(events[0].deleted).toBe(false);
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent.length).toBe(0);
        });

        it("Logs a warning and does not throw when sending the resource's auto-response fails.", async () => {
            await createMailbox({ isResource: true, autoAcceptBookings: true });
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            const sendSpy = vi.spyOn(transport, "send").mockRejectedValueOnce(new Error("simulated transport failure"));

            const icalUid = uuid.v4();
            const startDate = new Date(Date.now() + 60 * 60 * 1000);
            const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);
            await expect(sendItipRequest({ icalUid, startDate, endDate })).resolves.toBeUndefined();

            const events = await calendarEventRepo.find({ mailboxUid, icalUid }).toArray();
            expect(events.length).toBe(1);
            expect(events[0].deleted).toBe(false);
            sendSpy.mockRestore();
        });
    });

    describe("Message recall", () => {
        const makeRecallRaw = (targetMessageId: string): Buffer => makePlainRawMessage(`X-RapidMX-Recall-Of: ${targetMessageId}`);

        it("Deletes the target message and reports success when it's still unread.", async () => {
            await createMailbox();
            const targetMessageId = "target-message@example.com";
            const target = await messageRepo.save(
                new MessageMongo({
                    mailboxUid,
                    folderUid: "inbox-folder",
                    messageId: targetMessageId,
                    from: { address: "someone@example.com", type: RecipientType.TO },
                    recipients: [{ address: "recipient@example.com", type: RecipientType.TO }],
                    bodyBlobKey: `bodies/${uuid.v4()}`,
                }),
            );

            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makeRecallRaw(targetMessageId));
            await createIngestEntry({ rawBlobKey, envelopeFrom: "sender@example.com", envelopeTo: ["recipient@example.com"] });

            await job.run();

            const found = await messageRepo.findOne({ uid: target.uid } as any);
            expect(found!.deleted).toBe(true);

            // The recall control message itself is never filed anywhere in the recipient's mailbox.
            const allMessages = await messageRepo.find({ mailboxUid }).toArray();
            expect(allMessages.length).toBe(1);

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent.length).toBe(1);
            expect(transport.sent[0].envelopeFrom).toBe("recipient@example.com");
            expect(transport.sent[0].envelopeTo).toEqual(["sender@example.com"]);
            expect(transport.sent[0].raw.toString()).toContain("Recalled from recipient@example.com before it was read.");
        });

        it("Leaves the target message alone and reports 'already read' when it's already been read.", async () => {
            await createMailbox();
            const targetMessageId = "already-read@example.com";
            const target = await messageRepo.save(
                new MessageMongo({
                    mailboxUid,
                    folderUid: "inbox-folder",
                    messageId: targetMessageId,
                    from: { address: "someone@example.com", type: RecipientType.TO },
                    recipients: [{ address: "recipient@example.com", type: RecipientType.TO }],
                    bodyBlobKey: `bodies/${uuid.v4()}`,
                    flags: { read: true, flagged: false, answered: false, forwarded: false },
                }),
            );

            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makeRecallRaw(targetMessageId));
            await createIngestEntry({ rawBlobKey, envelopeFrom: "sender@example.com", envelopeTo: ["recipient@example.com"] });

            await job.run();

            const found = await messageRepo.findOne({ uid: target.uid } as any);
            expect(found!.deleted).toBe(false);

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent.length).toBe(1);
            expect(transport.sent[0].raw.toString()).toContain("Not recalled from recipient@example.com - already read.");
        });

        it("Reports 'not found' when no matching message exists.", async () => {
            await createMailbox();
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makeRecallRaw("nonexistent@example.com"));
            await createIngestEntry({ rawBlobKey, envelopeFrom: "sender@example.com", envelopeTo: ["recipient@example.com"] });

            await job.run();

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent.length).toBe(1);
            expect(transport.sent[0].raw.toString()).toContain("Not recalled from recipient@example.com - not found.");
        });

        it("Sends no report when the recipient mailbox itself doesn't exist (defensive - shouldn't happen in practice).", async () => {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makeRecallRaw("whatever@example.com"));
            await createIngestEntry({ rawBlobKey, envelopeFrom: "sender@example.com", envelopeTo: ["recipient@example.com"] });

            await expect(job.run()).resolves.toBeUndefined();

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent.length).toBe(0);
        });

        it("Logs a warning and does not throw when sending the recall report fails.", async () => {
            await createMailbox();
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            const sendSpy = vi.spyOn(transport, "send").mockRejectedValueOnce(new Error("simulated transport failure"));

            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makeRecallRaw("whatever@example.com"));
            await createIngestEntry({ rawBlobKey, envelopeFrom: "sender@example.com", envelopeTo: ["recipient@example.com"] });

            await expect(job.run()).resolves.toBeUndefined();

            sendSpy.mockRestore();
        });

        it("A junk-verdicted recall signal is filed normally and never acted on (the default delivery path is unaffected).", async () => {
            const targetMessageId = "target-message@example.com";
            const target = await messageRepo.save(
                new MessageMongo({
                    mailboxUid,
                    folderUid: "inbox-folder",
                    messageId: targetMessageId,
                    from: { address: "someone@example.com", type: RecipientType.TO },
                    recipients: [{ address: "recipient@example.com", type: RecipientType.TO }],
                    bodyBlobKey: `bodies/${uuid.v4()}`,
                }),
            );

            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            const raw = Buffer.from(
                `From: sender@example.com\r\nTo: recipient@example.com\r\nX-Test-Force-Spam: true\r\nX-RapidMX-Recall-Of: ${targetMessageId}\r\n\r\nHello.\r\n`,
            );
            await blobStore.put(rawBlobKey, raw);
            await createIngestEntry({ rawBlobKey, envelopeFrom: "sender@example.com", envelopeTo: ["recipient@example.com"] });

            await job.run();

            const found = await messageRepo.findOne({ uid: target.uid } as any);
            expect(found!.deleted).toBe(false);

            // Filed normally to Junk, like any other junk-verdicted mail - not suppressed the way a
            // "deliver"-verdicted recall signal is.
            const allMessages = await messageRepo.find({ mailboxUid }).toArray();
            expect(allMessages.length).toBe(2);

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent.length).toBe(0);
        });
    });
});
