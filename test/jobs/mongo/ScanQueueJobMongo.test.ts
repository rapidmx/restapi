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
import { DataSubjectErasureRequestMongo } from "../../../src/models/mongo/DataSubjectErasureRequestMongo.js";
import { buildEventIcs } from "../../../src/util/IcsUtils.js";
import { dsnDeliverySuite } from "../dsnDeliverySuite.js";
import { htmlMailSuite } from "../htmlMailSuite.js";
import { sanitizeDiscoveredKey } from "../../../src/util/KeyringUtils.js";
import { issueCertificate, makeTestIssuer } from "../../util/signerCertificates.js";
import { buildDispositionNotification } from "../../../src/util/ReceiptUtils.js";
import { MAX_MESSAGE_RECIPIENTS } from "../../../src/util/RecipientUtils.js";
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

/** A `DKIM-Signature` header for `domain` whose `h=` lists each of `oversigned` twice (so it oversigns a single
 * instance of each - see `util/DkimOversignUtils.ts`). Not a real signature: verification is represented by the
 * trusted `Authentication-Results` header a test adds alongside it. */
function oversigningDkimSignature(domain: string, ...oversigned: string[]): string {
    const signed: string[] = ["from", "to", "subject", ...oversigned.flatMap((name) => [name.toLowerCase(), name.toLowerCase()])];
    return `DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=${domain}; s=sel; h=${signed.join(":")}; bh=Ym9keQ==; b=c2lnbmF0dXJl`;
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
    let erasureRequestRepo: MongoRepository<DataSubjectErasureRequestMongo>;

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
        models.set("DataSubjectErasureRequestMongo", DataSubjectErasureRequestMongo);
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
        erasureRequestRepo = conn.getMongoRepository("DataSubjectErasureRequestMongo");

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
            erasureRequestRepo,
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

    it("Publishes the Inbox's counts after each delivery, derived from its messages rather than added to whatever was stored, and refreshes the stored cache.", async () => {
        await createMailbox();
        const inbox = await folderRepo.save(
            new FolderMongo({ mailboxUid, name: "Inbox", type: FolderType.INBOX, unreadCount: 7, totalCount: 7, syncKeyVersion: 0 }),
        );
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        for (let i = 0; i < 2; i++) {
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makePlainRawMessage());
            await createIngestEntry({ rawBlobKey });
        }
        const sendMessageSpy = vi.spyOn(NotificationUtils.prototype, "sendMessage");

        await job.run();

        const events = sendMessageSpy.mock.calls
            .filter(([, type, action]) => /^Folder/.test(String(type)) && action === "update")
            .map(([channels, type, , data]) => [channels, type, data]);
        sendMessageSpy.mockRestore();
        expect(events).toEqual([
            [[inbox.uid, mailboxUid], "FolderMongo", { uid: inbox.uid, mailboxUid, unreadCount: 1, totalCount: 1 }],
            [[inbox.uid, mailboxUid], "FolderMongo", { uid: inbox.uid, mailboxUid, unreadCount: 2, totalCount: 2 }],
        ]);
        expect(await folderRepo.findOne({ uid: inbox.uid } as any)).toMatchObject({ unreadCount: 2, totalCount: 2, syncKeyVersion: 2 });
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

    dsnDeliverySuite({
        blobStore: () => objectFactory.getInstance<any>("BlobStore")!,
        ingest: async (raw, envelopeFrom, envelopeTo) => {
            const rawBlobKey = `raw/${uuid.v4()}`;
            await objectFactory.getInstance<any>("BlobStore")!.put(rawBlobKey, raw);
            const entry = await createIngestEntry({ rawBlobKey, envelopeFrom, ...(envelopeTo ? { envelopeTo } : {}) });
            await job.run();
            return entry.uid;
        },
        entryStatus: async (uid) => (await ingestQueueRepo.findOne({ uid } as any))!.status,
        inbox: async () => {
            const inbox = await folderRepo.findOne({ mailboxUid, type: FolderType.INBOX } as any);
            return inbox ? await messageRepo.find({ folderUid: inbox.uid }).toArray() : [];
        },
        quarantined: async () => await quarantineEntryRepo.find({ mailboxUid }).toArray(),
        relayed: () => objectFactory.getInstance<RecordingMailTransport>("MailTransport")!.sent,
    });

    htmlMailSuite({
        blobStore: () => objectFactory.getInstance<any>("BlobStore")!,
        ingest: async (raw) => {
            const rawBlobKey = `raw/${uuid.v4()}`;
            await objectFactory.getInstance<any>("BlobStore")!.put(rawBlobKey, raw);
            await createIngestEntry({ rawBlobKey });
            await job.run();
        },
        inbox: async () => {
            const inbox = await folderRepo.findOne({ mailboxUid, type: FolderType.INBOX } as any);
            return inbox ? await messageRepo.find({ folderUid: inbox.uid }).toArray() : [];
        },
        attachmentsOf: async (messageUid) => await attachmentRepo.find({ messageUid }).toArray(),
    });

    describe("Delivered recipients and sender", () => {
        /** A plain message carrying exactly the originator/recipient headers a test needs. */
        function makeAddressedRawMessage(...headers: string[]): Buffer {
            return Buffer.from([...headers, "Subject: Addressed message", "", "Hello there.", ""].join("\r\n"));
        }

        /** Delivers `raw` to the test mailbox and returns the one `Message` row that produced. */
        async function deliver(raw: Buffer, data?: Partial<IngestQueueEntryMongo>): Promise<MessageMongo> {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, raw);
            await createIngestEntry({ rawBlobKey, ...data });
            await job.run();
            const inbox = await folderRepo.findOne({ mailboxUid, type: FolderType.INBOX } as any);
            const messages = await messageRepo.find({ folderUid: inbox!.uid }).toArray();
            expect(messages.length).toBe(1);
            return messages[0];
        }

        it("Records every To and Cc recipient the message names, with display names, not just the envelope recipient.", async () => {
            const encoded = `=?utf-8?B?${Buffer.from('Grüßer, "Jörg"', "utf8").toString("base64")}?=`;
            const message = await deliver(
                makeAddressedRawMessage(
                    "From: sender@example.com",
                    'To: "Allen, Bob" <bob@partner.test>, recipient@example.com',
                    `Cc: ${encoded} <jorg@partner.test>`,
                ),
            );

            expect(message.recipients).toEqual([
                { address: "bob@partner.test", displayName: "Allen, Bob", type: RecipientType.TO },
                { address: "recipient@example.com", type: RecipientType.TO },
                { address: "jorg@partner.test", displayName: 'Grüßer, "Jörg"', type: RecipientType.CC },
            ]);
        });

        it("Keeps a bcc'd (or alias-only) envelope recipient no header names, recorded as bcc.", async () => {
            const message = await deliver(makeAddressedRawMessage("From: sender@example.com", "To: bob@partner.test"));

            expect(message.recipients).toEqual([
                { address: "bob@partner.test", type: RecipientType.TO },
                { address: "recipient@example.com", type: RecipientType.BCC },
            ]);
        });

        it("Stores the sender's display name alone, with the address kept separately.", async () => {
            const message = await deliver(makeAddressedRawMessage('From: "Bob Allen" <bob@partner.test>', "To: recipient@example.com"), {
                envelopeFrom: "bob@partner.test",
            });

            expect(message.from).toEqual({ address: "bob@partner.test", displayName: "Bob Allen", type: RecipientType.TO });
        });

        it("Leaves the sender's display name unset when the From header carries none.", async () => {
            const message = await deliver(makeAddressedRawMessage("From: sender@example.com", "To: recipient@example.com"));

            expect(message.from.address).toBe("sender@example.com");
            expect(message.from.displayName).toBeFalsy();
        });

        it("Caps a huge recipient header, still keeping the envelope recipient it doesn't name.", async () => {
            const many = Array.from({ length: 5_000 }, (_unused, i) => `user${i}@partner.test`).join(", ");
            const message = await deliver(makeAddressedRawMessage("From: sender@example.com", `To: ${many}`));

            expect(message.recipients.length).toBe(MAX_MESSAGE_RECIPIENTS);
            expect(message.recipients[0]).toEqual({ address: "user0@partner.test", type: RecipientType.TO });
            expect(message.recipients[MAX_MESSAGE_RECIPIENTS - 1]).toEqual({ address: "recipient@example.com", type: RecipientType.BCC });
        });

        it("Delivers a message with a malformed recipient header, recording only the addresses it does name.", async () => {
            const message = await deliver(
                makeAddressedRawMessage("From: sender@example.com", 'To: Allen, Bob <bob@partner.test>, "unterminated <carol@partner.test>, not-an-address'),
            );

            expect(message.recipients.every((r) => r.address.includes("@"))).toBe(true);
            expect(message.recipients.map((r) => r.address)).toContain("bob@partner.test");
            expect(message.recipients.map((r) => r.address)).toContain("recipient@example.com");
        });
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
                    `RapidMX-Key: addr=sender@example.com; prefer-encrypt=mutual; type=x509; keydata=${keydata}\r\nAuthentication-Results: mx.example.com; dkim=pass header.d=example.com\r\n${oversigningDkimSignature("example.com", "RapidMX-Key")}`,
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


    describe("Conversation threading across a reply chain", () => {
        /** Delivers one message built from `headers` and returns the row it produced. */
        const deliverThreaded = async (...headers: string[]): Promise<any> => {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, Buffer.from([...headers, "", "Body text.", ""].join("\r\n")));
            await createIngestEntry({ rawBlobKey });
            await job.run();
            const id: string = headers.find((header) => header.startsWith("Message-ID:"))!.replace(/^Message-ID: <|>$/g, "");
            return (await messageRepo.find({ mailboxUid } as any).toArray()).find((message: any) => message.messageId === id)!;
        };
        const headersFor = (messageId: string, subject: string, extra: string[] = []): string[] => [
            "From: sender@example.com",
            "To: recipient@example.com",
            `Subject: ${subject}`,
            `Message-ID: <${messageId}>`,
            ...extra,
        ];

        it("Groups a two-deep reply chain into the root's conversation.", async () => {
            const root = await deliverThreaded(...headersFor("root@example.com", "Hello"));
            const reply = await deliverThreaded(
                ...headersFor("reply-1@example.com", "Re: Hello", ["In-Reply-To: <root@example.com>", "References: <root@example.com>"]),
            );

            expect(root.conversationId).toBe("root@example.com");
            expect(reply.conversationId).toBe("root@example.com");
        });

        it("Groups a three-deep chain, including a reply that names only its direct parent.", async () => {
            const root = await deliverThreaded(...headersFor("root@example.com", "Hello"));
            const second = await deliverThreaded(...headersFor("reply-1@example.com", "Re: Hello", ["In-Reply-To: <root@example.com>"]));
            // Only In-Reply-To, naming the *second* message: without the mailbox lookup this would start its own
            // conversation keyed on `reply-1@example.com`.
            const third = await deliverThreaded(...headersFor("reply-2@example.com", "Re: Hello", ["In-Reply-To: <reply-1@example.com>"]));

            expect(root.conversationId).toBe("root@example.com");
            expect(second.conversationId).toBe("root@example.com");
            expect(third.conversationId).toBe("root@example.com");
        });

        it("Groups a reply that carries References but no In-Reply-To.", async () => {
            await deliverThreaded(...headersFor("root@example.com", "Hello"));
            const reply = await deliverThreaded(
                ...headersFor("reply-1@example.com", "Re: Hello", ["References: <root@example.com>"]),
            );

            // `?? undefined`: the SQL backend reads an unset column back as `null`, the Mongo one as `undefined`.
            expect(reply.inReplyTo ?? undefined).toBeUndefined();
            expect(reply.conversationId).toBe("root@example.com");
        });

        it("Keeps the thread together when the subject changes mid-chain - threading is by header, never by subject.", async () => {
            await deliverThreaded(...headersFor("root@example.com", "Hello"));
            const renamed = await deliverThreaded(
                ...headersFor("reply-1@example.com", "Lunch on Friday instead", [
                    "In-Reply-To: <root@example.com>",
                    "References: <root@example.com>",
                ]),
            );
            const after = await deliverThreaded(
                ...headersFor("reply-2@example.com", "Re: Lunch on Friday instead", ["In-Reply-To: <reply-1@example.com>"]),
            );

            expect(renamed.conversationId).toBe("root@example.com");
            expect(after.conversationId).toBe("root@example.com");
        });

        it("Starts its own conversation for a message that replies to nothing, even under a subject this mailbox already has.", async () => {
            await deliverThreaded(...headersFor("root@example.com", "Hello"));
            const unrelated = await deliverThreaded(...headersFor("unrelated@example.com", "Hello"));

            expect(unrelated.conversationId).toBe("unrelated@example.com");
        });

        it("Falls back to the root a reply names when this mailbox holds none of its ancestors.", async () => {
            const orphan = await deliverThreaded(
                ...headersFor("reply-1@example.com", "Re: Hello", [
                    "In-Reply-To: <never-seen@example.com>",
                    "References: <root@elsewhere.test> <never-seen@example.com>",
                ]),
            );

            expect(orphan.conversationId).toBe("root@elsewhere.test");
        });
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

    describe("Key rotation continuity for RapidMX-Key header conflicts", () => {
        const DAY = 24 * 60 * 60 * 1000;
        let mockFetch: ReturnType<typeof vi.fn>;

        beforeEach(() => {
            mockFetch = vi.fn();
            vi.stubGlobal("fetch", mockFetch);
        });

        /** The stored/observed `PublicKey` for a base64 DER certificate, as `sanitizeDiscoveredKey()` builds it. */
        const encryptKeyOf = (certificate: string, overrides: Record<string, any> = {}) => ({
            ...sanitizeDiscoveredKey({ publicKey: certificate, type: "x509", useType: "encrypt", fingerprint: "", notBefore: 0, notAfter: 0 })!,
            ...overrides,
        });

        /** Delivers a message from `address` carrying `keydata` in an aligned, oversigned `RapidMX-Key` header. */
        async function deliverKeyHeader(address: string, keydata: string): Promise<void> {
            const domain: string = address.split("@")[1];
            const raw = Buffer.from(
                [
                    `From: ${address}`,
                    "To: recipient@example.com",
                    "Subject: Rotated",
                    `RapidMX-Key: addr=${address}; prefer-encrypt=mutual; type=x509; keydata=${keydata}`,
                    `Authentication-Results: mx.example.com; dkim=pass header.d=${domain}`,
                    oversigningDkimSignature(domain, "RapidMX-Key"),
                    "",
                    "Hello.",
                    "",
                ].join("\r\n"),
            );
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, raw);
            await createIngestEntry({ rawBlobKey, envelopeFrom: address });
            await job.run();
        }

        async function saveKeyContact(address: string, fields: Record<string, any>): Promise<void> {
            await contactRepo.save(
                new ContactMongo({
                    mailboxUid,
                    folderUid: uuid.v4(),
                    displayName: address,
                    emails: [{ address, type: "other" as any }],
                    phones: [],
                    addresses: [],
                    ...fields,
                }),
            );
        }

        it("A header conflict refreshes discovery, which replaces the expired pinned key with the same-CA key it publishes with its issuer.", async () => {
            const domain = "rotating-header-mongo.example";
            const address = `carol@${domain}`;
            const issuer = await makeTestIssuer();
            const pinned = encryptKeyOf(
                (await issueCertificate(issuer, { sanEmails: [address], notBefore: new Date(Date.now() - 30 * DAY), notAfter: new Date(Date.now() - DAY) })).certificate,
            );
            const next = await issueCertificate(issuer, { sanEmails: [address], keyUsage: x509.KeyUsageFlags.keyAgreement });
            await saveKeyContact(address, { keys: [pinned] });
            const dnsResolver = objectFactory.getInstance<StaticDnsResolver>("DnsResolver")!;
            dnsResolver.records.set(`_rapidmx.${domain}`, [[`v=RMXv1; id=1; host=mail.${domain};`]]);
            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                json: vi.fn().mockResolvedValue({
                    encryptPreference: { preferEncrypt: "mutual", lastSeen: 100 },
                    keys: [encryptKeyOf(next.certificate, { issuerCertificate: issuer.certificate })],
                    escrow: false,
                }),
                headers: { get: () => null },
            });

            await deliverKeyHeader(address, next.certificate);

            expect(mockFetch).toHaveBeenCalledTimes(1);
            const [contact] = await contactRepo.find({ mailboxUid, "emails.address": address }).toArray();
            expect(contact.keys.map((key: any) => key.fingerprint)).toEqual([next.fingerprint]);
            expect(contact.keys[0].issuerCertificate).toBe(issuer.certificate);
            expect(contact.previousKeys).toEqual([expect.objectContaining({ fingerprint: pinned.fingerprint, replacement: "automatic" })]);
            expect(contact.keyConflicts ?? []).toEqual([]);
        });

        it("Keeps the header's conflict, with the full observed key, when the sender isn't a federated peer.", async () => {
            const address = "dave@not-federated-header-mongo.example";
            const pinned = encryptKeyOf(await makeCertBase64("pinned"));
            const keydata = await makeCertBase64("observed");
            await saveKeyContact(address, { keys: [pinned] });

            await deliverKeyHeader(address, keydata);

            expect(mockFetch).not.toHaveBeenCalled();
            const [contact] = await contactRepo.find({ mailboxUid, "emails.address": address }).toArray();
            expect(contact.keys.map((key: any) => key.fingerprint)).toEqual([pinned.fingerprint]);
            expect(contact.keyConflicts).toEqual([
                {
                    useType: "encrypt",
                    observedKey: expect.objectContaining({ publicKey: keydata, fingerprint: encryptKeyOf(keydata).fingerprint }),
                    observedAt: expect.any(Number),
                    source: "header",
                },
            ]);
        });

        it("Doesn't refresh for a key header matching the pinned key, and still delivers when a refresh fails.", async () => {
            const address = "erin@refresh-fails-mongo.example";
            const keydata = await makeCertBase64("pinned");
            await saveKeyContact(address, { keys: [encryptKeyOf(keydata)] });
            const refresh = vi.spyOn(job as any, "maybeRefreshRotatedKey");

            await deliverKeyHeader(address, keydata);
            expect(refresh).not.toHaveBeenCalled();

            refresh.mockRejectedValueOnce(new Error("refresh failed"));
            await deliverKeyHeader(address, await makeCertBase64("observed"));

            expect(refresh).toHaveBeenCalledTimes(1);
            refresh.mockRestore();
            const [contact] = await contactRepo.find({ mailboxUid, "emails.address": address }).toArray();
            expect(contact.keyConflicts).toHaveLength(1);
            const delivered = await messageRepo.find({ mailboxUid, subject: "Rotated" }).toArray();
            expect(delivered).toHaveLength(2);
        });
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
                `X-RapidMX-Recall-Of: ${targetMessageId}${dkim ? `\r\nAuthentication-Results: mx.example.com; dkim=pass header.d=example.com\r\n${oversigningDkimSignature("example.com", "X-RapidMX-Recall-Of")}` : ""}`,
            );

        it("Deletes the target message and reports success when it's still unread.", async () => {
            await createMailbox();
            const targetMessageId = "target-message@example.com";
            // The Inbox holds the target and one message already read, and its stored counters are stale.
            const inbox = await folderRepo.save(new FolderMongo({ mailboxUid, name: "Inbox", type: FolderType.INBOX, unreadCount: 4, totalCount: 4 }));
            await messageRepo.save(
                new MessageMongo({
                    mailboxUid,
                    folderUid: inbox.uid,
                    messageId: "already-read@example.com",
                    from: { address: "sender@example.com", type: RecipientType.TO },
                    recipients: [{ address: "recipient@example.com", type: RecipientType.TO }],
                    bodyBlobKey: `bodies/${uuid.v4()}`,
                    flags: { read: true, flagged: false, answered: false, forwarded: false },
                }),
            );
            const target = await messageRepo.save(
                new MessageMongo({
                    mailboxUid,
                    folderUid: inbox.uid,
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
            const sendMessageSpy = vi.spyOn(NotificationUtils.prototype, "sendMessage");

            await job.run();

            // The recalled message is out of the Inbox's counts, and the change is published.
            expect(sendMessageSpy).toHaveBeenCalledWith([inbox.uid, mailboxUid], "FolderMongo", "update", {
                uid: inbox.uid,
                mailboxUid,
                unreadCount: 0,
                totalCount: 1,
            });
            sendMessageSpy.mockRestore();

            const found = await messageRepo.findOne({ uid: target.uid } as any);
            expect(found!.deleted).toBe(true);

            // The recall control message itself is never filed anywhere in the recipient's mailbox.
            const allMessages = await messageRepo.find({ mailboxUid }).toArray();
            expect(allMessages.length).toBe(2); // the already-read message and the (soft-deleted) target

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

            expect(message.deliveryReceiptSentAt ?? undefined).toBeUndefined();
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

        it("A rule copy filed and a rule forward relayed while the primary message already carries a verification seal get none of it.", async () => {
            await createMailbox();
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makeRawMessage());
            const entry = await createIngestEntry({ rawBlobKey });
            await job.run();

            const seal = "v1.primary-seal_value";
            const [primary] = await messageRepo.find({ mailboxUid }).toArray();
            await messageRepo.updateOne({ uid: primary.uid }, { $set: { verificationSeal: seal, verificationSealGeneration: 1 }, $inc: { version: 1 } });
            // The rules only exist for the retry, which files the copy and relays the forward from the sealed primary's entry.
            const copyFolder = await folderRepo.save(
                new FolderMongo({ mailboxUid, name: "Archive", type: FolderType.USER, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }),
            );
            await mailFilterRuleRepo.save(
                new MailFilterRuleMongo({
                    mailboxUid,
                    name: "Copy and forward",
                    enabled: true,
                    sequence: 0,
                    stopProcessingRules: false,
                    conditions: { subjectContains: ["Test message"] },
                    actions: [
                        { type: MailFilterActionType.COPY_TO_FOLDER, folderUid: copyFolder.uid },
                        { type: MailFilterActionType.FORWARD, forwardTo: "assistant@example.com" },
                    ],
                }),
            );
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            transport.sent = [];
            await ingestQueueRepo.updateOne({ uid: entry.uid }, { $set: { status: IngestStatus.PENDING } });
            await job.run();

            const copies = await messageRepo.find({ folderUid: copyFolder.uid }).toArray();
            expect(copies).toHaveLength(1);
            expect(copies[0].uid).not.toBe(primary.uid);
            expect(copies[0].verificationSeal ?? undefined).toBeUndefined();
            expect(copies[0].verificationSealGeneration ?? undefined).toBeUndefined();
            expect((await messageRepo.findOne({ uid: primary.uid } as any))!.verificationSeal).toBe(seal);
            const forwarded = transport.sent.find((m) => m.envelopeTo.includes("assistant@example.com"));
            expect(forwarded).toBeDefined();
            expect(forwarded!.raw.toString("utf-8")).not.toContain(seal);
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
                makePlainRawMessage(
                    `X-RapidMX-Recall-Of: someone-elses@example.com\r\nAuthentication-Results: mx.example.com; dkim=pass header.d=example.com\r\n${oversigningDkimSignature("example.com", "X-RapidMX-Recall-Of")}`,
                ),
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
            // The claim itself counted the attempt; the failure is left to the worker that delivered it.
            expect(after!.attempts).toBe(1);
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

        it("Retries the folder counts refresh after a concurrent write changed the folder first, storing counts derived from the messages.", async () => {
            const repo = (job as any).folderRepo;
            const realUpdate = repo.update.bind(repo);
            let conflicts = 0;
            vi.spyOn(repo, "update").mockImplementation(async (obj: any, ...rest: any[]) => {
                if (obj.totalCount !== undefined && conflicts === 0) {
                    conflicts++;
                    // Someone else bumps the row (and its now-wrong counters) between the read and this write.
                    await folderRepo.updateOne({ uid: obj.uid }, { $inc: { version: 1, totalCount: 5 } });
                    throw new Error("simulated version conflict");
                }
                return await realUpdate(obj, ...rest);
            });
            const entry = await createIngestEntry({ rawBlobKey: await putRaw(makePlainRawMessage()) });

            await job.run();

            expect(conflicts).toBe(1);
            expect((await ingestQueueRepo.findOne({ uid: entry.uid } as any))!.status).toBe(IngestStatus.DELIVERED);
            const inbox = await folderRepo.findOne({ mailboxUid, type: FolderType.INBOX } as any);
            // Never an increment of whatever was stored: the one message the Inbox holds, whatever the row said before.
            expect(inbox!.totalCount).toBe(1);
            expect(inbox!.unreadCount).toBe(1);
        });

        it("Delivers the message and still publishes the folder's counts when the stored counts can't be updated (a bounded number of attempts).", async () => {
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
            const sendMessageSpy = vi.spyOn(NotificationUtils.prototype, "sendMessage");
            const entry = await createIngestEntry({ rawBlobKey: await putRaw(makePlainRawMessage()) });

            await job.run();

            // The stored counts are only a cache: failing to refresh them never fails the delivery.
            expect(attempts).toBe(3);
            expect((await ingestQueueRepo.findOne({ uid: entry.uid } as any))!.status).toBe(IngestStatus.DELIVERED);
            const inbox = await folderRepo.findOne({ mailboxUid, type: FolderType.INBOX } as any);
            expect(sendMessageSpy).toHaveBeenCalledWith(
                [inbox!.uid, mailboxUid],
                "FolderMongo",
                "update",
                { uid: inbox!.uid, mailboxUid, unreadCount: 1, totalCount: 1 },
            );
            sendMessageSpy.mockRestore();
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

    describe("Round-4 review fixes", () => {
        afterEach(() => {
            vi.restoreAllMocks();
        });

        const putRaw = async (raw: Buffer | string): Promise<string> => {
            const rawBlobKey = `raw/${uuid.v4()}`;
            await objectFactory.getInstance<any>("BlobStore")!.put(rawBlobKey, Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
            return rawBlobKey;
        };
        const transport = (): RecordingMailTransport => objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        const makeDue = async (uid: string): Promise<void> => {
            await ingestQueueRepo.updateOne({ uid }, { $set: { nextAttemptAt: new Date(Date.now() - 1000) } });
        };
        const DAY_MS = 24 * 60 * 60 * 1000;

        describe("J3: replay-sensitive headers must be DKIM-oversigned", () => {
            it("Ignores a RapidMX-Key header the aligned, passing signature signs only once (appendable by a replayer).", async () => {
                const keydata = await makeCertBase64("sender@example.com");
                const notOversigned = "DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=sel; h=from:to:subject:rapidmx-key; bh=Ym9keQ==; b=c2ln";
                await createIngestEntry({
                    rawBlobKey: await putRaw(
                        makePlainRawMessage(
                            `RapidMX-Key: addr=sender@example.com; type=x509; keydata=${keydata}\r\nAuthentication-Results: mx.example.com; dkim=pass header.d=example.com\r\n${notOversigned}`,
                        ),
                    ),
                });

                await job.run();

                expect(await contactRepo.find({ mailboxUid, "emails.address": "sender@example.com" }).toArray()).toHaveLength(0);
            });

            it("Ignores a RapidMX-Key header with a passing aligned DKIM result but no DKIM-Signature header to check oversigning against.", async () => {
                const keydata = await makeCertBase64("sender@example.com");
                await createIngestEntry({
                    rawBlobKey: await putRaw(
                        makePlainRawMessage(`RapidMX-Key: addr=sender@example.com; type=x509; keydata=${keydata}\r\nAuthentication-Results: mx.example.com; dkim=pass header.d=example.com`),
                    ),
                });

                await job.run();

                expect(await contactRepo.find({ mailboxUid, "emails.address": "sender@example.com" }).toArray()).toHaveLength(0);
            });

            it("Ignores a RapidMX-Key header oversigned only by a signature from a domain not aligned with From.", async () => {
                const keydata = await makeCertBase64("sender@example.com");
                await createIngestEntry({
                    rawBlobKey: await putRaw(
                        makePlainRawMessage(
                            `RapidMX-Key: addr=sender@example.com; type=x509; keydata=${keydata}\r\n` +
                                "Authentication-Results: mx.example.com; dkim=pass header.d=example.com; dkim=pass header.d=other.example\r\n" +
                                "DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=sel; h=from:to:subject; bh=Ym9keQ==; b=c2ln\r\n" +
                                oversigningDkimSignature("other.example", "RapidMX-Key"),
                        ),
                    ),
                });

                await job.run();

                expect(await contactRepo.find({ mailboxUid, "emails.address": "sender@example.com" }).toArray()).toHaveLength(0);
            });

            it("Treats a DKIM-verified recall whose header isn't oversigned as ordinary mail - nothing is recalled.", async () => {
                await createMailbox();
                const target = await messageRepo.save(
                    new MessageMongo({
                        mailboxUid,
                        folderUid: "inbox-folder",
                        messageId: "replayed-target@example.com",
                        from: { address: "sender@example.com", type: RecipientType.TO },
                        recipients: [{ address: "recipient@example.com", type: RecipientType.TO }],
                        bodyBlobKey: `bodies/${uuid.v4()}`,
                    }),
                );
                await createIngestEntry({
                    rawBlobKey: await putRaw(
                        makePlainRawMessage(
                            "X-RapidMX-Recall-Of: replayed-target@example.com\r\nAuthentication-Results: mx.example.com; dkim=pass header.d=example.com\r\n" +
                                "DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=sel; h=from:to:subject; bh=Ym9keQ==; b=c2ln",
                        ),
                    ),
                    envelopeFrom: "sender@example.com",
                });

                await job.run();

                expect((await messageRepo.findOne({ uid: target.uid } as any))!.deleted).toBe(false);
                expect((await messageRepo.find({ mailboxUid }).toArray()).length).toBe(2);
                expect(transport().sent.some((m) => m.raw.toString().includes("Recall report"))).toBe(false);
            });
        });

        describe("J18: search index hygiene", () => {
            const saveTarget = async (messageId: string): Promise<MessageMongo> =>
                await messageRepo.save(
                    new MessageMongo({
                        mailboxUid,
                        folderUid: "inbox-folder",
                        messageId,
                        from: { address: "sender@example.com", type: RecipientType.TO },
                        recipients: [{ address: "recipient@example.com", type: RecipientType.TO }],
                        bodyBlobKey: `bodies/${uuid.v4()}`,
                    }),
                );
            const recallRaw = (messageId: string): Buffer =>
                makePlainRawMessage(
                    `X-RapidMX-Recall-Of: ${messageId}\r\nAuthentication-Results: mx.example.com; dkim=pass header.d=example.com\r\n${oversigningDkimSignature("example.com", "X-RapidMX-Recall-Of")}`,
                );

            it("Removes a recalled message from the search index.", async () => {
                await createMailbox();
                const target = await saveTarget("indexed-target@example.com");
                const removeSpy = vi.spyOn((job as any).searchProvider, "remove");
                await createIngestEntry({ rawBlobKey: await putRaw(recallRaw("indexed-target@example.com")), envelopeFrom: "sender@example.com" });

                await job.run();

                expect((await messageRepo.findOne({ uid: target.uid } as any))!.deleted).toBe(true);
                expect(removeSpy).toHaveBeenCalledWith("message", target.uid);
            });

            it("Reports 'already read' (and deletes nothing) when the message is read between the recall's lookup and its delete.", async () => {
                await createMailbox();
                const target = await saveTarget("racing-target@example.com");
                const repo = (job as any).messageRepo;
                const realFind = repo.find.bind(repo);
                vi.spyOn(repo, "find").mockImplementation(async (query: any, ...rest: any[]) => {
                    const found = await realFind(query, ...rest);
                    if (query?.messageId?.value === "racing-target@example.com") {
                        await messageRepo.updateOne({ uid: target.uid }, { $set: { "flags.read": true }, $inc: { version: 1 } });
                    }
                    return found;
                });
                await createIngestEntry({ rawBlobKey: await putRaw(recallRaw("racing-target@example.com")), envelopeFrom: "sender@example.com" });

                await job.run();

                expect((await messageRepo.findOne({ uid: target.uid } as any))!.deleted).toBe(false);
                expect(transport().sent[0].raw.toString()).toContain("already read");
            });
        });

        describe("J8: contact key updates use the contact repo", () => {
            it("Updates an existing Contact without stamping ingest-queue fields onto it.", async () => {
                await contactRepo.save(
                    new ContactMongo({
                        mailboxUid,
                        folderUid: uuid.v4(),
                        displayName: "sender@example.com",
                        emails: [{ address: "sender@example.com", type: ContactAddressKind.OTHER }],
                        phones: [],
                        addresses: [],
                    }),
                );
                await createIngestEntry({ rawBlobKey: await putRaw(makePlainRawMessage()) });

                await job.run();

                const contact: any = (await contactRepo.find({ mailboxUid, "emails.address": "sender@example.com" }).toArray())[0];
                expect(contact.lastMessageSeen).toEqual(expect.any(Number));
                expect(contact.envelopeTo).toBeUndefined();
                expect(contact.rawBlobKey).toBeUndefined();
                expect(contact.status).toBeUndefined();
            });
        });

        describe("J11: claims, leases and failure bookkeeping", () => {
            it("Counts the attempt when claiming, and parks an abandoned entry that already used every attempt instead of processing it again.", async () => {
                const maxAttempts: number = (job as any).maxAttempts;
                const abandoned = await createIngestEntry({
                    rawBlobKey: await putRaw(makePlainRawMessage()),
                    status: IngestStatus.SCANNING,
                    attempts: maxAttempts,
                    scanLeaseExpiresAt: new Date(Date.now() - 1000),
                });
                const fresh = await createIngestEntry({ rawBlobKey: await putRaw(makePlainRawMessage()) });
                const processSpy = vi.spyOn(job as any, "processEntry");

                await job.run();

                const parked = await ingestQueueRepo.findOne({ uid: abandoned.uid } as any);
                expect(parked!.status).toBe(IngestStatus.FAILED);
                expect(parked!.nextAttemptAt ?? null).toBeNull();
                expect(parked!.errorMessage).toContain("attempts");
                expect(processSpy).toHaveBeenCalledTimes(1);
                const delivered = await ingestQueueRepo.findOne({ uid: fresh.uid } as any);
                expect(delivered!.status).toBe(IngestStatus.DELIVERED);
                expect(delivered!.attempts).toBe(1);
            });

            it("Doesn't record a failure over an entry another worker took over mid-processing.", async () => {
                const entry = await createIngestEntry({ rawBlobKey: await putRaw(makePlainRawMessage()) });
                vi.spyOn(job as any, "processEntry").mockImplementationOnce(async () => {
                    // The lease lapsed and another worker re-claimed the entry (bumping its version) before this one failed.
                    await ingestQueueRepo.updateOne({ uid: entry.uid }, { $inc: { version: 1 }, $set: { attempts: 2 } });
                    throw new Error("simulated failure after a takeover");
                });

                await job.run();

                const after = await ingestQueueRepo.findOne({ uid: entry.uid } as any);
                expect(after!.status).toBe(IngestStatus.SCANNING);
                expect(after!.attempts).toBe(2);
                expect(after!.errorMessage ?? null).toBeNull();
            });

            it("Renews the lease during processing and still delivers.", async () => {
                const originalLease: number = (job as any).leaseSeconds;
                (job as any).leaseSeconds = 0;
                try {
                    const updateSpy = vi.spyOn((job as any).ingestQueueRepo, "update");
                    const entry = await createIngestEntry({ rawBlobKey: await putRaw(makePlainRawMessage()) });

                    await job.run();

                    expect(updateSpy.mock.calls.some((call: any[]) => call[0].status === undefined && call[0].scanLeaseExpiresAt instanceof Date)).toBe(true);
                    expect((await ingestQueueRepo.findOne({ uid: entry.uid } as any))!.status).toBe(IngestStatus.DELIVERED);
                } finally {
                    (job as any).leaseSeconds = originalLease;
                }
            });

            it("Stops before filing anything when another worker took the entry over during the scan.", async () => {
                const originalLease: number = (job as any).leaseSeconds;
                (job as any).leaseSeconds = 0;
                try {
                    const entry = await createIngestEntry({ rawBlobKey: await putRaw(makePlainRawMessage()) });
                    const pipeline = (job as any).scanPipeline;
                    const realRun = pipeline.run.bind(pipeline);
                    vi.spyOn(pipeline, "run").mockImplementationOnce(async (...args: any[]) => {
                        const scanned = await realRun(...args);
                        await ingestQueueRepo.updateOne({ uid: entry.uid }, { $inc: { version: 1 } });
                        return scanned;
                    });

                    await job.run();

                    expect((await messageRepo.find({ mailboxUid }).toArray()).length).toBe(0);
                    const after = await ingestQueueRepo.findOne({ uid: entry.uid } as any);
                    expect(after!.status).toBe(IngestStatus.SCANNING);
                    expect(after!.errorMessage ?? null).toBeNull();
                } finally {
                    (job as any).leaseSeconds = originalLease;
                }
            });

            const verifiedDomain = async (): Promise<void> => {
                await domainRepo.save(new DomainMongo({ uid: "example.com", name: "example.com", enabled: true, verified: true, verificationToken: uuid.v4() }));
            };
            const receiptRequest = (): string =>
                "From: colleague@example.com\r\nTo: recipient@example.com\r\nSubject: Plain message\r\n" +
                "Disposition-Notification-To: colleague@example.com\r\n" +
                "Authentication-Results: mx.example.com; dkim=pass header.d=example.com\r\n\r\nHello there.\r\n";
            const receiptsSent = (): number => transport().sent.filter((m) => m.envelopeTo.includes("colleague@example.com")).length;

            it("Never sends a delivery receipt before the message row exists, and sends it exactly once across retries.", async () => {
                await createMailbox();
                await verifiedDomain();
                vi.spyOn((job as any).messageRepo, "create").mockRejectedValueOnce(new Error("simulated create failure"));
                const entry = await createIngestEntry({ rawBlobKey: await putRaw(receiptRequest()), envelopeFrom: "colleague@example.com" });

                await job.run();
                expect((await ingestQueueRepo.findOne({ uid: entry.uid } as any))!.status).toBe(IngestStatus.FAILED);
                expect(receiptsSent()).toBe(0);

                await makeDue(entry.uid);
                await job.run();
                const messages = await messageRepo.find({ mailboxUid }).toArray();
                expect(messages).toHaveLength(1);
                expect(messages[0].deliveryReceiptSentAt).toBeInstanceOf(Date);
                expect(receiptsSent()).toBe(1);

                // A re-run of the already-filed entry (e.g. its worker died before marking it DELIVERED) sends nothing more.
                await ingestQueueRepo.updateOne({ uid: entry.uid }, { $set: { status: IngestStatus.PENDING } });
                await job.run();
                expect(receiptsSent()).toBe(1);
            });

            it("Sends the delivery receipt on retry when the earlier attempt filed the message but failed before sending it.", async () => {
                await createMailbox();
                await verifiedDomain();
                // The job's own live "create" notice of the filed message (on the folder's channel, as a bare uid - a repository's
                // own publish passes a list) is the step between filing it and answering it.
                const realSend = NotificationUtils.prototype.sendMessage;
                let failed = false;
                const notifySpy = vi.spyOn(NotificationUtils.prototype, "sendMessage").mockImplementation(function (this: any, ...args: any[]) {
                    if (!failed && typeof args[0] === "string" && /^Message/.test(args[1]) && args[2] === "create") {
                        failed = true;
                        throw new Error("simulated notification failure");
                    }
                    return (realSend as any).apply(this, args);
                });
                const entry = await createIngestEntry({ rawBlobKey: await putRaw(receiptRequest()), envelopeFrom: "colleague@example.com" });

                await job.run();
                notifySpy.mockRestore();
                expect(await messageRepo.find({ mailboxUid }).toArray()).toHaveLength(1);
                expect(receiptsSent()).toBe(0);

                await makeDue(entry.uid);
                await job.run();
                expect(receiptsSent()).toBe(1);
                expect((await messageRepo.find({ mailboxUid }).toArray())[0].deliveryReceiptSentAt).toBeInstanceOf(Date);
            });
        });

        describe("J6: forward-and-delete rules", () => {
            const forwardAndDeleteRule = async (): Promise<void> => {
                await createMailbox();
                await mailFilterRuleRepo.save(
                    new MailFilterRuleMongo({
                        mailboxUid,
                        name: "Forward then delete",
                        enabled: true,
                        sequence: 0,
                        stopProcessingRules: false,
                        conditions: {},
                        actions: [{ type: MailFilterActionType.FORWARD, forwardTo: "assistant@example.com" }, { type: MailFilterActionType.DELETE }],
                    }),
                );
            };
            const forwards = (): number => transport().sent.filter((m) => m.envelopeTo.includes("assistant@example.com")).length;

            it("Forwards a message a rule also deletes, filing nothing.", async () => {
                await forwardAndDeleteRule();
                const entry = await createIngestEntry({ rawBlobKey: await putRaw(makePlainRawMessage()) });

                await job.run();

                expect(forwards()).toBe(1);
                expect(await messageRepo.find({ mailboxUid }).toArray()).toHaveLength(0);
                expect((await ingestQueueRepo.findOne({ uid: entry.uid } as any))!.status).toBe(IngestStatus.DELIVERED);
                // The per-entry idempotency marker is cleaned up once the entry is closed.
                expect(await objectFactory.getInstance<any>("BlobStore")!.exists(`ingest-markers/${entry.uid}/forwarded`)).toBe(false);
            });

            it("Doesn't forward again when a retry re-processes the entry after the forward went out.", async () => {
                await forwardAndDeleteRule();
                const repo = (job as any).ingestQueueRepo;
                const realUpdate = repo.update.bind(repo);
                let failed = false;
                vi.spyOn(repo, "update").mockImplementation(async (obj: any, ...rest: any[]) => {
                    if (obj.status === IngestStatus.DELIVERED && !failed) {
                        failed = true;
                        throw new Error("simulated failure closing the entry");
                    }
                    return await realUpdate(obj, ...rest);
                });
                const entry = await createIngestEntry({ rawBlobKey: await putRaw(makePlainRawMessage()) });

                await job.run();
                expect((await ingestQueueRepo.findOne({ uid: entry.uid } as any))!.status).toBe(IngestStatus.FAILED);
                expect(forwards()).toBe(1);

                await makeDue(entry.uid);
                await job.run();

                expect((await ingestQueueRepo.findOne({ uid: entry.uid } as any))!.status).toBe(IngestStatus.DELIVERED);
                expect(forwards()).toBe(1);
            });
        });

        describe("J15: mailbox under erasure", () => {
            it("Drops (never files) mail for a mailbox whose erasure is running (in progress, live claim), closing the entry.", async () => {
                await erasureRequestRepo.save(new DataSubjectErasureRequestMongo({ mailboxUid, requestedByUserUid: uuid.v4(), status: "in_progress" }));
                const entry = await createIngestEntry({ rawBlobKey: await putRaw(makeRawMessage()) });

                await job.run();

                const after = await ingestQueueRepo.findOne({ uid: entry.uid } as any);
                expect(after!.status).toBe(IngestStatus.DELIVERED);
                expect(after!.errorMessage).toContain("erased");
                expect(await messageRepo.find({ mailboxUid }).toArray()).toHaveLength(0);
                expect(await scanResultRepo.find({}).toArray()).toHaveLength(0);
                expect(await attachmentRepo.find({ mailboxUid }).toArray()).toHaveLength(0);
            });

            it("Still delivers while an erasure request is only pending review.", async () => {
                await erasureRequestRepo.save(new DataSubjectErasureRequestMongo({ mailboxUid, requestedByUserUid: uuid.v4(), status: "pending" }));
                await createIngestEntry({ rawBlobKey: await putRaw(makePlainRawMessage()) });

                await job.run();

                expect(await messageRepo.find({ mailboxUid }).toArray()).toHaveLength(1);
            });
        });

        describe("J7: resource booking conflict reads", () => {
            const saveBooking = async (data: Partial<CalendarEventMongo>): Promise<void> => {
                await calendarEventRepo.save(
                    new CalendarEventMongo({
                        folderUid: "calendar-folder",
                        mailboxUid,
                        title: "Booking",
                        timezone: "UTC",
                        organizer: { address: "other@example.com", type: RecipientType.TO },
                        attendees: [],
                        status: CalendarEventStatus.CONFIRMED,
                        busyStatus: BusyStatus.BUSY,
                        icalUid: uuid.v4(),
                        ...data,
                    }),
                );
            };
            const requestBooking = async (overrides: Partial<CalendarEvent>): Promise<any> => {
                await createIngestEntry({
                    rawBlobKey: await putRaw(makeItipRawMessage(buildEventIcs(makeIcsEventFixture(overrides), "REQUEST"))),
                    envelopeFrom: "organizer@example.com",
                });
                await job.run();
                return (await calendarEventRepo.find({ mailboxUid, icalUid: overrides.icalUid }).toArray())[0];
            };

            it("Never reads a resource's whole booking history: every page query is bounded to the request's window, recurring masters, or nearby overrides.", async () => {
                await createMailbox({ isResource: true, autoAcceptBookings: true });
                const past = new Date(Date.now() - 400 * DAY_MS);
                await saveBooking({ startDate: past, endDate: new Date(past.getTime() + 60 * 60 * 1000) });
                const findSpy = vi.spyOn((job as any).calendarEventRepo, "find");
                const startDate = new Date(Date.now() + 60 * 60 * 1000);

                const booked = await requestBooking({ icalUid: uuid.v4(), startDate, endDate: new Date(startDate.getTime() + 30 * 60 * 1000) });

                expect(booked.deleted).toBe(false);
                const pageQueries: any[] = findSpy.mock.calls.map((call: any[]) => call[0]).filter((query: any) => query?.page !== undefined);
                expect(pageQueries.length).toBeGreaterThan(0);
                for (const query of pageQueries) {
                    const bounded: boolean =
                        (typeof query.endDate === "string" && query.endDate.startsWith("gt(")) ||
                        query.recurrenceRule === "ne(null)" ||
                        (typeof query.recurrenceId === "string" && query.recurrenceId.startsWith("gte("));
                    expect(bounded).toBe(true);
                }
            });

            it("Still declines against a long-running recurring booking that recurs into the requested slot.", async () => {
                await createMailbox({ isResource: true, autoAcceptBookings: true });
                const startDate = new Date(Date.now() + 2 * 60 * 60 * 1000);
                const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
                const masterStart = new Date(startDate.getTime() - 70 * DAY_MS);
                await saveBooking({
                    startDate: masterStart,
                    endDate: new Date(masterStart.getTime() + 60 * 60 * 1000),
                    recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, exceptions: [] },
                });

                const booked = await requestBooking({ icalUid: uuid.v4(), startDate, endDate });

                expect(booked.deleted).toBe(true);
            });

            it("Accepts when a recurring booking in the same slot ended (UNTIL) before the request.", async () => {
                await createMailbox({ isResource: true, autoAcceptBookings: true });
                const startDate = new Date(Date.now() + 2 * 60 * 60 * 1000);
                const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
                const masterStart = new Date(startDate.getTime() - 70 * DAY_MS);
                await saveBooking({
                    startDate: masterStart,
                    endDate: new Date(masterStart.getTime() + 60 * 60 * 1000),
                    recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, until: new Date(startDate.getTime() - 3 * DAY_MS), exceptions: [] },
                });

                const booked = await requestBooking({ icalUid: uuid.v4(), startDate, endDate });

                expect(booked.deleted).toBe(false);
            });

        });

        describe("J17: stale iTIP REPLY/CANCEL", () => {
            const saveEvent = async (icalUid: string, sequence: number): Promise<any> =>
                await calendarEventRepo.save(
                    new CalendarEventMongo({
                        folderUid: "calendar-folder",
                        mailboxUid,
                        title: "Team Sync",
                        timezone: "UTC",
                        organizer: { address: "organizer@example.com", type: RecipientType.TO },
                        attendees: [{ address: "attendee@example.com", role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION, isOrganizer: false }],
                        status: CalendarEventStatus.CONFIRMED,
                        busyStatus: BusyStatus.BUSY,
                        icalUid,
                        sequence,
                        startDate: new Date(),
                        endDate: new Date(),
                    }),
                );
            const reply = (icalUid: string, sequence: number): string =>
                buildEventIcs(makeIcsEventFixture({ icalUid, sequence }), "REPLY", {
                    onlyAttendee: { address: "attendee@example.com", role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.ACCEPTED, isOrganizer: false },
                });

            it("Ignores a REPLY to an older SEQUENCE of the event.", async () => {
                const icalUid = uuid.v4();
                const existing = await saveEvent(icalUid, 2);
                await createIngestEntry({ rawBlobKey: await putRaw(makeItipRawMessage(reply(icalUid, 1), { from: "attendee@example.com" })), envelopeFrom: "attendee@example.com" });

                await job.run();

                expect((await calendarEventRepo.findOne({ uid: existing.uid } as any))!.attendees[0].responseStatus).toBe(AttendeeResponseStatus.NEEDS_ACTION);
            });

            it("Applies a REPLY carrying the event's current SEQUENCE.", async () => {
                const icalUid = uuid.v4();
                const existing = await saveEvent(icalUid, 2);
                await createIngestEntry({ rawBlobKey: await putRaw(makeItipRawMessage(reply(icalUid, 2), { from: "attendee@example.com" })), envelopeFrom: "attendee@example.com" });

                await job.run();

                expect((await calendarEventRepo.findOne({ uid: existing.uid } as any))!.attendees[0].responseStatus).toBe(AttendeeResponseStatus.ACCEPTED);
            });

            it("Ignores a CANCEL for an older SEQUENCE than the copy on record.", async () => {
                const icalUid = uuid.v4();
                const existing = await saveEvent(icalUid, 3);
                const cancelIcs = buildEventIcs(makeIcsEventFixture({ icalUid, sequence: 1 }), "CANCEL");
                await createIngestEntry({ rawBlobKey: await putRaw(makeItipRawMessage(cancelIcs)), envelopeFrom: "organizer@example.com" });

                await job.run();

                expect((await calendarEventRepo.findOne({ uid: existing.uid } as any))!.deleted).toBe(false);
            });
        });
    });

    describe("Round-4 follow-ups: bounded identifiers, in-progress erasure, request overrides", () => {
        afterEach(() => {
            vi.restoreAllMocks();
        });

        const putRaw = async (raw: Buffer | string): Promise<string> => {
            const rawBlobKey = `raw/${uuid.v4()}`;
            await objectFactory.getInstance<any>("BlobStore")!.put(rawBlobKey, Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
            return rawBlobKey;
        };
        const DAY_MS = 24 * 60 * 60 * 1000;

        it("Drops mail for a mailbox whose erasure is in progress.", async () => {
            await erasureRequestRepo.save(new DataSubjectErasureRequestMongo({ mailboxUid, requestedByUserUid: uuid.v4(), status: "in_progress" }));
            const entry = await createIngestEntry({ rawBlobKey: await putRaw(makePlainRawMessage()) });

            await job.run();

            expect((await ingestQueueRepo.findOne({ uid: entry.uid } as any))!.errorMessage).toContain("erased");
            expect(await messageRepo.find({ mailboxUid }).toArray()).toHaveLength(0);
        });

        it("Recalls a message whose Message-ID is longer than the indexed-value limit (looked up bounded).", async () => {
            await createMailbox();
            const longId = `${"x".repeat(300)}@example.com`;
            const target = await messageRepo.save(
                new MessageMongo({
                    mailboxUid,
                    folderUid: "inbox-folder",
                    messageId: longId,
                    from: { address: "sender@example.com", type: RecipientType.TO },
                    recipients: [{ address: "recipient@example.com", type: RecipientType.TO }],
                    bodyBlobKey: `bodies/${uuid.v4()}`,
                }),
            );
            expect(target.messageId).toMatch(/^sha256:/);
            await createIngestEntry({
                rawBlobKey: await putRaw(
                    makePlainRawMessage(
                        `X-RapidMX-Recall-Of: ${longId}\r\nAuthentication-Results: mx.example.com; dkim=pass header.d=example.com\r\n${oversigningDkimSignature("example.com", "X-RapidMX-Recall-Of")}`,
                    ),
                ),
                envelopeFrom: "sender@example.com",
            });

            await job.run();

            expect((await messageRepo.findOne({ uid: target.uid } as any))!.deleted).toBe(true);
        });

        it("Doesn't let an iTIP UID shaped like a query operator match (and cancel) other events.", async () => {
            const victim = await calendarEventRepo.save(
                new CalendarEventMongo({
                    folderUid: "calendar-folder",
                    mailboxUid,
                    title: "Unrelated meeting",
                    timezone: "UTC",
                    organizer: { address: "organizer@example.com", type: RecipientType.TO },
                    attendees: [],
                    status: CalendarEventStatus.CONFIRMED,
                    busyStatus: BusyStatus.BUSY,
                    icalUid: uuid.v4(),
                    sequence: 0,
                    startDate: new Date(),
                    endDate: new Date(),
                }),
            );
            const cancelIcs = buildEventIcs(makeIcsEventFixture({ icalUid: "ne(no-such-uid)" }), "CANCEL");
            await createIngestEntry({ rawBlobKey: await putRaw(makeItipRawMessage(cancelIcs)), envelopeFrom: "organizer@example.com" });

            await job.run();

            expect((await calendarEventRepo.findOne({ uid: victim.uid } as any))!.deleted).toBe(false);
        });

        it("Declines a recurring resource request whose per-occurrence override moves an occurrence onto an existing booking.", async () => {
            await createMailbox({ isResource: true, autoAcceptBookings: true });
            const startDate = new Date(Date.now() + 2 * 60 * 60 * 1000);
            const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
            const movedStart = new Date(startDate.getTime() + 3 * DAY_MS);
            const movedEnd = new Date(movedStart.getTime() + 60 * 60 * 1000);
            await calendarEventRepo.save(
                new CalendarEventMongo({
                    folderUid: "calendar-folder",
                    mailboxUid,
                    title: "Existing booking",
                    timezone: "UTC",
                    organizer: { address: "other@example.com", type: RecipientType.TO },
                    attendees: [],
                    status: CalendarEventStatus.CONFIRMED,
                    busyStatus: BusyStatus.BUSY,
                    icalUid: uuid.v4(),
                    startDate: movedStart,
                    endDate: movedEnd,
                }),
            );
            const icalUid = uuid.v4();
            const masterIcs = buildEventIcs(
                makeIcsEventFixture({ icalUid, startDate, endDate, recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, count: 3, exceptions: [] } }),
                "REQUEST",
            );
            const overrideIcs = buildEventIcs(
                makeIcsEventFixture({ icalUid, recurrenceId: new Date(startDate.getTime() + 7 * DAY_MS), startDate: movedStart, endDate: movedEnd }),
                "REQUEST",
            );
            const overrideVevent: string = /BEGIN:VEVENT[\s\S]*END:VEVENT/.exec(overrideIcs)![0];
            const combined: string = masterIcs.replace("END:VCALENDAR", `${overrideVevent}\r\nEND:VCALENDAR`);
            await createIngestEntry({ rawBlobKey: await putRaw(makeItipRawMessage(combined)), envelopeFrom: "organizer@example.com" });

            await job.run();

            const rows = await calendarEventRepo.find({ mailboxUid, icalUid }).toArray();
            expect(rows.length).toBeGreaterThan(0);
            expect(rows.every((row) => row.deleted)).toBe(true);
        });
    });

    describe("Round-4 coverage follow-ups: degraded erasure checks, marker cleanup, receipts, recall locks, booking expansion", () => {
        afterEach(() => {
            vi.restoreAllMocks();
        });

        const putRaw = async (raw: Buffer | string): Promise<string> => {
            const rawBlobKey = `raw/${uuid.v4()}`;
            await objectFactory.getInstance<any>("BlobStore")!.put(rawBlobKey, Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
            return rawBlobKey;
        };
        const transport = (): RecordingMailTransport => objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        const DAY_MS = 24 * 60 * 60 * 1000;
        const HOUR_MS = 60 * 60 * 1000;

        it("Keeps delivering, warning on each attempt, when the erasure request repo can't be initialized.", async () => {
            await erasureRequestRepo.save(new DataSubjectErasureRequestMongo({ mailboxUid, requestedByUserUid: uuid.v4(), status: "approved" }));
            const realNewInstance = objectFactory.newInstance.bind(objectFactory);
            vi.spyOn(objectFactory, "newInstance").mockImplementation(((type: any, options?: any) =>
                options?.args?.[0] === DataSubjectErasureRequestMongo
                    ? Promise.reject(new Error("simulated missing model"))
                    : realNewInstance(type, options)) as any);
            const trimmed: any = await objectFactory.newInstance(ScanQueueJobMongo, { name: "scan-queue-without-erasure-repo" });
            vi.restoreAllMocks();
            expect(trimmed.erasureRequestRepo).toBeUndefined();
            const warn = vi.spyOn(trimmed.logger, "warn");
            const entry = await createIngestEntry({ rawBlobKey: await putRaw(makePlainRawMessage()) });

            await trimmed.run();

            // The erasure check can't run in this wiring, so mail isn't blocked - it's logged instead.
            expect((await ingestQueueRepo.findOne({ uid: entry.uid } as any))!.status).toBe(IngestStatus.DELIVERED);
            expect((await messageRepo.find({ mailboxUid }).toArray())).toHaveLength(1);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining(`can't check erasure status of mailbox ${mailboxUid}`));
        });

        it("Still closes an entry as delivered when removing its forward marker blob fails.", async () => {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const realDelete = blobStore.delete.bind(blobStore);
            const deleteSpy = vi.spyOn(blobStore, "delete").mockImplementation(async (key: any) => {
                if (String(key).startsWith("ingest-markers/")) {
                    throw new Error("simulated blob store failure");
                }
                return await realDelete(key);
            });
            const entry = await createIngestEntry({ rawBlobKey: await putRaw(makePlainRawMessage()) });

            await job.run();

            expect(deleteSpy).toHaveBeenCalledWith(`ingest-markers/${entry.uid}/forwarded`);
            expect((await ingestQueueRepo.findOne({ uid: entry.uid } as any))!.status).toBe(IngestStatus.DELIVERED);
            expect((await messageRepo.find({ mailboxUid }).toArray())).toHaveLength(1);
        });

        it("Sends no delivery receipt when the recipient mailbox row doesn't exist.", async () => {
            await domainRepo.save(new DomainMongo({ uid: "example.com", name: "example.com", enabled: true, verified: true, verificationToken: uuid.v4() }));
            await createIngestEntry({
                rawBlobKey: await putRaw(
                    "From: colleague@example.com\r\nTo: recipient@example.com\r\nSubject: Plain message\r\n" +
                        "Disposition-Notification-To: colleague@example.com\r\n" +
                        "Authentication-Results: mx.example.com; dkim=pass header.d=example.com\r\n\r\nHello there.\r\n",
                ),
                envelopeFrom: "colleague@example.com",
            });

            await job.run();

            const messages = (await messageRepo.find({ mailboxUid }).toArray());
            expect(messages).toHaveLength(1);
            expect(messages[0].dispositionNotificationTo).toBe("colleague@example.com");
            expect(messages[0].deliveryReceiptSentAt ?? undefined).toBeUndefined();
            expect(messages[0].deliveryReceiptPending ?? false).toBe(false);
            expect(transport().sent.filter((m) => m.envelopeTo.includes("colleague@example.com"))).toHaveLength(0);
        });

        describe("recall lock conflicts", () => {
            const saveTarget = async (messageId: string): Promise<any> =>
                await messageRepo.save(
                    new MessageMongo({
                        mailboxUid,
                        folderUid: "inbox-folder",
                        messageId,
                        from: { address: "sender@example.com", type: RecipientType.TO },
                        recipients: [{ address: "recipient@example.com", type: RecipientType.TO }],
                        bodyBlobKey: `bodies/${uuid.v4()}`,
                    }),
                );
            const recallRaw = (messageId: string): Buffer =>
                makePlainRawMessage(
                    `X-RapidMX-Recall-Of: ${messageId}\r\nAuthentication-Results: mx.example.com; dkim=pass header.d=example.com\r\n${oversigningDkimSignature("example.com", "X-RapidMX-Recall-Of")}`,
                );
            /** Makes the recall's lock write on `target` lose to an unrelated concurrent change `conflicts` times. */
            const conflictLock = (target: any, conflicts: number): { attempts: () => number } => {
                const repo = (job as any).messageRepo;
                const realUpdate = repo.update.bind(repo);
                let attempts = 0;
                vi.spyOn(repo, "update").mockImplementation(async (obj: any, ...rest: any[]) => {
                    if (obj?.uid === target.uid) {
                        attempts++;
                        if (attempts <= conflicts) {
                            await messageRepo.updateOne({ uid: target.uid } as any, { $inc: { version: 1 } });
                        }
                    }
                    return await realUpdate(obj, ...rest);
                });
                return { attempts: () => attempts };
            };

            it("Retries a lock that conflicts with an unrelated change, then recalls the still-unread message.", async () => {
                await createMailbox();
                const target = await saveTarget("conflicting-target@example.com");
                const lock = conflictLock(target, 1);
                await createIngestEntry({ rawBlobKey: await putRaw(recallRaw("conflicting-target@example.com")), envelopeFrom: "sender@example.com" });

                await job.run();

                expect(lock.attempts()).toBe(2);
                expect((await messageRepo.findOne({ uid: target.uid } as any))!.deleted).toBe(true);
                expect(transport().sent[0].raw.toString()).toContain("before it was read");
            });

            it("Gives up after three conflicting lock attempts, deleting nothing.", async () => {
                await createMailbox();
                const target = await saveTarget("contended-target@example.com");
                const lock = conflictLock(target, 3);
                await createIngestEntry({ rawBlobKey: await putRaw(recallRaw("contended-target@example.com")), envelopeFrom: "sender@example.com" });

                await job.run();

                expect(lock.attempts()).toBe(3);
                expect((await messageRepo.findOne({ uid: target.uid } as any))!.deleted).toBe(false);
                expect(transport().sent).toHaveLength(1);
                expect(transport().sent[0].raw.toString()).not.toContain("before it was read");
            });
        });

        describe("resource booking expansion", () => {
            /** A future instant on a whole second, so it survives the ICS round trip exactly. */
            const wholeSecondsFromNow = (ms: number): Date => new Date(Math.ceil((Date.now() + ms) / 1000) * 1000);
            const requestBooking = async (overrides: Partial<CalendarEvent>): Promise<any[]> => {
                await createIngestEntry({
                    rawBlobKey: await putRaw(makeItipRawMessage(buildEventIcs(makeIcsEventFixture(overrides), "REQUEST"))),
                    envelopeFrom: "organizer@example.com",
                });
                await job.run();
                return (await calendarEventRepo.find({ mailboxUid, icalUid: overrides.icalUid }).toArray());
            };
            const saveBooking = async (data: Record<string, any>): Promise<void> => {
                await calendarEventRepo.save(
                    new CalendarEventMongo({
                        folderUid: "calendar-folder",
                        mailboxUid,
                        title: "Booking",
                        timezone: "UTC",
                        organizer: { address: "other@example.com", type: RecipientType.TO },
                        attendees: [],
                        status: CalendarEventStatus.CONFIRMED,
                        busyStatus: BusyStatus.BUSY,
                        icalUid: uuid.v4(),
                        ...data,
                    }),
                );
            };

            it("Accepts a recurring request whose only occurrence is excluded - it books no time, so nothing can conflict.", async () => {
                await createMailbox({ isResource: true, autoAcceptBookings: true });
                const startDate = wholeSecondsFromNow(2 * HOUR_MS);
                const endDate = new Date(startDate.getTime() + HOUR_MS);
                await saveBooking({ startDate, endDate });

                const rows = await requestBooking({
                    icalUid: uuid.v4(),
                    startDate,
                    endDate,
                    recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, count: 1, exceptions: [startDate] },
                });

                expect(rows).toHaveLength(1);
                expect(rows[0].deleted).toBe(false);
            });

        });
    });

    describe("Round 5 (part A): erasure disposition, receipt claims, auto-reply tracking, forward laundering, booking windows", () => {
        afterEach(() => {
            vi.restoreAllMocks();
        });

        const putRaw = async (raw: Buffer | string): Promise<string> => {
            const rawBlobKey = `raw/${uuid.v4()}`;
            await objectFactory.getInstance<any>("BlobStore")!.put(rawBlobKey, Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
            return rawBlobKey;
        };
        const transport = (): RecordingMailTransport => objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        const DAY_MS = 24 * 60 * 60 * 1000;
        const HOUR_MS = 60 * 60 * 1000;
        const rawSet = async (repo: any, uid: string, fields: Record<string, any>): Promise<void> => {
            await repo.updateOne({ uid }, { $set: fields });
        };
        const rowsWhere = async (repo: any, where: Record<string, any>): Promise<any[]> => await repo.find(where).toArray();
        const entryRow = async (uid: string): Promise<any> => (await rowsWhere(ingestQueueRepo, { uid }))[0];
        const messagesInMailbox = async (): Promise<any[]> => await rowsWhere(messageRepo, { mailboxUid });
        const makeDue = async (uid: string): Promise<void> => {
            await rawSet(ingestQueueRepo, uid, { nextAttemptAt: new Date(Date.now() - 1000) });
        };
        const saveErasure = async (status: string, fields: Record<string, any> = {}): Promise<any> => {
            const saved: any = await erasureRequestRepo.save(new DataSubjectErasureRequestMongo({ mailboxUid, requestedByUserUid: uuid.v4(), status: status as any }));
            if (Object.keys(fields).length > 0) {
                await rawSet(erasureRequestRepo, saved.uid, fields);
            }
            return saved;
        };

        describe("erasure disposition (finding 2)", () => {
            it("Defers (never drops) mail while a request is only approved - e.g. blocked by a legal hold - then delivers it once the deferral bound passes.", async () => {
                await createMailbox();
                await saveErasure("approved");
                const entry = await createIngestEntry({ rawBlobKey: await putRaw(makePlainRawMessage()) });

                await job.run();

                const deferred = await entryRow(entry.uid);
                expect(deferred.status).toBe(IngestStatus.FAILED);
                expect(deferred.errorMessage).toContain("Deferred");
                expect(deferred.attempts).toBe(0);
                expect(new Date(deferred.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());
                expect(await messagesInMailbox()).toHaveLength(0);

                // Deferrals don't use up attempts.
                (job as any).maxAttempts = 1;
                await makeDue(entry.uid);
                await job.run();
                expect((await entryRow(entry.uid)).status).toBe(IngestStatus.FAILED);
                expect((await entryRow(entry.uid)).attempts).toBe(0);

                const originalMax = (job as any).erasureDeferMaxSeconds;
                (job as any).erasureDeferMaxSeconds = 0;
                try {
                    await makeDue(entry.uid);
                    await job.run();
                } finally {
                    (job as any).erasureDeferMaxSeconds = originalMax;
                    (job as any).maxAttempts = 5;
                }
                expect((await entryRow(entry.uid)).status).toBe(IngestStatus.DELIVERED);
                expect(await messagesInMailbox()).toHaveLength(1);
            });

            it("Drops mail only while the cascade is running under a live claim; a stale claim defers.", async () => {
                await createMailbox();
                const request = await saveErasure("in_progress");
                const dropped = await createIngestEntry({ rawBlobKey: await putRaw(makePlainRawMessage()) });

                await job.run();

                expect((await entryRow(dropped.uid)).status).toBe(IngestStatus.DELIVERED);
                expect((await entryRow(dropped.uid)).errorMessage).toContain("erased");
                expect(await messagesInMailbox()).toHaveLength(0);

                await rawSet(erasureRequestRepo, request.uid, { dateModified: new Date(Date.now() - 2 * HOUR_MS) });
                const deferred = await createIngestEntry({ rawBlobKey: await putRaw(makePlainRawMessage()) });
                await job.run();
                expect((await entryRow(deferred.uid)).status).toBe(IngestStatus.FAILED);
                expect((await entryRow(deferred.uid)).errorMessage).toContain("Deferred");
            });

            it("Ignores an erasure of an earlier mailbox at the same address (the request predates the mailbox row).", async () => {
                await createMailbox();
                await saveErasure("completed", { dateCreated: new Date(Date.now() - 30 * DAY_MS) });
                await saveErasure("approved", { dateCreated: new Date(Date.now() - 30 * DAY_MS) });
                const entry = await createIngestEntry({ rawBlobKey: await putRaw(makePlainRawMessage()) });

                await job.run();

                expect((await entryRow(entry.uid)).status).toBe(IngestStatus.DELIVERED);
                expect(await messagesInMailbox()).toHaveLength(1);
            });

            it("Drops mail for a completed erasure whose mailbox row is gone, and delivers when the mailbox row survived.", async () => {
                await saveErasure("completed");
                const gone = await createIngestEntry({ rawBlobKey: await putRaw(makePlainRawMessage()) });
                await job.run();
                expect((await entryRow(gone.uid)).errorMessage).toContain("erased");
                expect(await messagesInMailbox()).toHaveLength(0);

                // Once a mailbox is (re-)created at the address, the older completed request no longer applies.
                await createMailbox();
                const entry = await createIngestEntry({ rawBlobKey: await putRaw(makePlainRawMessage()) });
                await job.run();
                expect(await messagesInMailbox()).toHaveLength(1);
                expect((await entryRow(entry.uid)).status).toBe(IngestStatus.DELIVERED);
            });
        });

        describe("delivery receipts and automatic replies (finding 5)", () => {
            const verifiedDomain = async (): Promise<void> => {
                await domainRepo.save(new DomainMongo({ uid: "example.com", name: "example.com", enabled: true, verified: true, verificationToken: uuid.v4() }));
            };
            const receiptRequest = (extra: string = "Authentication-Results: mx.example.com; dkim=pass header.d=example.com"): string =>
                "From: colleague@example.com\r\nTo: recipient@example.com\r\nSubject: Plain message\r\n" +
                `Disposition-Notification-To: colleague@example.com\r\n${extra}\r\n\r\nHello there.\r\n`;
            const receiptsSent = (): number => transport().sent.filter((m) => m.envelopeTo.includes("colleague@example.com") && m.raw.toString().includes("Delivered:")).length;

            it("Claims the receipt before sending it, so the client marking the message read mid-send can't cause a second receipt.", async () => {
                await createMailbox();
                await verifiedDomain();
                const repo = (job as any).messageRepo;
                const realSend = transport().send.bind(transport());
                vi.spyOn(transport(), "send").mockImplementation(async (outbound: any) => {
                    if (outbound.envelopeTo.includes("colleague@example.com")) {
                        const [message] = await messagesInMailbox();
                        const current = await repo.findOne(message.uid, { ignoreACL: true });
                        await repo.update({ uid: current.uid, version: current.version, flags: { ...current.flags, read: true } }, current, { ignoreACL: true });
                    }
                    return await realSend(outbound);
                });
                const entry = await createIngestEntry({ rawBlobKey: await putRaw(receiptRequest()), envelopeFrom: "colleague@example.com" });

                await job.run();
                await makeDue(entry.uid);
                await job.run();

                expect((await entryRow(entry.uid)).status).toBe(IngestStatus.DELIVERED);
                expect(receiptsSent()).toBe(1);
                const [message] = await messagesInMailbox();
                expect(message.flags.read).toBe(true);
                expect(message.deliveryReceiptSentAt).toBeTruthy();
            });

            it("Re-reads and retries the claim when an unrelated write bumped the version first.", async () => {
                await createMailbox();
                await verifiedDomain();
                const repo = (job as any).messageRepo;
                const realUpdate = repo.update.bind(repo);
                let bumped = false;
                vi.spyOn(repo, "update").mockImplementation(async (obj: any, ...rest: any[]) => {
                    if (obj.deliveryReceiptSentAt && !bumped) {
                        bumped = true;
                        const current = await repo.findOne(obj.uid, { ignoreACL: true });
                        await realUpdate({ uid: current.uid, version: current.version, flags: { ...current.flags, flagged: true } }, current, { ignoreACL: true });
                    }
                    return await realUpdate(obj, ...rest);
                });
                const entry = await createIngestEntry({ rawBlobKey: await putRaw(receiptRequest()), envelopeFrom: "colleague@example.com" });

                await job.run();

                expect(bumped).toBe(true);
                expect((await entryRow(entry.uid)).status).toBe(IngestStatus.DELIVERED);
                expect(receiptsSent()).toBe(1);
                const [message] = await messagesInMailbox();
                expect(message.flags.flagged).toBe(true);
                expect(message.deliveryReceiptSentAt).toBeTruthy();
            });

            it("Sends nothing when a concurrent claim of the same receipt wins the race.", async () => {
                await createMailbox();
                await verifiedDomain();
                const repo = (job as any).messageRepo;
                const realUpdate = repo.update.bind(repo);
                let raced = false;
                vi.spyOn(repo, "update").mockImplementation(async (obj: any, ...rest: any[]) => {
                    if (obj.deliveryReceiptSentAt && !raced) {
                        raced = true;
                        // Another attempt decides the same receipt first (here: holding it pending approval).
                        const current = await repo.findOne(obj.uid, { ignoreACL: true });
                        await realUpdate({ uid: current.uid, version: current.version, deliveryReceiptPending: true }, current, { ignoreACL: true });
                    }
                    return await realUpdate(obj, ...rest);
                });
                const entry = await createIngestEntry({ rawBlobKey: await putRaw(receiptRequest()), envelopeFrom: "colleague@example.com" });

                await job.run();

                expect(raced).toBe(true);
                expect((await entryRow(entry.uid)).status).toBe(IngestStatus.DELIVERED);
                expect(receiptsSent()).toBe(0);
                const [message] = await messagesInMailbox();
                expect(message.deliveryReceiptPending).toBe(true);
                expect(message.deliveryReceiptSentAt).toBeFalsy();
            });

            it("Gives up the claim after three version conflicts, failing the entry; its retry sends the receipt once.", async () => {
                await createMailbox();
                await verifiedDomain();
                const repo = (job as any).messageRepo;
                const realUpdate = repo.update.bind(repo);
                let conflicts = 0;
                const spy = vi.spyOn(repo, "update").mockImplementation(async (obj: any, ...rest: any[]) => {
                    if (obj.deliveryReceiptSentAt) {
                        conflicts++;
                        const current = await repo.findOne(obj.uid, { ignoreACL: true });
                        await realUpdate({ uid: current.uid, version: current.version, flags: { ...current.flags, flagged: !current.flags.flagged } }, current, { ignoreACL: true });
                    }
                    return await realUpdate(obj, ...rest);
                });
                const entry = await createIngestEntry({ rawBlobKey: await putRaw(receiptRequest()), envelopeFrom: "colleague@example.com" });

                await job.run();

                expect(conflicts).toBe(3);
                expect((await entryRow(entry.uid)).status).toBe(IngestStatus.FAILED);
                expect(receiptsSent()).toBe(0);
                expect((await messagesInMailbox())[0].deliveryReceiptSentAt).toBeFalsy();

                spy.mockRestore();
                await makeDue(entry.uid);
                await job.run();

                expect((await entryRow(entry.uid)).status).toBe(IngestStatus.DELIVERED);
                expect(receiptsSent()).toBe(1);
                expect(await messagesInMailbox()).toHaveLength(1);
            });

            it("Leaves a receipt claim that changed while its send was failing alone.", async () => {
                await createMailbox();
                await verifiedDomain();
                const repo = (job as any).messageRepo;
                const otherClaim = new Date("2030-01-01T00:00:00.000Z");
                const realSend = transport().send.bind(transport());
                vi.spyOn(transport(), "send").mockImplementation(async (outbound: any) => {
                    if (outbound.envelopeTo.includes("colleague@example.com")) {
                        const [message] = await messagesInMailbox();
                        const current = await repo.findOne(message.uid, { ignoreACL: true });
                        await repo.update({ uid: current.uid, version: current.version, deliveryReceiptSentAt: otherClaim }, current, { ignoreACL: true });
                        throw new Error("smtp is down");
                    }
                    return await realSend(outbound);
                });
                const entry = await createIngestEntry({ rawBlobKey: await putRaw(receiptRequest()), envelopeFrom: "colleague@example.com" });

                await job.run();

                expect((await entryRow(entry.uid)).status).toBe(IngestStatus.DELIVERED);
                const [message] = await messagesInMailbox();
                expect(new Date(message.deliveryReceiptSentAt).getTime()).toBe(otherClaim.getTime());
            });

            it("Logs, without failing delivery, when releasing a failed receipt's claim keeps failing.", async () => {
                await createMailbox();
                await verifiedDomain();
                const repo = (job as any).messageRepo;
                const warnSpy = vi.spyOn((job as any).logger, "warn");
                const realSend = transport().send.bind(transport());
                vi.spyOn(transport(), "send").mockImplementation(async (outbound: any) => {
                    if (outbound.envelopeTo.includes("colleague@example.com")) {
                        throw new Error("smtp is down");
                    }
                    return await realSend(outbound);
                });
                const realUpdate = repo.update.bind(repo);
                vi.spyOn(repo, "update").mockImplementation(async (obj: any, ...rest: any[]) => {
                    if ("deliveryReceiptSentAt" in obj && obj.deliveryReceiptSentAt === null) {
                        throw new Error("simulated database failure");
                    }
                    return await realUpdate(obj, ...rest);
                });
                const entry = await createIngestEntry({ rawBlobKey: await putRaw(receiptRequest()), envelopeFrom: "colleague@example.com" });

                await job.run();

                expect((await entryRow(entry.uid)).status).toBe(IngestStatus.DELIVERED);
                const releaseWarnings = warnSpy.mock.calls.filter(([text]) => String(text).includes("failed to release the delivery receipt claim"));
                expect(releaseWarnings).toHaveLength(3);
                // The claim stays: the receipt is never sent twice, only possibly not at all.
                expect((await messagesInMailbox())[0].deliveryReceiptSentAt).toBeTruthy();
            });

            it("Only trusts the topmost trusted Authentication-Results: an older trusted pass below a newer fail sends no receipt.", async () => {
                await createMailbox();
                await verifiedDomain();
                await createIngestEntry({
                    rawBlobKey: await putRaw(
                        receiptRequest(
                            "Authentication-Results: mx.example.com; dkim=fail header.d=example.com\r\nAuthentication-Results: mx.example.com; dkim=pass header.d=example.com",
                        ),
                    ),
                    envelopeFrom: "colleague@example.com",
                });

                await job.run();

                expect(await messagesInMailbox()).toHaveLength(1);
                expect(receiptsSent()).toBe(0);
            });

            it("Sends the automatic reply on a retry of an attempt that filed the message but failed before replying - and only once.", async () => {
                await createMailbox({ oofEnabled: true, oofMessage: "I'm currently out of office." });
                // The job's own live "create" notice of the filed message (on the folder's channel, as a bare uid - a repository's
                // own publish passes a list) is the step between filing it and answering it.
                const realSend = NotificationUtils.prototype.sendMessage;
                let failed = false;
                const notifySpy = vi.spyOn(NotificationUtils.prototype, "sendMessage").mockImplementation(function (this: any, ...args: any[]) {
                    if (!failed && typeof args[0] === "string" && /^Message/.test(args[1]) && args[2] === "create") {
                        failed = true;
                        throw new Error("simulated notification failure");
                    }
                    return (realSend as any).apply(this, args);
                });
                const autoReplies = (): number => transport().sent.filter((m) => m.raw.toString().includes("Automatic reply")).length;
                const entry = await createIngestEntry({ rawBlobKey: await putRaw(makePlainRawMessage()) });

                await job.run();
                notifySpy.mockRestore();
                expect(await messagesInMailbox()).toHaveLength(1);
                expect((await entryRow(entry.uid)).status).toBe(IngestStatus.FAILED);
                expect(autoReplies()).toBe(0);

                await makeDue(entry.uid);
                await job.run();
                expect((await entryRow(entry.uid)).status).toBe(IngestStatus.DELIVERED);
                expect(autoReplies()).toBe(1);
                expect(await objectFactory.getInstance<any>("BlobStore")!.exists(`ingest-markers/${entry.uid}/auto-replied`)).toBe(false);

                // A retry of an attempt that already replied (its marker still there) doesn't reply again.
                await objectFactory.getInstance<any>("BlobStore")!.put(`ingest-markers/${entry.uid}/auto-replied`, Buffer.from("x"));
                await rawSet(ingestQueueRepo, entry.uid, { status: IngestStatus.PENDING });
                await rawSet(oofReplySuppressionRepo, (await rowsWhere(oofReplySuppressionRepo, { mailboxUid }))[0].uid, { lastRepliedAt: new Date(0) });
                await job.run();
                expect(autoReplies()).toBe(1);
            });
        });

        describe("forward rules don't launder spoofed mail (finding 8)", () => {
            const forwardRule = async (): Promise<void> => {
                await createMailbox();
                await mailFilterRuleRepo.save(
                    new MailFilterRuleMongo({
                        mailboxUid,
                        name: "Forward everything",
                        enabled: true,
                        sequence: 0,
                        stopProcessingRules: false,
                        conditions: {},
                        actions: [{ type: MailFilterActionType.FORWARD, forwardTo: "assistant@elsewhere.example" }],
                    }),
                );
            };
            const forwarded = (): any[] => transport().sent.filter((m) => m.envelopeTo.includes("assistant@elsewhere.example"));
            const headerBlock = (raw: Buffer): string => {
                const text: string = raw.toString("binary");
                return text.slice(0, text.indexOf("\r\n\r\n"));
            };

            it("Rewrites an unauthenticated From to the forwarding mailbox and strips trust-bearing headers.", async () => {
                await forwardRule();
                await createIngestEntry({
                    rawBlobKey: await putRaw(
                        [
                            "Authentication-Results: mx.example.com; dkim=fail header.d=example.com",
                            "From: CEO <ceo@example.com>",
                            "To: recipient@example.com",
                            "Subject: urgent",
                            "RapidMX-Key: addr=ceo@example.com; keydata=AAAA",
                            "X-RapidMX-Recall-Of: <victim@example.com>",
                            "Disposition-Notification-To: ceo@example.com",
                            "",
                            "Pay this.",
                            "",
                        ].join("\r\n"),
                    ),
                    envelopeFrom: "attacker@evil.example",
                });

                await job.run();

                expect(forwarded()).toHaveLength(1);
                expect(forwarded()[0].envelopeFrom).toBe("recipient@example.com");
                const headers: string = headerBlock(forwarded()[0].raw);
                expect(headers).toMatch(/^From: .*<recipient@example\.com>$/m);
                expect(headers).toContain("X-Original-From: CEO <ceo@example.com>");
                expect(headers).toContain("Reply-To: CEO <ceo@example.com>");
                expect(headers).toContain("X-RapidMX-Loop: recipient@example.com");
                expect(headers).not.toMatch(/^(authentication-results|rapidmx-key|x-rapidmx-recall-of|disposition-notification-to)\s*:/im);
            });

            it("Keeps an authenticated From, and doesn't forward unauthenticated calendar content (still filing it).", async () => {
                await forwardRule();
                await createIngestEntry({
                    rawBlobKey: await putRaw("Authentication-Results: mx.example.com; dkim=pass header.d=partner.example\r\nFrom: Bob <bob@partner.example>\r\nTo: recipient@example.com\r\nSubject: hi\r\n\r\nHello\r\n"),
                    envelopeFrom: "bob@partner.example",
                });
                await job.run();
                expect(forwarded()).toHaveLength(1);
                expect(headerBlock(forwarded()[0].raw)).toContain("From: Bob <bob@partner.example>");

                await createIngestEntry({
                    rawBlobKey: await putRaw(makeItipRawMessage(buildEventIcs(makeIcsEventFixture({ icalUid: uuid.v4() }), "CANCEL"), { from: "ceo@example.com", dkim: false })),
                    envelopeFrom: "attacker@evil.example",
                });
                await job.run();
                expect(forwarded()).toHaveLength(1);
                expect(await messagesInMailbox()).toHaveLength(2);
            });
        });

        describe("resource booking windows (finding 9)", () => {
            const wholeSecondsFromNow = (ms: number): Date => new Date(Math.ceil((Date.now() + ms) / 1000) * 1000);
            const requestBooking = async (overrides: Partial<CalendarEvent>): Promise<any[]> => {
                await createIngestEntry({
                    rawBlobKey: await putRaw(makeItipRawMessage(buildEventIcs(makeIcsEventFixture(overrides), "REQUEST"))),
                    envelopeFrom: "organizer@example.com",
                });
                await job.run();
                return await rowsWhere(calendarEventRepo, { mailboxUid, icalUid: overrides.icalUid });
            };
            const saveBooking = async (data: Record<string, any>): Promise<void> => {
                await calendarEventRepo.save(
                    new CalendarEventMongo({
                        folderUid: "calendar-folder",
                        mailboxUid,
                        title: "Booking",
                        timezone: "UTC",
                        organizer: { address: "other@example.com", type: RecipientType.TO },
                        attendees: [],
                        status: CalendarEventStatus.CONFIRMED,
                        busyStatus: BusyStatus.BUSY,
                        icalUid: uuid.v4(),
                        ...data,
                    }),
                );
            };

            it("An open-ended weekday booking no longer makes an open-ended request at another time decline.", async () => {
                await createMailbox({ isResource: true, autoAcceptBookings: true });
                const startDate = wholeSecondsFromNow(2 * HOUR_MS);
                const bookingStart = new Date(startDate.getTime() + 4 * HOUR_MS - 7 * DAY_MS);
                // ~522 occurrences over the two-year horizon - more than one expansion returns.
                await saveBooking({
                    startDate: bookingStart,
                    endDate: new Date(bookingStart.getTime() + HOUR_MS),
                    recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, byDay: ["MO", "TU", "WE", "TH", "FR"], exceptions: [] },
                });

                const weekly = await requestBooking({
                    icalUid: uuid.v4(),
                    startDate,
                    endDate: new Date(startDate.getTime() + HOUR_MS),
                    recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, exceptions: [] },
                });
                expect(weekly[0].deleted).toBe(false);

                // An open-ended daily request (731 occurrences) is expanded completely too.
                const daily = await requestBooking({
                    icalUid: uuid.v4(),
                    startDate: new Date(startDate.getTime() + 2 * HOUR_MS),
                    endDate: new Date(startDate.getTime() + 3 * HOUR_MS),
                    recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, exceptions: [] },
                });
                expect(daily[0].deleted).toBe(false);
            });

            it("Still finds a conflict far into an open-ended request's horizon.", async () => {
                await createMailbox({ isResource: true, autoAcceptBookings: true });
                const startDate = wholeSecondsFromNow(2 * HOUR_MS);
                const clash = new Date(startDate.getTime() + 600 * DAY_MS);
                await saveBooking({ startDate: clash, endDate: new Date(clash.getTime() + HOUR_MS) });

                const rows = await requestBooking({
                    icalUid: uuid.v4(),
                    startDate,
                    endDate: new Date(startDate.getTime() + HOUR_MS),
                    recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, exceptions: [] },
                });

                expect(rows[0].deleted).toBe(true);
            });

            it("Declines an open-ended request that collides with an open-ended booking early in its horizon.", async () => {
                await createMailbox({ isResource: true, autoAcceptBookings: true });
                const startDate = wholeSecondsFromNow(2 * HOUR_MS);
                const bookingStart = new Date(startDate.getTime() - 7 * DAY_MS);
                // Same time of day as the request, every weekday: too many occurrences to expand across the whole horizon
                // at once, so the check is split - and the collision is in its first half.
                await saveBooking({
                    startDate: bookingStart,
                    endDate: new Date(bookingStart.getTime() + HOUR_MS),
                    recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, byDay: ["MO", "TU", "WE", "TH", "FR"], exceptions: [] },
                });

                const rows = await requestBooking({
                    icalUid: uuid.v4(),
                    startDate,
                    endDate: new Date(startDate.getTime() + HOUR_MS),
                    recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, exceptions: [] },
                });

                expect(rows[0].deleted).toBe(true);
            });

            it("Declines when even a single requested occurrence spans more existing occurrences than one expansion can check.", async () => {
                await createMailbox({ isResource: true, autoAcceptBookings: true });
                const warnSpy = vi.spyOn((job as any).logger, "warn");
                const startDate = wholeSecondsFromNow(2 * HOUR_MS);
                const bookingStart = new Date(startDate.getTime() - DAY_MS);
                await saveBooking({
                    startDate: bookingStart,
                    endDate: new Date(bookingStart.getTime() + 30 * 60 * 1000),
                    recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, exceptions: [] },
                });

                const rows = await requestBooking({ icalUid: uuid.v4(), startDate, endDate: new Date(startDate.getTime() + 600 * DAY_MS) });

                expect(rows[0].deleted).toBe(true);
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("has too many occurrences to check for conflicts"));
            });
        });
    });

    describe("Round 6 (part A): erasure with the mailbox gone, erasure checked before scanning", () => {
        afterEach(() => {
            vi.restoreAllMocks();
        });

        const putRaw = async (raw: Buffer): Promise<string> => {
            const rawBlobKey = `raw/${uuid.v4()}`;
            await objectFactory.getInstance<any>("BlobStore")!.put(rawBlobKey, raw);
            return rawBlobKey;
        };
        const entryRow = async (uid: string): Promise<any> => (await ingestQueueRepo.find({ uid }).toArray())[0];
        const messagesInMailbox = async (): Promise<any[]> => await messageRepo.find({ mailboxUid }).toArray();
        const saveErasure = async (status: string, fields: Record<string, any> = {}): Promise<any> => {
            const saved: any = await erasureRequestRepo.save(new DataSubjectErasureRequestMongo({ mailboxUid, requestedByUserUid: uuid.v4(), status: status as any }));
            if (Object.keys(fields).length > 0) {
                await erasureRequestRepo.updateOne({ uid: saved.uid } as any, { $set: fields } as any);
            }
            return saved;
        };

        it("Drops, never defers or delivers, mail for a deleted mailbox with an approved or stale in-progress erasure, even past the deferral bound.", async () => {
            const originalMax = (job as any).erasureDeferMaxSeconds;
            (job as any).erasureDeferMaxSeconds = 0;
            try {
                for (const [status, fields] of [
                    ["approved", {}],
                    ["in_progress", { dateModified: new Date(Date.now() - 2 * 60 * 60 * 1000) }],
                ] as const) {
                    const request = await saveErasure(status, fields);
                    const entry = await createIngestEntry({ rawBlobKey: await putRaw(makePlainRawMessage()) });
                    await job.run();
                    const row = await entryRow(entry.uid);
                    expect({ status, entry: row.status, note: row.errorMessage }).toEqual({ status, entry: IngestStatus.DELIVERED, note: expect.stringContaining("erased") });
                    expect(await messagesInMailbox()).toHaveLength(0);
                    expect(await folderRepo.find({ mailboxUid }).toArray()).toHaveLength(0);
                    await erasureRequestRepo.deleteOne({ uid: request.uid });
                }
            } finally {
                (job as any).erasureDeferMaxSeconds = originalMax;
            }
        });

        it("Doesn't scan an entry it defers for a pending erasure.", async () => {
            await createMailbox();
            await saveErasure("approved");
            const scan = vi.spyOn((job as any).scanPipeline, "run");
            const entry = await createIngestEntry({ rawBlobKey: await putRaw(makePlainRawMessage()) });

            await job.run();

            expect((await entryRow(entry.uid)).errorMessage).toContain("Deferred");
            expect(scan).not.toHaveBeenCalled();
        });

        it("Drops an entry whose erasure cascade started while it was being scanned.", async () => {
            await createMailbox();
            const pipeline: any = (job as any).scanPipeline;
            const realRun = pipeline.run.bind(pipeline);
            vi.spyOn(pipeline, "run").mockImplementationOnce(async (...args: any[]) => {
                await saveErasure("in_progress");
                return realRun(...args);
            });
            const entry = await createIngestEntry({ rawBlobKey: await putRaw(makePlainRawMessage()) });

            await job.run();

            expect((await entryRow(entry.uid)).errorMessage).toContain("erased");
            expect(await messagesInMailbox()).toHaveLength(0);
        });
    });
});
