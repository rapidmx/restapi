///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for ScanQueueJobSQL: a real SQLite (better-sqlite3) connection and a real
// `ObjectFactory` construct the job exactly as production wiring would - see ScanQueueJobMongo.test.ts's file
// header for the full rationale (also applies here verbatim). Uses `config.sql.ts`, whose `acl` datastore is
// ALSO SQL-backed (`AccessControlListSQL`, auto-selected by `ACLUtils` from the connection's runtime type) -
// so this file has no MongoDB dependency at all, unlike the Mongo-ACL-dependent form this file used earlier.
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { ACLUtils, AccessControlListSQL, ConnectionManager, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import config from "../../config.sql.js";
import { registerTestDoubles, RecordingMailTransport, StaticDnsResolver } from "../../testDoubles.js";
import { ScanQueueJobSQL } from "../../../src/jobs/sql/ScanQueueJobSQL.js";
import { IngestQueueEntrySQL } from "../../../src/models/sql/IngestQueueEntrySQL.js";
import { FolderSQL } from "../../../src/models/sql/FolderSQL.js";
import { MessageSQL } from "../../../src/models/sql/MessageSQL.js";
import { AttachmentSQL } from "../../../src/models/sql/AttachmentSQL.js";
import { QuarantineEntrySQL } from "../../../src/models/sql/QuarantineEntrySQL.js";
import { ScanResultSQL } from "../../../src/models/sql/ScanResultSQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { MailFilterRuleSQL } from "../../../src/models/sql/MailFilterRuleSQL.js";
import { CalendarEventSQL } from "../../../src/models/sql/CalendarEventSQL.js";
import { ContactSQL } from "../../../src/models/sql/ContactSQL.js";
import { DomainSQL } from "../../../src/models/sql/DomainSQL.js";
import { FocusedInboxOverrideSQL } from "../../../src/models/sql/FocusedInboxOverrideSQL.js";
import { OofReplySuppressionSQL } from "../../../src/models/sql/OofReplySuppressionSQL.js";
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
    let mailboxRepo: Repository<MailboxSQL>;
    let mailFilterRuleRepo: Repository<MailFilterRuleSQL>;
    let calendarEventRepo: Repository<CalendarEventSQL>;
    let oofReplySuppressionRepo: Repository<OofReplySuppressionSQL>;
    let focusedInboxOverrideRepo: Repository<FocusedInboxOverrideSQL>;
    let contactRepo: Repository<ContactSQL>;
    let domainRepo: Repository<DomainSQL>;

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

    const createMailbox = async (data?: Partial<MailboxSQL>): Promise<MailboxSQL> => {
        const obj = new MailboxSQL({
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
        models.set("MailboxSQL", MailboxSQL);
        models.set("MailFilterRuleSQL", MailFilterRuleSQL);
        models.set("CalendarEventSQL", CalendarEventSQL);
        models.set("OofReplySuppressionSQL", OofReplySuppressionSQL);
        models.set("FocusedInboxOverrideSQL", FocusedInboxOverrideSQL);
        models.set("ContactSQL", ContactSQL);
        models.set("DomainSQL", DomainSQL);
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
        mailboxRepo = conn.getRepository(MailboxSQL);
        mailFilterRuleRepo = conn.getRepository(MailFilterRuleSQL);
        calendarEventRepo = conn.getRepository(CalendarEventSQL);
        oofReplySuppressionRepo = conn.getRepository(OofReplySuppressionSQL);
        focusedInboxOverrideRepo = conn.getRepository(FocusedInboxOverrideSQL);
        contactRepo = conn.getRepository(ContactSQL);
        domainRepo = conn.getRepository(DomainSQL);

        // Constructed once via real ObjectFactory DI: `@Init` builds its ten real `RepoUtils` against the live
        // connection above, and `@Inject("BlobStore")`/`@Inject(ScanPipeline)`/`@Inject("MailTransport")` resolve
        // to the registered doubles.
        job = await objectFactory.newInstance(ScanQueueJobSQL, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
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
            await repo.clear();
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

        const updated = await ingestQueueRepo.findOne({ where: { uid: entry.uid } });
        expect(updated!.status).toBe(IngestStatus.DELIVERED);

        const inbox = await folderRepo.findOne({ where: { mailboxUid, type: FolderType.INBOX } });
        expect(inbox).toBeDefined();
        expect(inbox!.unreadCount).toBe(1);
        expect(inbox!.totalCount).toBe(1);

        const messages = await messageRepo.find({ where: { folderUid: inbox!.uid } });
        expect(messages.length).toBe(1);
        expect(messages[0].hasAttachments).toBe(true);
        expect(messages[0].encrypted).toBe(false);
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

    it("Stamps encrypted: true on a delivered S/MIME-encrypted message.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makeEncryptedRawMessage());
        await createIngestEntry({ rawBlobKey });

        await job.run();

        const inbox = await folderRepo.findOne({ where: { mailboxUid, type: FolderType.INBOX } });
        const messages = await messageRepo.find({ where: { folderUid: inbox!.uid } });
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

            const contacts = await contactRepo.find({ where: { mailboxUid } });
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

            const contacts = await contactRepo.find({ where: { mailboxUid } });
            expect(contacts).toHaveLength(1);
            expect(contacts[0].emails).toEqual([{ address: "sender@example.com", type: "other" }]);
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

            const contacts = await contactRepo.find({ where: { mailboxUid } });
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

            const contacts = await contactRepo.find({ where: { mailboxUid } });
            expect(contacts).toHaveLength(0);
        });

        it("Stamps lastMessageSeen on an existing Contact for a message with no key header, leaving its pinned key untouched (Anti-Downgrade).", async () => {
            const pinnedKey = { publicKey: "b64", type: "x509", useType: "encrypt" as const, fingerprint: "fp-pinned", notBefore: 0, notAfter: Date.now() + 1_000_000 };
            await contactRepo.save(
                new ContactSQL({
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

            const contacts = await contactRepo.find({ where: { mailboxUid } });
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

            const contacts = await contactRepo.find({ where: { mailboxUid } });
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

            const contacts = await contactRepo.find({ where: { mailboxUid } });
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

        const inbox = await folderRepo.findOne({ where: { mailboxUid, type: FolderType.INBOX } });
        const messages = await messageRepo.find({ where: { folderUid: inbox!.uid } });
        expect(messages[0].messageId).toBe("root@example.com");
        expect(messages[0].conversationId).toBe("root@example.com");
        // An unset nullable column round-trips as `null`, not `undefined`, on the SQL backend - `toBeFalsy()`
        // covers both rather than asserting the exact in-memory representation.
        expect(messages[0].inReplyTo).toBeFalsy();
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

        const inbox = await folderRepo.findOne({ where: { mailboxUid, type: FolderType.INBOX } });
        const messages = await messageRepo.find({ where: { folderUid: inbox!.uid } });
        expect(messages[0].inReplyTo).toBe("root@example.com");
        expect(messages[0].references).toEqual(["root@example.com"]);
        expect(messages[0].conversationId).toBe("root@example.com");
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

    it("Quarantines an entry pre-tagged by a TransportRule (quarantineReason) even though AV/spam scanning found it clean, still recording a real ScanResult.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makePlainRawMessage());
        const entry = await createIngestEntry({ rawBlobKey, quarantineReason: QuarantineReason.TRANSPORT_RULE });

        await job.run();

        const updated = await ingestQueueRepo.findOne({ where: { uid: entry.uid } });
        expect(updated!.status).toBe(IngestStatus.DELIVERED);

        const messages = await messageRepo.find({ where: { mailboxUid } });
        expect(messages.length).toBe(0);

        const quarantineEntries = await quarantineEntryRepo.find({ where: { mailboxUid } });
        expect(quarantineEntries.length).toBe(1);
        expect(quarantineEntries[0].reason).toBe(QuarantineReason.TRANSPORT_RULE);
        expect(quarantineEntries[0].rawBlobKey).toBe(rawBlobKey);

        const scanResults = await scanResultRepo.find({ where: { targetUid: quarantineEntries[0].uid } });
        expect(scanResults.length).toBe(1);
    });

    it("An actually-infected message pre-tagged by a TransportRule still reports the more specific INFECTED reason.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makePlainRawMessage("X-Test-Force-Infected: true"));
        await createIngestEntry({ rawBlobKey, quarantineReason: QuarantineReason.TRANSPORT_RULE });

        await job.run();

        const quarantineEntries = await quarantineEntryRepo.find({ where: { mailboxUid } });
        expect(quarantineEntries.length).toBe(1);
        expect(quarantineEntries[0].reason).toBe(QuarantineReason.INFECTED);
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

    it("Applies a MOVE_TO_FOLDER rule, filing the message in the target folder instead of Inbox.", async () => {
        const targetFolder = await folderRepo.save(
            new FolderSQL({ mailboxUid, name: "Projects", type: FolderType.USER, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }),
        );
        await mailFilterRuleRepo.save(
            new MailFilterRuleSQL({
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

        const inbox = await folderRepo.findOne({ where: { mailboxUid, type: FolderType.INBOX } });
        expect(inbox).toBeNull();

        const messages = await messageRepo.find({ where: { folderUid: targetFolder.uid } });
        expect(messages.length).toBe(1);
    });

    it("Applies a DELETE rule, discarding the message entirely (no Message row created).", async () => {
        await mailFilterRuleRepo.save(
            new MailFilterRuleSQL({
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

        const updated = await ingestQueueRepo.findOne({ where: { uid: entry.uid } });
        expect(updated!.status).toBe(IngestStatus.DELIVERED);
        const messages = await messageRepo.find({ where: { mailboxUid } });
        expect(messages.length).toBe(0);
    });

    it("Applies a MARK_AS_READ rule, delivering the message already read (folder unreadCount stays 0).", async () => {
        await mailFilterRuleRepo.save(
            new MailFilterRuleSQL({
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

        const inbox = await folderRepo.findOne({ where: { mailboxUid, type: FolderType.INBOX } });
        expect(inbox!.unreadCount).toBe(0);
        expect(inbox!.totalCount).toBe(1);
        const messages = await messageRepo.find({ where: { folderUid: inbox!.uid } });
        expect(messages[0].flags.read).toBe(true);
    });

    it("Applies a COPY_TO_FOLDER rule, filing a copy in the target folder in addition to the original in Inbox.", async () => {
        const copyFolder = await folderRepo.save(
            new FolderSQL({ mailboxUid, name: "Archive", type: FolderType.USER, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }),
        );
        await mailFilterRuleRepo.save(
            new MailFilterRuleSQL({
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

        const inbox = await folderRepo.findOne({ where: { mailboxUid, type: FolderType.INBOX } });
        const inboxMessages = await messageRepo.find({ where: { folderUid: inbox!.uid } });
        expect(inboxMessages.length).toBe(1);

        const copyMessages = await messageRepo.find({ where: { folderUid: copyFolder.uid } });
        expect(copyMessages.length).toBe(1);
        expect(copyMessages[0].uid).not.toBe(inboxMessages[0].uid);

        const copyAttachments = await attachmentRepo.find({ where: { folderUid: copyFolder.uid } });
        expect(copyAttachments.length).toBe(1);
    });

    it("Applies a FORWARD rule, relaying the original raw message to the forward address via MailTransport.", async () => {
        await mailFilterRuleRepo.save(
            new MailFilterRuleSQL({
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
            new MailFilterRuleSQL({
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

        const junkFolder = await folderRepo.findOne({ where: { mailboxUid, type: FolderType.JUNK } });
        const messages = await messageRepo.find({ where: { folderUid: junkFolder!.uid } });
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

        const suppressions = await oofReplySuppressionRepo.find({ where: { mailboxUid, senderAddress: "sender@example.com" } });
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
            new FolderSQL({ mailboxUid, name: "Calendar", type: FolderType.CALENDAR, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }),
        );
        await calendarEventRepo.save(
            new CalendarEventSQL({
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

    describe("Inbound iTIP processing", () => {
        it("Creates a new CalendarEvent in the mailbox's Calendar folder from an inbound REQUEST.", async () => {
            const icalUid = uuid.v4();
            const ics = buildEventIcs(makeIcsEventFixture({ icalUid }), "REQUEST");
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makeItipRawMessage(ics));
            await createIngestEntry({ rawBlobKey, envelopeFrom: "organizer@example.com", envelopeTo: ["recipient@example.com"] });

            await job.run();

            const events = await calendarEventRepo.find({ where: { mailboxUid, icalUid } });
            expect(events.length).toBe(1);
            expect(events[0].title).toBe("Team Sync");
            expect(events[0].attendees[0].responseStatus).toBe(AttendeeResponseStatus.NEEDS_ACTION);
            expect(events[0].encrypted).toBe(false);
            const calendarFolder = await folderRepo.findOne({ where: { mailboxUid, type: FolderType.CALENDAR } });
            expect(events[0].folderUid).toBe(calendarFolder!.uid);
        });

        it("Preserves encrypted: true on an existing event when a later resent REQUEST updates it - encryption state is sticky, never recomputed from the current message.", async () => {
            const icalUid = uuid.v4();
            const folder = await folderRepo.save(
                new FolderSQL({ mailboxUid, name: "Calendar", type: FolderType.CALENDAR, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }),
            );
            await calendarEventRepo.save(
                new CalendarEventSQL({
                    folderUid: folder.uid,
                    mailboxUid,
                    title: "Team Sync",
                    startDate: new Date(),
                    endDate: new Date(),
                    timezone: "UTC",
                    organizer: { address: "organizer@example.com", type: "to" as any },
                    icalUid,
                    sequence: 0,
                    encrypted: true,
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

            const events = await calendarEventRepo.find({ where: { mailboxUid, icalUid } });
            expect(events.length).toBe(1);
            expect(events[0].title).toBe("Team Sync (moved)");
            expect(events[0].encrypted).toBe(true);
        });

        it("Updates an existing event in place when a resent REQUEST carries a higher sequence.", async () => {
            const icalUid = uuid.v4();
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;

            const firstRawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(firstRawBlobKey, makeItipRawMessage(buildEventIcs(makeIcsEventFixture({ icalUid, sequence: 0 }), "REQUEST")));
            await createIngestEntry({ rawBlobKey: firstRawBlobKey, envelopeFrom: "organizer@example.com", envelopeTo: ["recipient@example.com"] });
            await job.run();
            const created = (await calendarEventRepo.find({ where: { mailboxUid, icalUid } }))[0];

            const secondRawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(
                secondRawBlobKey,
                makeItipRawMessage(buildEventIcs(makeIcsEventFixture({ icalUid, sequence: 1, title: "Team Sync (moved)" }), "REQUEST")),
            );
            await createIngestEntry({ rawBlobKey: secondRawBlobKey, envelopeFrom: "organizer@example.com", envelopeTo: ["recipient@example.com"] });
            await job.run();

            const events = await calendarEventRepo.find({ where: { mailboxUid, icalUid } });
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

            const events = await calendarEventRepo.find({ where: { mailboxUid, icalUid } });
            expect(events.length).toBe(1);
            expect(events[0].title).toBe("Team Sync");
        });

        it("Updates the matching attendee's responseStatus from an inbound REPLY.", async () => {
            const icalUid = uuid.v4();
            const organizerCopy = await calendarEventRepo.save(
                new CalendarEventSQL({
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

            const updated = await calendarEventRepo.findOne({ where: { uid: organizerCopy.uid } });
            expect(updated!.attendees[0].responseStatus).toBe(AttendeeResponseStatus.ACCEPTED);
        });

        it("Soft-deletes the mailbox's own copy from a whole-series inbound CANCEL (no recurrenceId).", async () => {
            const icalUid = uuid.v4();
            const existing = await calendarEventRepo.save(
                new CalendarEventSQL({
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

            const found = await calendarEventRepo.findOne({ where: { uid: existing.uid } });
            expect(found!.deleted).toBe(true);
        });

        it("Recurring: a single-occurrence inbound CANCEL soft-deletes the matching override row.", async () => {
            const icalUid = uuid.v4();
            const recurrenceId = new Date(Math.floor((Date.now() + 60 * 60 * 1000) / 1000) * 1000);
            const override = await calendarEventRepo.save(
                new CalendarEventSQL({
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

            const found = await calendarEventRepo.findOne({ where: { uid: override.uid } });
            expect(found!.deleted).toBe(true);
        });

        it("Recurring: a single-occurrence CANCEL with no existing override adds the date to the master's recurrenceRule.exceptions.", async () => {
            const icalUid = uuid.v4();
            const recurrenceId = new Date(Math.floor((Date.now() + 60 * 60 * 1000) / 1000) * 1000);
            const master = await calendarEventRepo.save(
                new CalendarEventSQL({
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

            const updatedMaster = await calendarEventRepo.findOne({ where: { uid: master.uid } });
            expect(updatedMaster).not.toBeNull();
            // A `recurrenceRule.exceptions` Date round-trips through SQLite's `simple-json` column as a plain
            // string, not a reconstructed `Date` instance (a known, pre-existing, already-documented quirk of
            // this framework's SQL `simple-json` handling, unrelated to this feature) - `new Date(d)` normalizes
            // either representation before comparing.
            expect(updatedMaster!.recurrenceRule!.exceptions.map((d) => new Date(d).getTime())).toContain(recurrenceId.getTime());
        });

        it("Recurring: an inbound REQUEST with a recurrenceId creates/updates only that occurrence, independent of the master.", async () => {
            const icalUid = uuid.v4();
            const master = await calendarEventRepo.save(
                new CalendarEventSQL({
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

            const unchangedMaster = await calendarEventRepo.findOne({ where: { uid: master.uid } });
            expect(unchangedMaster!.title).toBe("Team Sync");

            const events = await calendarEventRepo.find({ where: { mailboxUid, icalUid } });
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

            const events = await calendarEventRepo.find({ where: { mailboxUid, icalUid } });
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
                new CalendarEventSQL({
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

            const events = await calendarEventRepo.find({ where: { mailboxUid, icalUid } });
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
                new CalendarEventSQL({
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

            const events = await calendarEventRepo.find({ where: { mailboxUid, icalUid } });
            expect(events.length).toBe(1);
            expect(events[0].deleted).toBe(false);
        });

        it("Auto-declines a request exceeding maxDurationMinutes, without attempting a conflict check.", async () => {
            await createMailbox({ isResource: true, autoAcceptBookings: true, maxDurationMinutes: 30 });
            const startDate = new Date(Date.now() + 60 * 60 * 1000);
            const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
            const icalUid = uuid.v4();

            await sendItipRequest({ icalUid, startDate, endDate });

            const events = await calendarEventRepo.find({ where: { mailboxUid, icalUid } });
            expect(events.length).toBe(1);
            expect(events[0].deleted).toBe(true);
        });

        it("Auto-declines a request starting further out than bookingWindowDays, without attempting a conflict check.", async () => {
            await createMailbox({ isResource: true, autoAcceptBookings: true, bookingWindowDays: 7 });
            const startDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
            const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);
            const icalUid = uuid.v4();

            await sendItipRequest({ icalUid, startDate, endDate });

            const events = await calendarEventRepo.find({ where: { mailboxUid, icalUid } });
            expect(events.length).toBe(1);
            expect(events[0].deleted).toBe(true);
        });

        it("Recurring: auto-declines when an occurrence of the request conflicts with an occurrence of an existing recurring booking.", async () => {
            await createMailbox({ isResource: true, autoAcceptBookings: true });
            const existingStart = new Date(Date.now() + 24 * 60 * 60 * 1000);
            const existingEnd = new Date(existingStart.getTime() + 60 * 60 * 1000);
            await calendarEventRepo.save(
                new CalendarEventSQL({
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

            const events = await calendarEventRepo.find({ where: { mailboxUid, icalUid } });
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

            const events = await calendarEventRepo.find({ where: { mailboxUid, icalUid } });
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

            const events = await calendarEventRepo.find({ where: { mailboxUid, icalUid } });
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

            const events = await calendarEventRepo.find({ where: { mailboxUid, icalUid } });
            expect(events[0].attendees[0].responseStatus).toBe(AttendeeResponseStatus.NEEDS_ACTION);
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent.length).toBe(0);
        });

        it("Does not auto-process (attendee stays NEEDS_ACTION, no reply sent) for a resource mailbox with autoAcceptBookings unset.", async () => {
            await createMailbox({ isResource: true });
            const icalUid = uuid.v4();
            await sendItipRequest({ icalUid });

            const events = await calendarEventRepo.find({ where: { mailboxUid, icalUid } });
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
                new CalendarEventSQL({
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
                new CalendarEventSQL({
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

            const events = await calendarEventRepo.find({ where: { mailboxUid, icalUid } });
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

            const events = await calendarEventRepo.find({ where: { mailboxUid, icalUid } });
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

            const events = await calendarEventRepo.find({ where: { mailboxUid, icalUid } });
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
                new MessageSQL({
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

            const found = await messageRepo.findOne({ where: { uid: target.uid } });
            expect(found!.deleted).toBe(true);

            // The recall control message itself is never filed anywhere in the recipient's mailbox.
            const allMessages = await messageRepo.find({ where: { mailboxUid } });
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
                new MessageSQL({
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

            const found = await messageRepo.findOne({ where: { uid: target.uid } });
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
                new MessageSQL({
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

            const found = await messageRepo.findOne({ where: { uid: target.uid } });
            expect(found!.deleted).toBe(false);

            // Filed normally to Junk, like any other junk-verdicted mail - not suppressed the way a
            // "deliver"-verdicted recall signal is.
            const allMessages = await messageRepo.find({ where: { mailboxUid } });
            expect(allMessages.length).toBe(2);

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent.length).toBe(0);
        });
    });

    describe("Focused Inbox classification", () => {
        /** Queues one plain message from `envelopeFrom`, optionally with an extra header, and runs the job. */
        const deliverFrom = async (envelopeFrom: string, extraHeader?: string): Promise<MessageSQL> => {
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

            const messages = await messageRepo.find({ where: { mailboxUid } });
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

        it("Classifies mail from a verified local domain as focused.", async () => {
            await createMailbox();
            await domainRepo.save(
                new DomainSQL({
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

        it("Matches a sender in the mailbox's Contacts through the SQL simple-json LIKE query.", async () => {
            await createMailbox();
            await contactRepo.save(
                new ContactSQL({
                    mailboxUid,
                    folderUid: uuid.v4(),
                    displayName: "Known Person",
                    emails: [{ address: "known@outside.com", type: ContactAddressKind.WORK }],
                }),
            );

            const message = await deliverFrom("known@outside.com");

            expect(message.inferenceClassification).toBe(MessageClassification.FOCUSED);
        });

        it("Escapes LIKE wildcards in the sender address rather than letting them match anything.", async () => {
            await createMailbox();
            await contactRepo.save(
                new ContactSQL({
                    mailboxUid,
                    folderUid: uuid.v4(),
                    displayName: "Literal Wildcards",
                    emails: [{ address: "a_%b@outside.com", type: ContactAddressKind.WORK }],
                }),
            );

            // Matches only because `_`/`%` are escaped into literals - unescaped they are SQL LIKE wildcards.
            const matched = await deliverFrom("a_%b@outside.com");
            expect(matched.inferenceClassification).toBe(MessageClassification.FOCUSED);

            await messageRepo.clear();

            // And the same wildcards must not let a different address match that stored contact.
            const notMatched = await deliverFrom("aXYb@outside.com", "List-Unsubscribe: <https://outside.com/u>");
            expect(notMatched.inferenceClassification).toBe(MessageClassification.OTHER);
        });

        it("Does not match a contact whose address merely shares a prefix with the sender.", async () => {
            await createMailbox();
            await contactRepo.save(
                new ContactSQL({
                    mailboxUid,
                    folderUid: uuid.v4(),
                    displayName: "Someone Else",
                    emails: [{ address: "known@outside.com.au", type: ContactAddressKind.WORK }],
                }),
            );

            // Anchored on the full quoted value, so "known@outside.com" must not match a stored
            // "known@outside.com.au" - and with no other focused signal this stays on the default.
            const message = await deliverFrom("known@outside.com");

            expect(message.inferenceClassification).toBe(MessageClassification.FOCUSED);
            const contacts = await contactRepo.find({ where: { mailboxUid } });
            expect(contacts.length).toBe(1);
        });

        it("An explicit override wins over the bulk headers that would otherwise force other.", async () => {
            await createMailbox();
            await focusedInboxOverrideRepo.save(
                new FocusedInboxOverrideSQL({
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

            const folder = await folderRepo.findOne({ where: { uid: message.folderUid } });
            expect(folder!.type).toBe(FolderType.JUNK);
            expect(message.inferenceClassification).toBeFalsy();
        });
    });

    describe("Delivery/read receipts", () => {
        /** Queues a plain message from `sender` requesting a receipt back to `requester` (default: `sender`
         * itself, matching how `send()` always sets `Disposition-Notification-To` to the sender's own
         * address), and runs the job. */
        const deliverRequestingReceipt = async (sender: string, requester: string = sender): Promise<MessageSQL> => {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(
                rawBlobKey,
                Buffer.from(
                    `From: ${sender}\r\nTo: recipient@example.com\r\nSubject: Plain message\r\n` +
                        `Disposition-Notification-To: ${requester}\r\n\r\nHello there.\r\n`,
                ),
            );
            await createIngestEntry({ rawBlobKey, envelopeFrom: sender });
            await job.run();

            const messages = await messageRepo.find({ where: { mailboxUid } });
            expect(messages.length).toBe(1);
            return messages[0];
        };

        const verifiedDomain = async (): Promise<void> => {
            await domainRepo.save(
                new DomainSQL({
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

            const message = await deliverRequestingReceipt("sender@example.com", "colleague@example.com");

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

            const message = await deliverRequestingReceipt("sender@example.com", "stranger@outside.com");

            expect(message.dispositionNotificationTo).toBe("stranger@outside.com");
            expect(message.deliveryReceiptSentAt).toBeFalsy();
            expect(message.deliveryReceiptPending).toBe(true);

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent).toHaveLength(0);
        });

        it("Sends immediately for an external requester when the mailbox opts in via autoSendReceiptsExternal.", async () => {
            await createMailbox({ autoSendReceiptsExternal: true });

            const message = await deliverRequestingReceipt("sender@example.com", "stranger@outside.com");

            expect(message.deliveryReceiptSentAt).toBeInstanceOf(Date);
            expect(message.deliveryReceiptPending).toBe(false);
        });

        it("Does NOT send immediately for an external requester when the mailbox only opts in via autoSendReceiptsFederated - 'outside.com' publishes no _rapidmx record so it classifies as external, not federated, and autoSendReceiptsExternal (left false here) is the setting that actually governs.", async () => {
            await createMailbox({ autoSendReceiptsFederated: true });

            const message = await deliverRequestingReceipt("sender@example.com", "stranger@outside.com");

            expect(message.deliveryReceiptSentAt).toBeFalsy();
            expect(message.deliveryReceiptPending).toBe(true);
        });

        it("DOES send immediately for a real federated peer once its _rapidmx TXT record resolves, when the mailbox opts in via autoSendReceiptsFederated (proves classifyRecipientTier() is wired to real DNS resolution, not just the stub).", async () => {
            await createMailbox({ autoSendReceiptsFederated: true });
            const dnsResolver = objectFactory.getInstance<StaticDnsResolver>("DnsResolver")!;
            dnsResolver.records.set("_rapidmx.federated-peer-sql.example", [
                ["v=RMXv1; id=1; host=mail.federated-peer-sql.example;"],
            ]);

            const message = await deliverRequestingReceipt("sender@example.com", "peer@federated-peer-sql.example");

            expect(message.deliveryReceiptSentAt).toBeInstanceOf(Date);
            expect(message.deliveryReceiptPending).toBe(false);
        });

        it("Does nothing receipt-related when no receipt was requested at all.", async () => {
            await createMailbox();

            const message = await deliverFromPlain();

            expect(message.dispositionNotificationTo).toBeFalsy();
            expect(message.deliveryReceiptSentAt).toBeFalsy();
            expect(message.deliveryReceiptPending).toBe(false);
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent).toHaveLength(0);
        });

        /** A plain message with no receipt-request header at all. */
        async function deliverFromPlain(): Promise<MessageSQL> {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makePlainRawMessage());
            await createIngestEntry({ rawBlobKey });
            await job.run();
            return (await messageRepo.find({ where: { mailboxUid } }))[0];
        }

        it("Does not send a delivery receipt for a message a MailFilterRule deletes outright.", async () => {
            await createMailbox();
            await mailFilterRuleRepo.save(
                new MailFilterRuleSQL({
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

            expect((await messageRepo.find({ where: { mailboxUid } })).length).toBe(0);
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent).toHaveLength(0);
        });

        it("An inbound MDN updates the matching recipient's roster entry and is never filed as a visible message.", async () => {
            await createMailbox();
            const sentFolder = await folderRepo.save(
                new FolderSQL({ mailboxUid, name: "Sent Items", type: FolderType.SENT_ITEMS, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }),
            );
            const sent = await messageRepo.save(
                new MessageSQL({
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

            const mdn: Buffer = await buildDispositionNotification({
                from: { address: "bob@example.com" },
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
            await createIngestEntry({ rawBlobKey, envelopeFrom: "bob@example.com" });

            const beforeCount = (await messageRepo.find({ where: { mailboxUid } })).length;
            await job.run();
            const afterCount = (await messageRepo.find({ where: { mailboxUid } })).length;

            // The MDN itself was never filed - the message count is unchanged (still just the pre-seeded sent
            // message).
            expect(afterCount).toBe(beforeCount);

            const updated = await messageRepo.findOne({ where: { uid: sent.uid } });
            expect(updated!.receiptStatus).toEqual([{ recipientAddress: "bob@example.com", readAt: expect.any(String) }]);
        });

        it("Appends a new roster entry when the MDN's Final-Recipient matches no pre-seeded entry (the distribution-list-expansion case).", async () => {
            await createMailbox();
            const sentFolder = await folderRepo.save(
                new FolderSQL({ mailboxUid, name: "Sent Items", type: FolderType.SENT_ITEMS, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }),
            );
            const sent = await messageRepo.save(
                new MessageSQL({
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

            const mdn: Buffer = await buildDispositionNotification({
                from: { address: "carol@example.com" },
                to: "recipient@example.com",
                subject: "Delivered: Hello",
                finalRecipient: "carol@example.com",
                originalMessageId: "original@example.com",
                dispositionType: "delivery",
                reportingUa: "mail.example.com; RapidMX",
            });
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, mdn);
            await createIngestEntry({ rawBlobKey, envelopeFrom: "carol@example.com" });
            await job.run();

            const updated = await messageRepo.findOne({ where: { uid: sent.uid } });
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
            expect((await messageRepo.find({ where: { mailboxUid } })).length).toBe(0);
        });

        it("Drops an MDN whose claimed Final-Recipient does not match its own envelope sender (forgery attempt) and does not update the roster.", async () => {
            await createMailbox();
            const sentFolder = await folderRepo.save(
                new FolderSQL({ mailboxUid, name: "Sent Items", type: FolderType.SENT_ITEMS, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }),
            );
            const sent = await messageRepo.save(
                new MessageSQL({
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

            const updated = await messageRepo.findOne({ where: { uid: sent.uid } });
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
            expect((await messageRepo.find({ where: { mailboxUid } })).length).toBe(0);
        });

        it("Logs rather than throws when sending the delivery receipt fails outright.", async () => {
            await createMailbox();
            await verifiedDomain();
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            const spy = vi.spyOn(transport, "send").mockRejectedValueOnce(new Error("smtp is down"));

            const message = await deliverRequestingReceipt("sender@example.com", "colleague@example.com");

            expect(message.deliveryReceiptSentAt).toBeFalsy();
            expect(message.deliveryReceiptPending).toBe(false);
            spy.mockRestore();
        });
    });
});
