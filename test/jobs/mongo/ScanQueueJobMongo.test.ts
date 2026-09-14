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
import "reflect-metadata";
import * as nodeCrypto from "crypto";
import * as x509 from "@peculiar/x509";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ACLUtils, ConnectionManager, MongoConnection, MongoRepository, NotificationUtils, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../../config.js";
import { registerTestDoubles, RecordingMailTransport, StaticDnsResolver } from "../../testDoubles.js";
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
import { ContactMongo } from "../../../src/models/mongo/ContactMongo.js";
import { DomainMongo } from "../../../src/models/mongo/DomainMongo.js";
import { FocusedInboxOverrideMongo } from "../../../src/models/mongo/FocusedInboxOverrideMongo.js";
import { OofReplySuppressionMongo } from "../../../src/models/mongo/OofReplySuppressionMongo.js";
import { buildEventIcs } from "../../../src/util/IcsUtils.js";
import { buildDispositionNotification } from "../../../src/util/ReceiptUtils.js";
import {
    AttendeeResponseStatus,
    AttendeeRole,
    BusyStatus,
    CalendarEvent,
    CalendarEventStatus,
    ContactAddressKind,
    FolderType,
    IngestStatus,
    MailFilterActionType,
    MessageClassification,
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
function makeItipRawMessage(ics: string, opts: { from?: string; to?: string; dkim?: boolean } = {}): Buffer {
    const from = opts.from ?? "organizer@example.com";
    const to = opts.to ?? "recipient@example.com";
    const raw = [
        `From: ${from}`,
        `To: ${to}`,
        // iTIP is only applied from a DKIM-verified sender - see ScanQueueJob.maybeProcessItipMessage().
        ...(opts.dkim === false ? [] : [`Authentication-Results: mx.example.com; dkim=pass header.d=${from.split("@")[1]}`]),
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

/** An S/MIME EnvelopedData message - the entire body is one opaque application/pkcs7-mime part. */
function makeEncryptedRawMessage(): Buffer {
    const raw = [
        "From: sender@example.com",
        "To: recipient@example.com",
        "Subject: Encrypted message",
        'Content-Type: application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from("fake CMS EnvelopedData DER bytes").toString("base64"),
        "",
    ].join("\r\n");
    return Buffer.from(raw);
}

x509.cryptoProvider.set(crypto);

async function makeCertBase64(cn: string): Promise<string> {
    const keys: CryptoKeyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
    ]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        name: `CN=${cn}`,
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        keys,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    });
    return Buffer.from(cert.rawData).toString("base64");
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
    let focusedInboxOverrideRepo: MongoRepository<FocusedInboxOverrideMongo>;
    let contactRepo: MongoRepository<ContactMongo>;
    let domainRepo: MongoRepository<DomainMongo>;

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
        models.set("FocusedInboxOverrideMongo", FocusedInboxOverrideMongo);
        models.set("ContactMongo", ContactMongo);
        models.set("DomainMongo", DomainMongo);
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
        focusedInboxOverrideRepo = conn.getMongoRepository("FocusedInboxOverrideMongo");
        contactRepo = conn.getMongoRepository("ContactMongo");
        domainRepo = conn.getMongoRepository("DomainMongo");

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
            focusedInboxOverrideRepo,
            contactRepo,
            domainRepo,
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
        expect(messages[0].encrypted).toBe(false);
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

    it("Stamps encrypted: true on a delivered S/MIME-encrypted message.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makeEncryptedRawMessage());
        await createIngestEntry({ rawBlobKey });

        await job.run();

        const inbox = await folderRepo.findOne({ mailboxUid, type: FolderType.INBOX } as any);
        const messages = await messageRepo.find({ folderUid: inbox!.uid }).toArray();
        expect(messages.length).toBe(1);
        expect(messages[0].encrypted).toBe(true);
    });

    describe("Inbound RapidMX-Key header processing (Group E3)", () => {
        it("Does nothing (no throw) when envelopeFrom has no domain part at all.", async () => {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, Buffer.from("From: malformed\r\nTo: recipient@example.com\r\n\r\nHello.\r\n"));
            await createIngestEntry({ rawBlobKey, envelopeFrom: "malformed" });

            await expect(job.run()).resolves.toBeUndefined();

            const contacts = await contactRepo.find({ mailboxUid }).toArray();
            expect(contacts).toHaveLength(0);
        });

        it("Creates a Contact carrying the discovered key when the header is present with an aligned, passing DKIM result.", async () => {
            const keydata = await makeCertBase64("sender@example.com");
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(
                rawBlobKey,
                makePlainRawMessage(
                    `RapidMX-Key: addr=sender@example.com; prefer-encrypt=mutual; type=x509; keydata=${keydata}\r\nAuthentication-Results: mx.example.com; dkim=pass header.d=example.com`,
                ),
            );
            await createIngestEntry({ rawBlobKey });

            await job.run();

            const contacts = await contactRepo.find({ mailboxUid, "emails.address": "sender@example.com" }).toArray();
            expect(contacts).toHaveLength(1);
            expect(contacts[0].keys).toHaveLength(1);
            expect(contacts[0].keys![0].fingerprint).toMatch(/^[0-9a-f]+$/);
            expect(contacts[0].encryptPreference).toEqual({ preferEncrypt: "mutual", lastSeen: expect.any(Number) });
            expect(contacts[0].lastMessageSeen).toEqual(expect.any(Number));
        });

        it("Ignores the header (and creates no Contact) when there is no Authentication-Results header at all.", async () => {
            const keydata = await makeCertBase64("sender@example.com");
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(
                rawBlobKey,
                makePlainRawMessage(`RapidMX-Key: addr=sender@example.com; type=x509; keydata=${keydata}`),
            );
            await createIngestEntry({ rawBlobKey });

            await job.run();

            const contacts = await contactRepo.find({ mailboxUid, "emails.address": "sender@example.com" }).toArray();
            expect(contacts).toHaveLength(0);
        });

        it("Ignores the header when DKIM failed, even though the header itself is well-formed.", async () => {
            const keydata = await makeCertBase64("sender@example.com");
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(
                rawBlobKey,
                makePlainRawMessage(
                    `RapidMX-Key: addr=sender@example.com; type=x509; keydata=${keydata}\r\nAuthentication-Results: mx.example.com; dkim=fail header.d=example.com`,
                ),
            );
            await createIngestEntry({ rawBlobKey });

            await job.run();

            const contacts = await contactRepo.find({ mailboxUid, "emails.address": "sender@example.com" }).toArray();
            expect(contacts).toHaveLength(0);
        });

        it("Stamps lastMessageSeen on an existing Contact for a message with no key header, leaving its pinned key untouched (Anti-Downgrade).", async () => {
            const pinnedKey = { publicKey: "b64", type: "x509", useType: "encrypt" as const, fingerprint: "fp-pinned", notBefore: 0, notAfter: Date.now() + 1_000_000 };
            await contactRepo.save(
                new ContactMongo({
                    mailboxUid,
                    folderUid: uuid.v4(),
                    displayName: "sender@example.com",
                    emails: [{ address: "sender@example.com", type: "other" as any }],
                    phones: [],
                    addresses: [],
                    keys: [pinnedKey],
                    encryptPreference: { preferEncrypt: "mutual", lastSeen: 5 },
                }),
            );
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makePlainRawMessage());
            await createIngestEntry({ rawBlobKey });

            await job.run();

            const contacts = await contactRepo.find({ mailboxUid, "emails.address": "sender@example.com" }).toArray();
            expect(contacts).toHaveLength(1);
            expect(contacts[0].keys).toEqual([pinnedKey]);
            expect(contacts[0].encryptPreference).toEqual({ preferEncrypt: "mutual", lastSeen: 5 });
            expect(contacts[0].lastMessageSeen).toEqual(expect.any(Number));
        });

        it("Does not create a Contact for a message with no key header when none already exists.", async () => {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makePlainRawMessage());
            await createIngestEntry({ rawBlobKey });

            await job.run();

            const contacts = await contactRepo.find({ mailboxUid, "emails.address": "sender@example.com" }).toArray();
            expect(contacts).toHaveLength(0);
        });

        it("Ignores more than one RapidMX-Key header on the same message.", async () => {
            const keydata = await makeCertBase64("sender@example.com");
            const oneHeader = `RapidMX-Key: addr=sender@example.com; type=x509; keydata=${keydata}`;
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(
                rawBlobKey,
                makePlainRawMessage(`${oneHeader}\r\n${oneHeader}\r\nAuthentication-Results: mx.example.com; dkim=pass header.d=example.com`),
            );
            await createIngestEntry({ rawBlobKey });

            await job.run();

            const contacts = await contactRepo.find({ mailboxUid, "emails.address": "sender@example.com" }).toArray();
            expect(contacts).toHaveLength(0);
        });
    });

    it("Sets conversationId to the message's own resolved messageId when it has no References/In-Reply-To (starts a new conversation).", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(
            rawBlobKey,
            Buffer.from("From: sender@example.com\r\nTo: recipient@example.com\r\nMessage-ID: <root@example.com>\r\n\r\nHello.\r\n"),
        );
        await createIngestEntry({ rawBlobKey });

        await job.run();

        const inbox = await folderRepo.findOne({ mailboxUid, type: FolderType.INBOX } as any);
        const messages = await messageRepo.find({ folderUid: inbox!.uid }).toArray();
        expect(messages[0].messageId).toBe("root@example.com");
        expect(messages[0].conversationId).toBe("root@example.com");
        expect(messages[0].inReplyTo).toBeUndefined();
        expect(messages[0].references).toEqual([]);
    });

    it("Sets conversationId from References/In-Reply-To when the inbound message is a reply.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(
            rawBlobKey,
            Buffer.from(
                "From: sender@example.com\r\nTo: recipient@example.com\r\nMessage-ID: <reply@example.com>\r\n" +
                    "In-Reply-To: <root@example.com>\r\nReferences: <root@example.com>\r\n\r\nReply body.\r\n",
            ),
        );
        await createIngestEntry({ rawBlobKey });

        await job.run();

        const inbox = await folderRepo.findOne({ mailboxUid, type: FolderType.INBOX } as any);
        const messages = await messageRepo.find({ folderUid: inbox!.uid }).toArray();
        expect(messages[0].inReplyTo).toBe("root@example.com");
        expect(messages[0].references).toEqual(["root@example.com"]);
        expect(messages[0].conversationId).toBe("root@example.com");
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
        expect(updated!.attempts).toBe(1);
        expect(new Date(updated!.nextAttemptAt!).getTime()).toBeGreaterThan(Date.now());
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

    it("Applies an APPLY_LABEL rule, stamping the delivered message (and any COPY_TO_FOLDER copy) with the label uid.", async () => {
        const copyFolder = await folderRepo.save(
            new FolderMongo({ mailboxUid, name: "Archive", type: FolderType.USER, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }),
        );
        await mailFilterRuleRepo.save(
            new MailFilterRuleMongo({
                mailboxUid,
                name: "Label and copy",
                enabled: true,
                sequence: 0,
                stopProcessingRules: false,
                conditions: { subjectContains: ["Test message"] },
                actions: [
                    { type: MailFilterActionType.APPLY_LABEL, labelUid: "label-1" },
                    { type: MailFilterActionType.COPY_TO_FOLDER, folderUid: copyFolder.uid },
                ],
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
        expect(inboxMessages[0].labelUids).toEqual(["label-1"]);

        const copyMessages = await messageRepo.find({ folderUid: copyFolder.uid }).toArray();
        expect(copyMessages.length).toBe(1);
        expect(copyMessages[0].labelUids).toEqual(["label-1"]);
    });

    it("Applies a FORWARD rule, relaying the original raw message to the forward address via MailTransport.", async () => {
        await createMailbox();
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
        // Sent from the forwarding mailbox (a minimal SRS), marked against forwarding loops.
        expect(forwarded!.envelopeFrom).toBe("recipient@example.com");
        expect(forwarded!.raw.toString()).toContain("X-RapidMX-Loop: recipient@example.com");
        expect(forwarded!.raw.toString()).toContain("From: sender@example.com");
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
            expect(events[0].encryptionOrigin).toBe("none");
            const calendarFolder = await folderRepo.findOne({ mailboxUid, type: FolderType.CALENDAR } as any);
            expect(events[0].folderUid).toBe(calendarFolder!.uid);
        });

        it("Preserves encryptionOrigin: 'derived' on an existing event when a later resent REQUEST updates it - encryption state is sticky, never recomputed from the current message.", async () => {
            const icalUid = uuid.v4();
            const folder = await folderRepo.save(
                new FolderMongo({ mailboxUid, name: "Calendar", type: FolderType.CALENDAR, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }),
            );
            await calendarEventRepo.save(
                new CalendarEventMongo({
                    folderUid: folder.uid,
                    mailboxUid,
                    title: "Team Sync",
                    startDate: new Date(),
                    endDate: new Date(),
                    timezone: "UTC",
                    organizer: { address: "organizer@example.com", type: "to" as any },
                    icalUid,
                    sequence: 0,
                    encryptionOrigin: "derived",
                }),
            );

            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(
                rawBlobKey,
                makeItipRawMessage(buildEventIcs(makeIcsEventFixture({ icalUid, sequence: 1, title: "Team Sync (moved)" }), "REQUEST")),
            );
            await createIngestEntry({ rawBlobKey, envelopeFrom: "organizer@example.com", envelopeTo: ["recipient@example.com"] });

            await job.run();

            const events = await calendarEventRepo.find({ mailboxUid, icalUid }).toArray();
            expect(events.length).toBe(1);
            expect(events[0].title).toBe("Team Sync (moved)");
            expect(events[0].encryptionOrigin).toBe("derived");
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
        const makeRecallRaw = (targetMessageId: string, dkim: boolean = true): Buffer =>
            makePlainRawMessage(
                `X-RapidMX-Recall-Of: ${targetMessageId}${dkim ? "\r\nAuthentication-Results: mx.example.com; dkim=pass header.d=example.com" : ""}`,
            );

        it("Deletes the target message and reports success when it's still unread.", async () => {
            await createMailbox();
            const targetMessageId = "target-message@example.com";
            const target = await messageRepo.save(
                new MessageMongo({
                    mailboxUid,
                    folderUid: "inbox-folder",
                    messageId: targetMessageId,
                    from: { address: "sender@example.com", type: RecipientType.TO },
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
                    from: { address: "sender@example.com", type: RecipientType.TO },
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

    describe("Focused Inbox classification", () => {
        /** Queues one plain message from `envelopeFrom`, optionally with an extra header, and runs the job. */
        const deliverFrom = async (envelopeFrom: string, extraHeader?: string): Promise<MessageMongo> => {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(
                rawBlobKey,
                Buffer.from(
                    `From: ${envelopeFrom}\r\nTo: recipient@example.com\r\n` +
                        `Subject: Plain message\r\n${extraHeader ? `${extraHeader}\r\n` : ""}\r\nHello there.\r\n`,
                ),
            );
            await createIngestEntry({ rawBlobKey, envelopeFrom });
            await job.run();

            const messages = await messageRepo.find({ mailboxUid }).toArray();
            expect(messages.length).toBe(1);
            return messages[0];
        };

        it("Classifies ordinary mail from a stranger as focused.", async () => {
            await createMailbox();

            const message = await deliverFrom("stranger@outside.com");

            expect(message.inferenceClassification).toBe(MessageClassification.FOCUSED);
        });

        it("Classifies mail carrying a List-Unsubscribe header as other.", async () => {
            await createMailbox();

            const message = await deliverFrom("news@outside.com", "List-Unsubscribe: <https://outside.com/u>");

            expect(message.inferenceClassification).toBe(MessageClassification.OTHER);
        });

        it("Classifies mail from a verified local domain as focused, even when it looks like bulk otherwise.", async () => {
            await createMailbox();
            await domainRepo.save(
                new DomainMongo({
                    uid: "example.com",
                    name: "example.com",
                    enabled: true,
                    verified: true,
                    verificationToken: uuid.v4(),
                }),
            );

            const message = await deliverFrom("colleague@example.com");

            expect(message.inferenceClassification).toBe(MessageClassification.FOCUSED);
        });

        it("Classifies mail from a sender in the mailbox's Contacts as focused.", async () => {
            await createMailbox();
            await contactRepo.save(
                new ContactMongo({
                    mailboxUid,
                    folderUid: uuid.v4(),
                    displayName: "Known Person",
                    emails: [{ address: "known@outside.com", type: ContactAddressKind.WORK }],
                }),
            );

            const message = await deliverFrom("known@outside.com", "List-Unsubscribe: <https://outside.com/u>");

            // The contact makes them a known correspondent, but the bulk header still wins - a newsletter is a
            // newsletter even from someone in your address book.
            expect(message.inferenceClassification).toBe(MessageClassification.OTHER);

            await messageRepo.clear();
            const plain = await deliverFrom("known@outside.com");
            expect(plain.inferenceClassification).toBe(MessageClassification.FOCUSED);
        });

        it("Classifies a reply into a thread this mailbox already holds as focused.", async () => {
            await createMailbox();
            const inbox = await folderRepo.save(
                new FolderMongo({ mailboxUid, name: "Inbox", type: FolderType.INBOX, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }),
            );
            await messageRepo.save(
                new MessageMongo({
                    folderUid: inbox.uid,
                    mailboxUid,
                    messageId: "root@outside.com",
                    conversationId: "root@outside.com",
                    subject: "Original",
                    from: { address: "stranger@outside.com", type: RecipientType.TO },
                    recipients: [{ address: "recipient@example.com", type: RecipientType.TO }],
                    sentDate: new Date(),
                    receivedDate: new Date(),
                    bodyBlobKey: `raw/${uuid.v4()}`,
                    bodyPreview: "Original",
                    flags: { read: false, flagged: false, answered: false, forwarded: false },
                    references: [],
                    hasAttachments: false,
                }),
            );

            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(
                rawBlobKey,
                Buffer.from(
                    "From: stranger@outside.com\r\nTo: recipient@example.com\r\nSubject: Re: Original\r\n" +
                        "In-Reply-To: <root@outside.com>\r\nReferences: <root@outside.com>\r\n\r\nReplying.\r\n",
                ),
            );
            await createIngestEntry({ rawBlobKey, envelopeFrom: "stranger@outside.com" });
            await job.run();

            const reply = (await messageRepo.find({ mailboxUid, subject: "Re: Original" }).toArray())[0];
            expect(reply.conversationId).toBe("root@outside.com");
            expect(reply.inferenceClassification).toBe(MessageClassification.FOCUSED);
        });

        it("An explicit override wins over the bulk headers that would otherwise force other.", async () => {
            await createMailbox();
            await focusedInboxOverrideRepo.save(
                new FocusedInboxOverrideMongo({
                    mailboxUid,
                    senderAddress: "news@outside.com",
                    classifyAs: MessageClassification.FOCUSED,
                }),
            );

            const message = await deliverFrom("news@outside.com", "List-Unsubscribe: <https://outside.com/u>");

            expect(message.inferenceClassification).toBe(MessageClassification.FOCUSED);
        });

        it("Leaves junk-routed mail unclassified - Focused/Other is an Inbox-only concept.", async () => {
            await createMailbox();

            const message = await deliverFrom("spammer@outside.com", "X-Test-Force-Spam: true");

            const folder = await folderRepo.findOne({ uid: message.folderUid } as any);
            expect(folder!.type).toBe(FolderType.JUNK);
            expect(message.inferenceClassification).toBeFalsy();
        });

        it("Leaves mail a rule filed outside the Inbox unclassified.", async () => {
            await createMailbox();
            const targetFolder = await folderRepo.save(
                new FolderMongo({ mailboxUid, name: "Filed", type: FolderType.USER, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }),
            );
            await mailFilterRuleRepo.save(
                new MailFilterRuleMongo({
                    mailboxUid,
                    name: "File it",
                    enabled: true,
                    sequence: 0,
                    stopProcessingRules: false,
                    conditions: { fromContains: ["stranger@outside.com"] },
                    actions: [{ type: MailFilterActionType.MOVE_TO_FOLDER, folderUid: targetFolder.uid }],
                }),
            );

            const message = await deliverFrom("stranger@outside.com");

            expect(message.folderUid).toBe(targetFolder.uid);
            expect(message.inferenceClassification).toBeFalsy();
        });
    });

    describe("Delivery/read receipts", () => {
        /** Queues a plain message from (and requesting a receipt back to) `address`, and runs the job.
         * `Disposition-Notification-To` is always the sender's own address - matching both how `send()`
         * actually composes it and `deliverMessage()`'s own gate (`specs/end-to-end_encryption.md` §Header
         * Integrity: "The address in Disposition-Notification-To MUST be compared against the From address
         * ... A mismatch MUST cause the request to be ignored"), so this helper no longer accepts a separate
         * "requester" - a real inbound message can't legitimately have one. Includes a real, aligned
         * `Authentication-Results` header (matching `mail:security:trusted_authserv_id`'s test config value,
         * `mx.example.com`) so `hasAlignedPassingDkim()` - required before any receipt is even considered -
         * passes; without it every one of this describe block's scenarios would be gated off before ever
         * reaching the tier-classification logic they actually test. */
        const deliverRequestingReceipt = async (address: string): Promise<MessageMongo> => {
            const domain = address.split("@")[1];
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(
                rawBlobKey,
                Buffer.from(
                    `From: ${address}\r\nTo: recipient@example.com\r\nSubject: Plain message\r\n` +
                        `Disposition-Notification-To: ${address}\r\n` +
                        `Authentication-Results: mx.example.com; dkim=pass header.d=${domain}\r\n\r\nHello there.\r\n`,
                ),
            );
            await createIngestEntry({ rawBlobKey, envelopeFrom: address });
            await job.run();

            const messages = await messageRepo.find({ mailboxUid }).toArray();
            expect(messages.length).toBe(1);
            return messages[0];
        };

        const verifiedDomain = async (): Promise<void> => {
            await domainRepo.save(
                new DomainMongo({
                    uid: "example.com",
                    name: "example.com",
                    enabled: true,
                    verified: true,
                    verificationToken: uuid.v4(),
                }),
            );
        };

        it("Sends a delivery receipt immediately for an internal requester (the default) and stamps the delivered copy.", async () => {
            await createMailbox();
            await verifiedDomain();

            const message = await deliverRequestingReceipt("colleague@example.com");

            expect(message.dispositionNotificationTo).toBe("colleague@example.com");
            expect(message.deliveryReceiptSentAt).toBeInstanceOf(Date);
            expect(message.deliveryReceiptPending).toBe(false);

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent).toHaveLength(1);
            expect(transport.sent[0].envelopeTo).toEqual(["colleague@example.com"]);
            expect(transport.sent[0].raw.toString()).toContain("multipart/report");
        });

        it("Holds the delivery receipt pending approval for an external requester (the default).", async () => {
            await createMailbox();

            const message = await deliverRequestingReceipt("stranger@outside.com");

            expect(message.dispositionNotificationTo).toBe("stranger@outside.com");
            expect(message.deliveryReceiptSentAt).toBeUndefined();
            expect(message.deliveryReceiptPending).toBe(true);

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent).toHaveLength(0);
        });

        it("Sends immediately for an external requester when the mailbox opts in via autoSendReceiptsExternal.", async () => {
            await createMailbox({ autoSendReceiptsExternal: true });

            const message = await deliverRequestingReceipt("stranger@outside.com");

            expect(message.deliveryReceiptSentAt).toBeInstanceOf(Date);
            expect(message.deliveryReceiptPending).toBe(false);
        });

        it("Does NOT send immediately for an external requester when the mailbox only opts in via autoSendReceiptsFederated - 'outside.com' publishes no _rapidmx record so it classifies as external, not federated, and autoSendReceiptsExternal (left false here) is the setting that actually governs.", async () => {
            await createMailbox({ autoSendReceiptsFederated: true });

            const message = await deliverRequestingReceipt("stranger@outside.com");

            expect(message.deliveryReceiptSentAt).toBeFalsy();
            expect(message.deliveryReceiptPending).toBe(true);
        });

        it("DOES send immediately for a real federated peer once its _rapidmx TXT record resolves, when the mailbox opts in via autoSendReceiptsFederated (proves classifyRecipientTier() is wired to real DNS resolution, not just the stub).", async () => {
            await createMailbox({ autoSendReceiptsFederated: true });
            const dnsResolver = objectFactory.getInstance<StaticDnsResolver>("DnsResolver")!;
            dnsResolver.records.set("_rapidmx.federated-peer-mongo.example", [
                ["v=RMXv1; id=1; host=mail.federated-peer-mongo.example;"],
            ]);

            const message = await deliverRequestingReceipt("peer@federated-peer-mongo.example");

            expect(message.deliveryReceiptSentAt).toBeInstanceOf(Date);
            expect(message.deliveryReceiptPending).toBe(false);
        });

        it("Does nothing receipt-related when no receipt was requested at all.", async () => {
            await createMailbox();

            const message = await deliverFromPlain();

            expect(message.dispositionNotificationTo).toBeUndefined();
            expect(message.deliveryReceiptSentAt).toBeUndefined();
            expect(message.deliveryReceiptPending).toBe(false);
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent).toHaveLength(0);
        });

        /** A plain message with no receipt-request header at all. */
        async function deliverFromPlain(): Promise<MessageMongo> {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makePlainRawMessage());
            await createIngestEntry({ rawBlobKey });
            await job.run();
            return (await messageRepo.find({ mailboxUid }).toArray())[0];
        }

        it("Does not send a delivery receipt for a message a MailFilterRule deletes outright.", async () => {
            await createMailbox();
            await mailFilterRuleRepo.save(
                new MailFilterRuleMongo({
                    mailboxUid,
                    name: "Discard it",
                    enabled: true,
                    sequence: 0,
                    stopProcessingRules: false,
                    conditions: { fromContains: ["sender@example.com"] },
                    actions: [{ type: MailFilterActionType.DELETE }],
                }),
            );

            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(
                rawBlobKey,
                Buffer.from(
                    "From: sender@example.com\r\nTo: recipient@example.com\r\nSubject: Plain message\r\n" +
                        "Disposition-Notification-To: sender@example.com\r\n\r\nHello there.\r\n",
                ),
            );
            await createIngestEntry({ rawBlobKey });
            await job.run();

            expect((await messageRepo.find({ mailboxUid }).toArray()).length).toBe(0);
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent).toHaveLength(0);
        });

        it("An inbound MDN updates the matching recipient's roster entry and is never filed as a visible message.", async () => {
            await createMailbox();
            const sentFolder = await folderRepo.save(
                new FolderMongo({ mailboxUid, name: "Sent Items", type: FolderType.SENT_ITEMS, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }),
            );
            const sent = await messageRepo.save(
                new MessageMongo({
                    folderUid: sentFolder.uid,
                    mailboxUid,
                    messageId: "original@example.com",
                    subject: "Hello",
                    from: { address: "recipient@example.com", type: RecipientType.TO },
                    recipients: [{ address: "bob@example.com", type: RecipientType.TO }],
                    sentDate: new Date(),
                    receivedDate: new Date(),
                    bodyBlobKey: `raw/${uuid.v4()}`,
                    bodyPreview: "Hello",
                    flags: { read: true, flagged: false, answered: false, forwarded: false },
                    references: [],
                    hasAttachments: false,
                    receiptStatus: [{ recipientAddress: "bob@example.com" }],
                }),
            );

            let mdn: Buffer = await buildDispositionNotification({
                from: { address: "bob@example.com" },
                to: "recipient@example.com",
                subject: "Read: Hello",
                finalRecipient: "bob@example.com",
                originalMessageId: "original@example.com",
                dispositionType: "read",
                reportingUa: "mail.example.com; RapidMX",
            });
            // `processReceipt()` now requires a real, aligned `Authentication-Results` header (Receipt
            // Verification checks 1+2) before acting on any MDN at all - see `deliverRequestingReceipt()`'s
            // own comment above for why.
            mdn = Buffer.concat([Buffer.from("Authentication-Results: mx.example.com; dkim=pass header.d=example.com\r\n"), mdn]);
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, mdn);
            await createIngestEntry({ rawBlobKey, envelopeFrom: "bob@example.com" });

            const beforeCount = (await messageRepo.find({ mailboxUid }).toArray()).length;
            await job.run();
            const afterCount = (await messageRepo.find({ mailboxUid }).toArray()).length;

            // The MDN itself was never filed - the message count is unchanged (still just the pre-seeded sent
            // message).
            expect(afterCount).toBe(beforeCount);

            const updated = await messageRepo.findOne({ uid: sent.uid } as any);
            expect(updated!.receiptStatus).toEqual([{ recipientAddress: "bob@example.com", readAt: expect.any(String) }]);
        });

        it("Appends a new roster entry when the MDN's Final-Recipient matches no pre-seeded entry (the distribution-list-expansion case).", async () => {
            await createMailbox();
            const sentFolder = await folderRepo.save(
                new FolderMongo({ mailboxUid, name: "Sent Items", type: FolderType.SENT_ITEMS, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }),
            );
            const sent = await messageRepo.save(
                new MessageMongo({
                    folderUid: sentFolder.uid,
                    mailboxUid,
                    messageId: "original@example.com",
                    subject: "Hello",
                    from: { address: "recipient@example.com", type: RecipientType.TO },
                    recipients: [{ address: "list@example.com", type: RecipientType.TO }],
                    sentDate: new Date(),
                    receivedDate: new Date(),
                    bodyBlobKey: `raw/${uuid.v4()}`,
                    bodyPreview: "Hello",
                    flags: { read: true, flagged: false, answered: false, forwarded: false },
                    references: [],
                    hasAttachments: false,
                    receiptStatus: [{ recipientAddress: "list@example.com" }],
                }),
            );

            let mdn: Buffer = await buildDispositionNotification({
                from: { address: "carol@example.com" },
                to: "recipient@example.com",
                subject: "Delivered: Hello",
                finalRecipient: "carol@example.com",
                originalMessageId: "original@example.com",
                dispositionType: "delivery",
                reportingUa: "mail.example.com; RapidMX",
            });
            mdn = Buffer.concat([Buffer.from("Authentication-Results: mx.example.com; dkim=pass header.d=example.com\r\n"), mdn]);
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, mdn);
            await createIngestEntry({ rawBlobKey, envelopeFrom: "carol@example.com" });
            await job.run();

            const updated = await messageRepo.findOne({ uid: sent.uid } as any);
            expect(updated!.receiptStatus).toEqual(
                expect.arrayContaining([
                    { recipientAddress: "list@example.com" },
                    { recipientAddress: "carol@example.com", deliveredAt: expect.any(String) },
                ]),
            );
        });

        it("Silently drops an MDN whose Original-Message-ID matches nothing in this mailbox, still never filing it.", async () => {
            await createMailbox();

            const mdn: Buffer = await buildDispositionNotification({
                from: { address: "bob@example.com" },
                to: "recipient@example.com",
                subject: "Read: Hello",
                finalRecipient: "bob@example.com",
                originalMessageId: "no-such-message@example.com",
                dispositionType: "read",
                reportingUa: "mail.example.com; RapidMX",
            });
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, mdn);
            await createIngestEntry({ rawBlobKey, envelopeFrom: "bob@example.com" });

            await expect(job.run()).resolves.toBeUndefined();
            expect((await messageRepo.find({ mailboxUid }).toArray()).length).toBe(0);
        });

        it("Drops an MDN whose claimed Final-Recipient does not match its own envelope sender (forgery attempt) and does not update the roster.", async () => {
            await createMailbox();
            const sentFolder = await folderRepo.save(
                new FolderMongo({ mailboxUid, name: "Sent Items", type: FolderType.SENT_ITEMS, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }),
            );
            const sent = await messageRepo.save(
                new MessageMongo({
                    folderUid: sentFolder.uid,
                    mailboxUid,
                    messageId: "original@example.com",
                    subject: "Hello",
                    from: { address: "recipient@example.com", type: RecipientType.TO },
                    recipients: [{ address: "bob@example.com", type: RecipientType.TO }],
                    sentDate: new Date(),
                    receivedDate: new Date(),
                    bodyBlobKey: `raw/${uuid.v4()}`,
                    bodyPreview: "Hello",
                    flags: { read: true, flagged: false, answered: false, forwarded: false },
                    references: [],
                    hasAttachments: false,
                    receiptStatus: [{ recipientAddress: "bob@example.com" }],
                }),
            );

            // Sent from mallory@example.com's own mailbox, but the MDN body itself dishonestly claims to be
            // reporting bob@example.com's disposition - exactly the forgery this authenticity check exists to
            // catch, since Mallory could otherwise fabricate a fake "read" timestamp for an address she was
            // never actually sent the message at.
            const mdn: Buffer = await buildDispositionNotification({
                from: { address: "mallory@example.com" },
                to: "recipient@example.com",
                subject: "Read: Hello",
                finalRecipient: "bob@example.com",
                originalMessageId: "original@example.com",
                dispositionType: "read",
                reportingUa: "mail.example.com; RapidMX",
            });
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, mdn);
            await createIngestEntry({ rawBlobKey, envelopeFrom: "mallory@example.com" });

            await job.run();

            const updated = await messageRepo.findOne({ uid: sent.uid } as any);
            expect(updated!.receiptStatus).toEqual([{ recipientAddress: "bob@example.com" }]);
        });

        it("Silently drops an MDN part that has no resolvable Disposition at all, still never filing it.", async () => {
            await createMailbox();

            // Hand-rolled rather than via `buildDispositionNotification()` (which always includes a
            // `Disposition` line) - a malformed/incomplete MDN part is exactly the case this test exists for.
            const raw = [
                "From: bob@example.com",
                "To: recipient@example.com",
                "Subject: Malformed MDN",
                'Content-Type: multipart/report; report-type=disposition-notification; boundary="B"',
                "",
                "--B",
                "Content-Type: text/plain",
                "",
                "This is a receipt.",
                "",
                "--B",
                "Content-Type: message/disposition-notification",
                "",
                "Original-Message-ID: <original@example.com>",
                "",
                "--B--",
                "",
            ].join("\r\n");
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, Buffer.from(raw));
            await createIngestEntry({ rawBlobKey, envelopeFrom: "bob@example.com" });

            await expect(job.run()).resolves.toBeUndefined();
            expect((await messageRepo.find({ mailboxUid }).toArray()).length).toBe(0);
        });

        it("Logs rather than throws when sending the delivery receipt fails outright.", async () => {
            await createMailbox();
            await verifiedDomain();
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            const spy = vi.spyOn(transport, "send").mockRejectedValueOnce(new Error("smtp is down"));

            const message = await deliverRequestingReceipt("colleague@example.com");

            expect(message.deliveryReceiptSentAt).toBeUndefined();
            expect(message.deliveryReceiptPending).toBe(false);
            spy.mockRestore();
        });

        it("Attaches the X-RapidMX-Key-Fingerprint extension field on an outgoing MDN when the sending mailbox has an active encrypt key (Group E5).", async () => {
            await createMailbox({
                keys: [
                    {
                        publicKey: "b64",
                        type: "x509",
                        useType: "encrypt",
                        fingerprint: "own-fp",
                        notBefore: Date.now() - 1000,
                        notAfter: Date.now() + 1_000_000,
                    },
                ],
            });
            await verifiedDomain();

            await deliverRequestingReceipt("colleague@example.com");

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent[0].raw.toString()).toContain("X-RapidMX-Key-Fingerprint: own-fp");
        });

        it("Omits the X-RapidMX-Key-Fingerprint extension field when the sending mailbox has no active encrypt key.", async () => {
            await createMailbox();
            await verifiedDomain();

            await deliverRequestingReceipt("colleague@example.com");

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent[0].raw.toString()).not.toContain("X-RapidMX-Key-Fingerprint");
        });
    });

    describe("Rotation Notification (Group E5)", () => {
        let mockFetch: ReturnType<typeof vi.fn>;

        beforeEach(() => {
            mockFetch = vi.fn();
            vi.stubGlobal("fetch", mockFetch);
        });

        // `KeyringUtils.sanitizeDiscoveredKey()` drops (never pins) a discovered key whose certificate doesn't
        // parse, and always recomputes `fingerprint` from it rather than trusting an asserted value - `cn` is
        // only used to make each generated certificate distinguishable across tests; the real fingerprint is
        // returned alongside the response since it can't be dictated up front.
        async function makeDiscoveryResponse(cn: string): Promise<{ response: any; fingerprint: string }> {
            const publicKey = await makeCertBase64(cn);
            const cert = new nodeCrypto.X509Certificate(Buffer.from(publicKey, "base64"));
            const fingerprint = cert.fingerprint256.replace(/:/g, "").toLowerCase();
            return {
                response: {
                    encryptPreference: { preferEncrypt: "mutual", lastSeen: 100 },
                    keys: [{ publicKey, type: "x509", useType: "encrypt", fingerprint: "ignored-recomputed-by-server", notBefore: 0, notAfter: Date.now() + 1_000_000 }],
                    escrow: false,
                },
                fingerprint,
            };
        }

        it("Re-runs real Discovery (never trusting the MDN's own claimed fingerprint) when X-RapidMX-Key-Fingerprint is present.", async () => {
            await createMailbox();
            const dnsResolver = objectFactory.getInstance<StaticDnsResolver>("DnsResolver")!;
            dnsResolver.records.set("_rapidmx.rotated-peer-mongo.example", [
                ["v=RMXv1; id=1; host=mail.rotated-peer-mongo.example;"],
            ]);
            const { response: discoveryResponse, fingerprint: discoveredFingerprint } = await makeDiscoveryResponse("rotated-1");
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                json: vi.fn().mockResolvedValue(discoveryResponse),
                headers: { get: () => null },
            });

            let mdn: Buffer = await buildDispositionNotification({
                from: { address: "bob@rotated-peer-mongo.example" },
                to: "recipient@example.com",
                subject: "Read: Hello",
                finalRecipient: "bob@rotated-peer-mongo.example",
                originalMessageId: "no-such-message@example.com",
                dispositionType: "read",
                reportingUa: "mail.example.com; RapidMX",
                rotatedKeyFingerprint: "claimed-fp-not-to-be-trusted",
            });
            mdn = Buffer.concat([
                Buffer.from("Authentication-Results: mx.example.com; dkim=pass header.d=rotated-peer-mongo.example\r\n"),
                mdn,
            ]);
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, mdn);
            await createIngestEntry({ rawBlobKey, envelopeFrom: "bob@rotated-peer-mongo.example" });

            await job.run();

            expect(mockFetch).toHaveBeenCalled();
            const contacts = await contactRepo.find({ mailboxUid, "emails.address": "bob@rotated-peer-mongo.example" }).toArray();
            expect(contacts).toHaveLength(1);
            expect(contacts[0].keys).toHaveLength(1);
            expect(contacts[0].keys![0].fingerprint).toBe(discoveredFingerprint);
        });

        it("Also triggers the re-lookup when only X-RapidMX-Policy-Id (not the fingerprint field) is present.", async () => {
            await createMailbox();
            const dnsResolver = objectFactory.getInstance<StaticDnsResolver>("DnsResolver")!;
            dnsResolver.records.set("_rapidmx.rotated-peer-mongo-2.example", [
                ["v=RMXv1; id=1; host=mail.rotated-peer-mongo-2.example;"],
            ]);
            const { response: discoveryResponse2 } = await makeDiscoveryResponse("rotated-2");
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                json: vi.fn().mockResolvedValue(discoveryResponse2),
                headers: { get: () => null },
            });

            let mdn: Buffer = await buildDispositionNotification({
                from: { address: "bob@rotated-peer-mongo-2.example" },
                to: "recipient@example.com",
                subject: "Read: Hello",
                finalRecipient: "bob@rotated-peer-mongo-2.example",
                originalMessageId: "no-such-message@example.com",
                dispositionType: "read",
                reportingUa: "mail.example.com; RapidMX",
                policyId: "1",
            });
            mdn = Buffer.concat([
                Buffer.from("Authentication-Results: mx.example.com; dkim=pass header.d=rotated-peer-mongo-2.example\r\n"),
                mdn,
            ]);
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, mdn);
            await createIngestEntry({ rawBlobKey, envelopeFrom: "bob@rotated-peer-mongo-2.example" });

            await job.run();

            expect(mockFetch).toHaveBeenCalled();
        });

        it("Does not call fetch at all when the MDN carries neither extension field.", async () => {
            await createMailbox();

            const mdn: Buffer = await buildDispositionNotification({
                from: { address: "bob@example.com" },
                to: "recipient@example.com",
                subject: "Read: Hello",
                finalRecipient: "bob@example.com",
                originalMessageId: "no-such-message@example.com",
                dispositionType: "read",
                reportingUa: "mail.example.com; RapidMX",
            });
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, mdn);
            await createIngestEntry({ rawBlobKey, envelopeFrom: "bob@example.com" });

            await job.run();

            expect(mockFetch).not.toHaveBeenCalled();
        });

        it("Anti-Downgrade: leaves an existing pinned key untouched (and never calls fetch) when the peer's domain isn't a federated peer at all.", async () => {
            await createMailbox();
            await contactRepo.save(
                new ContactMongo({
                    mailboxUid,
                    folderUid: uuid.v4(),
                    displayName: "Bob",
                    emails: [{ address: "bob@not-federated-mongo.example", type: ContactAddressKind.OTHER }],
                    phones: [],
                    addresses: [],
                    keys: [
                        { publicKey: "b64", type: "x509", useType: "encrypt", fingerprint: "pinned-fp", notBefore: 0, notAfter: Date.now() + 1_000_000 },
                    ],
                }),
            );

            let mdn: Buffer = await buildDispositionNotification({
                from: { address: "bob@not-federated-mongo.example" },
                to: "recipient@example.com",
                subject: "Read: Hello",
                finalRecipient: "bob@not-federated-mongo.example",
                originalMessageId: "no-such-message@example.com",
                dispositionType: "read",
                reportingUa: "mail.example.com; RapidMX",
                rotatedKeyFingerprint: "claimed-fp",
            });
            // A real, aligned `Authentication-Results` header - unlike the other "never calls fetch" test in
            // this describe block, this one needs `processReceipt()`'s DKIM gate to actually pass so it
            // reaches `maybeRefreshRotatedKey()` and exercises ITS OWN "not a federated peer" no-op path
            // (`discoverAndMergeKeys()` returning `undefined`), not just the earlier DKIM gate.
            mdn = Buffer.concat([
                Buffer.from("Authentication-Results: mx.example.com; dkim=pass header.d=not-federated-mongo.example\r\n"),
                mdn,
            ]);
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, mdn);
            await createIngestEntry({ rawBlobKey, envelopeFrom: "bob@not-federated-mongo.example" });

            await job.run();

            expect(mockFetch).not.toHaveBeenCalled();
            const contacts = await contactRepo.find({ mailboxUid, "emails.address": "bob@not-federated-mongo.example" }).toArray();
            expect(contacts[0].keys![0].fingerprint).toBe("pinned-fp");
        });
    });

    describe("Queue recovery and idempotent delivery", () => {
        it("Retries a failed entry once its backoff has passed, delivering it exactly once.", async () => {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            const entry = await createIngestEntry({ rawBlobKey });

            await job.run();
            expect((await ingestQueueRepo.findOne({ uid: entry.uid } as any))!.status).toBe(IngestStatus.FAILED);

            // Not due yet: nothing happens.
            await blobStore.put(rawBlobKey, makeRawMessage());
            await job.run();
            expect((await ingestQueueRepo.findOne({ uid: entry.uid } as any))!.status).toBe(IngestStatus.FAILED);

            await ingestQueueRepo.updateOne({ uid: entry.uid }, { $set: { nextAttemptAt: new Date(Date.now() - 1000) } });
            await job.run();

            const delivered = await ingestQueueRepo.findOne({ uid: entry.uid } as any);
            expect(delivered!.status).toBe(IngestStatus.DELIVERED);
            expect((await messageRepo.find({ mailboxUid }).toArray()).length).toBe(1);
        });

        it("Leaves an entry FAILED with no further retry once max_attempts is reached.", async () => {
            const maxAttempts: number = (job as any).maxAttempts;
            const entry = await createIngestEntry({
                rawBlobKey: `raw/${uuid.v4()}`,
                status: IngestStatus.FAILED,
                attempts: maxAttempts - 1,
                nextAttemptAt: new Date(Date.now() - 1000),
            });

            await job.run();

            const updated = await ingestQueueRepo.findOne({ uid: entry.uid } as any);
            expect(updated!.status).toBe(IngestStatus.FAILED);
            expect(updated!.attempts).toBe(maxAttempts);
            expect(updated!.nextAttemptAt ?? null).toBeNull();
        });

        it("Takes over a SCANNING entry whose lease has expired, and leaves one with a live lease alone.", async () => {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const expiredKey = `raw/${uuid.v4()}`;
            const liveKey = `raw/${uuid.v4()}`;
            await blobStore.put(expiredKey, makePlainRawMessage());
            await blobStore.put(liveKey, makePlainRawMessage());
            const expired = await createIngestEntry({ rawBlobKey: expiredKey, status: IngestStatus.SCANNING, scanLeaseExpiresAt: new Date(Date.now() - 1000) });
            const live = await createIngestEntry({ rawBlobKey: liveKey, status: IngestStatus.SCANNING, scanLeaseExpiresAt: new Date(Date.now() + 600_000) });

            await job.run();

            expect((await ingestQueueRepo.findOne({ uid: expired.uid } as any))!.status).toBe(IngestStatus.DELIVERED);
            expect((await ingestQueueRepo.findOne({ uid: live.uid } as any))!.status).toBe(IngestStatus.SCANNING);
        });

        it("Skips an entry another worker claimed first, without marking it failed.", async () => {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makePlainRawMessage());
            const entry = await createIngestEntry({ rawBlobKey });
            // Another worker bumps the row's version between this worker's read and its claim.
            const repo = (job as any).ingestQueueRepo;
            const originalFind = repo.find.bind(repo);
            vi.spyOn(repo, "find").mockImplementationOnce(async (...args: any[]) => {
                const found = await originalFind(...args);
                await ingestQueueRepo.updateOne({ uid: entry.uid }, { $set: { version: 7 } });
                return found;
            });

            await job.run();

            const after = await ingestQueueRepo.findOne({ uid: entry.uid } as any);
            expect(after!.status).toBe(IngestStatus.PENDING);
            expect(after!.attempts ?? null).toBeNull();
            expect((await messageRepo.find({ mailboxUid }).toArray()).length).toBe(0);
        });

        it("Re-processing an entry whose message was already filed doesn't file a second copy, attachment or ScanResult.", async () => {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makeRawMessage());
            const entry = await createIngestEntry({ rawBlobKey });
            await job.run();

            // Simulates a worker that filed the message but died before marking the entry DELIVERED.
            await ingestQueueRepo.updateOne({ uid: entry.uid }, { $set: { status: IngestStatus.PENDING } });
            await job.run();

            const messages = await messageRepo.find({ mailboxUid }).toArray();
            expect(messages.length).toBe(1);
            expect((await attachmentRepo.find({ messageUid: messages[0].uid }).toArray()).length).toBe(1);
            expect((await scanResultRepo.find({ targetUid: messages[0].uid }).toArray()).length).toBe(1);
            expect((await ingestQueueRepo.findOne({ uid: entry.uid } as any))!.status).toBe(IngestStatus.DELIVERED);
        });
    });

    describe("Mail filter rule safety", () => {
        it("Ignores MOVE_TO_FOLDER/COPY_TO_FOLDER targets that belong to another mailbox.", async () => {
            const foreignFolder = await folderRepo.save(
                new FolderMongo({ mailboxUid: uuid.v4(), name: "Theirs", type: FolderType.USER, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }),
            );
            await mailFilterRuleRepo.save(
                new MailFilterRuleMongo({
                    mailboxUid,
                    name: "Exfiltrate",
                    enabled: true,
                    sequence: 0,
                    stopProcessingRules: false,
                    conditions: { subjectContains: ["Test message"] },
                    actions: [
                        { type: MailFilterActionType.MOVE_TO_FOLDER, folderUid: foreignFolder.uid },
                        { type: MailFilterActionType.COPY_TO_FOLDER, folderUid: foreignFolder.uid },
                    ],
                }),
            );
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makeRawMessage());
            await createIngestEntry({ rawBlobKey });

            await job.run();

            expect((await messageRepo.find({ folderUid: foreignFolder.uid }).toArray()).length).toBe(0);
            const inbox = await folderRepo.findOne({ mailboxUid, type: FolderType.INBOX } as any);
            expect((await messageRepo.find({ folderUid: inbox!.uid }).toArray()).length).toBe(1);
        });

        const forwardRule = async (): Promise<void> => {
            await createMailbox();
            await mailFilterRuleRepo.save(
                new MailFilterRuleMongo({
                    mailboxUid,
                    name: "Forward",
                    enabled: true,
                    sequence: 0,
                    stopProcessingRules: false,
                    conditions: {},
                    actions: [{ type: MailFilterActionType.FORWARD, forwardTo: "assistant@example.com" }],
                }),
            );
        };

        it("Doesn't forward automatically submitted mail.", async () => {
            await forwardRule();
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makePlainRawMessage("Auto-Submitted: auto-replied"));
            await createIngestEntry({ rawBlobKey });

            await job.run();

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent.find((m) => m.envelopeTo.includes("assistant@example.com"))).toBeUndefined();
        });

        it("Doesn't forward a message this mailbox already forwarded once (loop detection).", async () => {
            await forwardRule();
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makePlainRawMessage("X-RapidMX-Loop: recipient@example.com"));
            await createIngestEntry({ rawBlobKey });

            await job.run();

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent.find((m) => m.envelopeTo.includes("assistant@example.com"))).toBeUndefined();
        });

        it("Logs a transport rejection of a forward instead of treating it as sent.", async () => {
            await createMailbox();
            await mailFilterRuleRepo.save(
                new MailFilterRuleMongo({
                    mailboxUid,
                    name: "Forward",
                    enabled: true,
                    sequence: 0,
                    stopProcessingRules: false,
                    conditions: {},
                    actions: [{ type: MailFilterActionType.FORWARD, forwardTo: "reject@example.com" }],
                }),
            );
            const warn = vi.spyOn((job as any).logger, "warn");
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makePlainRawMessage());
            await createIngestEntry({ rawBlobKey });

            await job.run();

            expect(warn).toHaveBeenCalledWith(expect.stringContaining("failed to forward message to reject@example.com"));
        });

        it("Doesn't record an out-of-office reply the transport rejected as sent.", async () => {
            await createMailbox({ oofEnabled: true, oofMessage: "Away." });
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makePlainRawMessage());
            await createIngestEntry({ rawBlobKey, envelopeFrom: "reject@example.com" });

            await job.run();

            expect((await oofReplySuppressionRepo.find({ mailboxUid }).toArray()).length).toBe(0);
        });
    });

    describe("iTIP sender verification", () => {
        const deliverItip = async (ics: string, opts: { from?: string; dkim?: boolean } = {}): Promise<void> => {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makeItipRawMessage(ics, opts));
            await createIngestEntry({ rawBlobKey, envelopeFrom: opts.from ?? "organizer@example.com", envelopeTo: ["recipient@example.com"] });
            await job.run();
        };
        const saveEvent = async (icalUid: string, organizer: string = "organizer@example.com"): Promise<any> =>
            await calendarEventRepo.save(
                new CalendarEventMongo({
                    folderUid: "calendar-folder",
                    mailboxUid,
                    title: "Team Sync",
                    timezone: "UTC",
                    organizer: { address: organizer, type: RecipientType.TO },
                    attendees: [{ address: "attendee@example.com", role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION, isOrganizer: false }],
                    status: CalendarEventStatus.CONFIRMED,
                    busyStatus: BusyStatus.BUSY,
                    icalUid,
                    sequence: 0,
                    startDate: new Date(),
                    endDate: new Date(),
                }),
            );

        it("Ignores a REQUEST whose sender isn't DKIM-verified.", async () => {
            const icalUid = uuid.v4();
            await deliverItip(buildEventIcs(makeIcsEventFixture({ icalUid }), "REQUEST"), { dkim: false });
            expect((await calendarEventRepo.find({ mailboxUid, icalUid }).toArray()).length).toBe(0);
        });

        it("Ignores a REQUEST whose verified sender isn't the organizer it names.", async () => {
            const icalUid = uuid.v4();
            await deliverItip(buildEventIcs(makeIcsEventFixture({ icalUid }), "REQUEST"), { from: "mallory@example.com" });
            expect((await calendarEventRepo.find({ mailboxUid, icalUid }).toArray()).length).toBe(0);
        });

        it("Ignores a REQUEST that would take over an existing event with a different organizer.", async () => {
            const icalUid = uuid.v4();
            const existing = await saveEvent(icalUid);
            const hijack = makeIcsEventFixture({
                icalUid,
                sequence: 5,
                title: "Hijacked",
                organizer: { address: "mallory@example.com", type: RecipientType.TO },
            });
            await deliverItip(buildEventIcs(hijack, "REQUEST"), { from: "mallory@example.com" });
            const after = await calendarEventRepo.findOne({ uid: existing.uid } as any);
            expect(after!.title).toBe("Team Sync");
        });

        it("Marks the attendee copy a REQUEST creates as already sent, so MeetingSchedulingJob never re-sends it.", async () => {
            const icalUid = uuid.v4();
            await deliverItip(buildEventIcs(makeIcsEventFixture({ icalUid, sequence: 2 }), "REQUEST"));
            const events = await calendarEventRepo.find({ mailboxUid, icalUid }).toArray();
            expect(events.length).toBe(1);
            expect(events[0].inviteSequenceSent).toBe(2);
        });

        it("Ignores a REPLY whose sender isn't the attendee replying.", async () => {
            const icalUid = uuid.v4();
            const existing = await saveEvent(icalUid);
            const replyIcs = buildEventIcs(makeIcsEventFixture({ icalUid }), "REPLY", {
                onlyAttendee: { address: "attendee@example.com", role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.ACCEPTED, isOrganizer: false },
            });
            await deliverItip(replyIcs, { from: "mallory@example.com" });
            const after = await calendarEventRepo.findOne({ uid: existing.uid } as any);
            expect(after!.attendees[0].responseStatus).toBe(AttendeeResponseStatus.NEEDS_ACTION);
        });

        it("Ignores a CANCEL from anyone but the organizer, and stamps cancelNoticeSentAt on a copy the organizer cancels.", async () => {
            const icalUid = uuid.v4();
            const existing = await saveEvent(icalUid);
            const cancelIcs = buildEventIcs(makeIcsEventFixture({ icalUid }), "CANCEL");

            await deliverItip(cancelIcs, { from: "mallory@example.com" });
            expect((await calendarEventRepo.findOne({ uid: existing.uid } as any))!.deleted).toBe(false);

            await deliverItip(cancelIcs);
            const cancelled = await calendarEventRepo.findOne({ uid: existing.uid } as any);
            expect(cancelled!.deleted).toBe(true);
            expect(cancelled!.cancelNoticeSentAt).toBeTruthy();
        });

        it("Reads every existing booking when checking a resource request for conflicts, not just the first page.", async () => {
            await createMailbox({ isResource: true, autoAcceptBookings: true });
            const startDate = new Date(Date.now() + 60 * 60 * 1000);
            const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
            const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const filler: any[] = [];
            for (let i = 0; i < 500; i++) {
                filler.push(
                    new CalendarEventMongo({
                        folderUid: "calendar-folder",
                        mailboxUid,
                        title: `Old ${i}`,
                        timezone: "UTC",
                        organizer: { address: "other@example.com", type: RecipientType.TO },
                        attendees: [],
                        status: CalendarEventStatus.CONFIRMED,
                        busyStatus: BusyStatus.BUSY,
                        icalUid: uuid.v4(),
                        startDate: past,
                        endDate: new Date(past.getTime() + 60_000),
                    }),
                );
            }
            await Promise.all(filler.map((row) => calendarEventRepo.save(row)));
            await saveEvent(uuid.v4(), "other@example.com").then(async (conflict) => {
                await calendarEventRepo.updateOne({ uid: conflict.uid }, { $set: { startDate, endDate } });
            });

            const icalUid = uuid.v4();
            await deliverItip(buildEventIcs(makeIcsEventFixture({ icalUid, startDate, endDate }), "REQUEST"));

            const events = await calendarEventRepo.find({ mailboxUid, icalUid }).toArray();
            expect(events.length).toBe(1);
            expect(events[0].deleted).toBe(true);
        });
    });

    describe("Recall sender verification", () => {
        const saveTarget = async (messageId: string, from: string): Promise<any> =>
            await messageRepo.save(
                new MessageMongo({
                    mailboxUid,
                    folderUid: "inbox-folder",
                    messageId,
                    from: { address: from, type: RecipientType.TO },
                    recipients: [{ address: "recipient@example.com", type: RecipientType.TO }],
                    bodyBlobKey: `bodies/${uuid.v4()}`,
                }),
            );

        it("Treats an unverified recall as ordinary mail: nothing is deleted and no read status is reported.", async () => {
            await createMailbox();
            const target = await saveTarget("unverified-target@example.com", "sender@example.com");
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makePlainRawMessage("X-RapidMX-Recall-Of: unverified-target@example.com"));
            await createIngestEntry({ rawBlobKey });

            await job.run();

            expect((await messageRepo.findOne({ uid: target.uid } as any))!.deleted).toBe(false);
            expect((await messageRepo.find({ mailboxUid }).toArray()).length).toBe(2);
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent.some((m) => m.raw.toString().includes("Recall report"))).toBe(false);
        });

        it("Doesn't let a verified sender recall someone else's message.", async () => {
            await createMailbox();
            const target = await saveTarget("someone-elses@example.com", "victim@example.com");
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(
                rawBlobKey,
                makePlainRawMessage("X-RapidMX-Recall-Of: someone-elses@example.com\r\nAuthentication-Results: mx.example.com; dkim=pass header.d=example.com"),
            );
            await createIngestEntry({ rawBlobKey });

            await job.run();

            expect((await messageRepo.findOne({ uid: target.uid } as any))!.deleted).toBe(false);
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent[0].raw.toString()).toContain("not found");
        });
    });

    describe("Failure bookkeeping and retry edge cases", () => {
        afterEach(() => {
            vi.restoreAllMocks();
        });

        const putRaw = async (raw: Buffer): Promise<string> => {
            const rawBlobKey = `raw/${uuid.v4()}`;
            await objectFactory.getInstance<any>("BlobStore")!.put(rawBlobKey, raw);
            return rawBlobKey;
        };

        it("Leaves an entry alone when processing failed but another worker already delivered it.", async () => {
            const entry = await createIngestEntry({ rawBlobKey: await putRaw(makePlainRawMessage()) });
            vi.spyOn(job as any, "processEntry").mockImplementationOnce(async () => {
                await ingestQueueRepo.updateOne({ uid: entry.uid }, { $set: { status: IngestStatus.DELIVERED } });
                throw new Error("simulated failure after another worker delivered");
            });

            await job.run();

            const after = await ingestQueueRepo.findOne({ uid: entry.uid } as any);
            expect(after!.status).toBe(IngestStatus.DELIVERED);
            expect(after!.attempts ?? null).toBeNull();
            expect(after!.errorMessage ?? null).toBeNull();
        });

        it("Logs a warning (no throw) when recording a processing failure itself fails.", async () => {
            // No blob at this key, so processing fails; the FAILED write is then made to fail too.
            const entry = await createIngestEntry({ rawBlobKey: `raw/${uuid.v4()}` });
            const repo = (job as any).ingestQueueRepo;
            const realUpdate = repo.update.bind(repo);
            vi.spyOn(repo, "update").mockImplementation(async (obj: any, ...rest: any[]) => {
                if (obj.status === IngestStatus.FAILED) {
                    throw new Error("simulated bookkeeping failure");
                }
                return await realUpdate(obj, ...rest);
            });
            const warnSpy = vi.spyOn((job as any).logger, "warn");

            await expect(job.run()).resolves.toBeUndefined();

            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("simulated bookkeeping failure"));
            const after = await ingestQueueRepo.findOne({ uid: entry.uid } as any);
            expect(after!.status).toBe(IngestStatus.SCANNING);
        });

        it("Re-processing an entry with a COPY_TO_FOLDER rule reuses the already-filed copy instead of filing a second one.", async () => {
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
            const entry = await createIngestEntry({ rawBlobKey: await putRaw(makeRawMessage()) });
            await job.run();

            // Simulates a worker that filed everything but died before marking the entry DELIVERED.
            await ingestQueueRepo.updateOne({ uid: entry.uid }, { $set: { status: IngestStatus.PENDING } });
            await job.run();

            expect((await messageRepo.find({ folderUid: copyFolder.uid }).toArray()).length).toBe(1);
            expect((await attachmentRepo.find({ folderUid: copyFolder.uid }).toArray()).length).toBe(1);
            expect((await folderRepo.findOne({ uid: copyFolder.uid } as any))!.totalCount).toBe(1);
            expect((await ingestQueueRepo.findOne({ uid: entry.uid } as any))!.status).toBe(IngestStatus.DELIVERED);
        });

        it("Retries the folder counter bump after a concurrent delivery changed the folder first.", async () => {
            const repo = (job as any).folderRepo;
            const realUpdate = repo.update.bind(repo);
            let conflicts = 0;
            vi.spyOn(repo, "update").mockImplementation(async (obj: any, ...rest: any[]) => {
                if (obj.totalCount !== undefined && conflicts === 0) {
                    conflicts++;
                    await folderRepo.updateOne({ uid: obj.uid }, { $inc: { version: 1, totalCount: 1 } });
                    throw new Error("simulated version conflict");
                }
                return await realUpdate(obj, ...rest);
            });
            const entry = await createIngestEntry({ rawBlobKey: await putRaw(makePlainRawMessage()) });

            await job.run();

            expect(conflicts).toBe(1);
            expect((await ingestQueueRepo.findOne({ uid: entry.uid } as any))!.status).toBe(IngestStatus.DELIVERED);
            const inbox = await folderRepo.findOne({ mailboxUid, type: FolderType.INBOX } as any);
            // The concurrent delivery's increment plus this one's - neither lost.
            expect(inbox!.totalCount).toBe(2);
        });

        it("Gives up on the folder counter bump (failing the entry for retry) after the bounded number of conflicting attempts.", async () => {
            const repo = (job as any).folderRepo;
            const realUpdate = repo.update.bind(repo);
            let attempts = 0;
            vi.spyOn(repo, "update").mockImplementation(async (obj: any, ...rest: any[]) => {
                if (obj.totalCount !== undefined) {
                    attempts++;
                    await folderRepo.updateOne({ uid: obj.uid }, { $inc: { version: 1 } });
                    throw new Error("simulated persistent version conflict");
                }
                return await realUpdate(obj, ...rest);
            });
            const entry = await createIngestEntry({ rawBlobKey: await putRaw(makePlainRawMessage()) });

            await job.run();

            expect(attempts).toBe(5);
            const after = await ingestQueueRepo.findOne({ uid: entry.uid } as any);
            expect(after!.status).toBe(IngestStatus.FAILED);
            expect(after!.errorMessage).toContain("simulated persistent version conflict");
        });

        it("Fails the counter bump immediately when the conflicting folder's version didn't actually change.", async () => {
            const repo = (job as any).folderRepo;
            const realUpdate = repo.update.bind(repo);
            let attempts = 0;
            vi.spyOn(repo, "update").mockImplementation(async (obj: any, ...rest: any[]) => {
                if (obj.totalCount !== undefined) {
                    attempts++;
                    throw new Error("simulated non-conflict update failure");
                }
                return await realUpdate(obj, ...rest);
            });
            const entry = await createIngestEntry({ rawBlobKey: await putRaw(makePlainRawMessage()) });

            await job.run();

            expect(attempts).toBe(1);
            expect((await ingestQueueRepo.findOne({ uid: entry.uid } as any))!.errorMessage).toContain("simulated non-conflict update failure");
        });

        it("Ignores an iTIP message with no From address at all (no verifiable sender).", async () => {
            await createMailbox();
            const icalUid = uuid.v4();
            const raw = makeItipRawMessage(buildEventIcs(makeIcsEventFixture({ icalUid }), "REQUEST"))
                .toString()
                .split("\r\n")
                .filter((line) => !line.startsWith("From:"))
                .join("\r\n");
            const entry = await createIngestEntry({ rawBlobKey: await putRaw(Buffer.from(raw)) });

            await job.run();

            expect((await ingestQueueRepo.findOne({ uid: entry.uid } as any))!.status).toBe(IngestStatus.DELIVERED);
            expect((await calendarEventRepo.find({ mailboxUid, icalUid }).toArray()).length).toBe(0);
        });

        it("Ignores a verified organizer's CANCEL for an event this mailbox has no copy of.", async () => {
            await createMailbox();
            const icalUid = uuid.v4();
            const entry = await createIngestEntry({
                rawBlobKey: await putRaw(makeItipRawMessage(buildEventIcs(makeIcsEventFixture({ icalUid }), "CANCEL"))),
                envelopeFrom: "organizer@example.com",
            });

            await job.run();

            expect((await ingestQueueRepo.findOne({ uid: entry.uid } as any))!.status).toBe(IngestStatus.DELIVERED);
            expect((await calendarEventRepo.find({ mailboxUid, icalUid }).toArray()).length).toBe(0);
        });

        it("Declines a resource booking request when the resource has too many existing bookings to check for conflicts.", async () => {
            await createMailbox({ isResource: true, autoAcceptBookings: true });
            const repo = (job as any).calendarEventRepo;
            const realFind = repo.find.bind(repo);
            const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const fullPage = Array.from({ length: 500 }, (_, i) => ({
                uid: `filler-${i}`,
                icalUid: `filler-${i}`,
                mailboxUid,
                startDate: past,
                endDate: new Date(past.getTime() + 60_000),
            }));
            const isBookingPageQuery = (query: any): boolean =>
                query?.page !== undefined && typeof query?.startDate === "string" && query.startDate.startsWith("lt(");
            const findSpy = vi.spyOn(repo, "find").mockImplementation(async (query: any, ...rest: any[]) => {
                if (isBookingPageQuery(query)) {
                    return fullPage;
                }
                return await realFind(query, ...rest);
            });
            const warnSpy = vi.spyOn((job as any).logger, "warn");
            const icalUid = uuid.v4();
            const rawBlobKey = await putRaw(makeItipRawMessage(buildEventIcs(makeIcsEventFixture({ icalUid }), "REQUEST")));
            await createIngestEntry({ rawBlobKey, envelopeFrom: "organizer@example.com" });

            await job.run();

            expect(findSpy.mock.calls.filter((call: any[]) => isBookingPageQuery(call[0])).length).toBe(20);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("too many existing bookings"));
            const events = await calendarEventRepo.find({ mailboxUid, icalUid }).toArray();
            expect(events.length).toBe(1);
            expect(events[0].deleted).toBe(true);
        });
    });
});
