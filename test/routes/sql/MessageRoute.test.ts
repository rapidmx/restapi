///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { request } from "@rapidrest/service-core/test";
import {
    Server,
    ObjectFactory,
    ConnectionManager,
    AccessControlListSQL,
    isSqlDataSource,
} from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import { AuditLogEntrySQL } from "../../../src/models/sql/AuditLogEntrySQL.js";
import { DomainSQL } from "../../../src/models/sql/DomainSQL.js";
import { FocusedInboxOverrideSQL } from "../../../src/models/sql/FocusedInboxOverrideSQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { FolderSQL } from "../../../src/models/sql/FolderSQL.js";
import { MatterSQL } from "../../../src/models/sql/MatterSQL.js";
import { MessageSQL } from "../../../src/models/sql/MessageSQL.js";
import {
    AuditAction,
    FolderType,
    MessageClassification,
    MessageImportance,
    PublicKey,
    RecipientType,
} from "../../../src/models/types.js";
import { registerTestDoubles, InMemoryBlobStore, RecordingMailTransport, StaticDnsResolver } from "../../testDoubles.js";

describe("Route:MessageSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/messages";
    let mailboxRepo: Repository<MailboxSQL>;
    let folderRepo: Repository<FolderSQL>;
    let messageRepo: Repository<MessageSQL>;
    let aclRepo: Repository<AccessControlListSQL>;
    let auditLogRepo: Repository<AuditLogEntrySQL>;
    let overrideRepo: Repository<FocusedInboxOverrideSQL>;
    let domainRepo: Repository<DomainSQL>;
    let matterRepo: Repository<MatterSQL>;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);
    const otherUser: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const otherUserToken = JWTUtils.createTokenSync(config.get("auth"), otherUser);
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

    const createMailbox = async function (ownerUid: string): Promise<MailboxSQL> {
        const obj: MailboxSQL = new MailboxSQL({
            ownerUserUid: ownerUid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Test Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });
        const result: MailboxSQL = await mailboxRepo.save(obj);
        await aclRepo.save({
            uid: result.uid,
            dateCreated: new Date(),
            dateModified: new Date(),
            version: 0,
            records: [{ userOrRoleId: ownerUid, actions: ["*"] }],
            parentUid: "Mailbox",
        });
        return result;
    };

    const createFolder = async function (mailboxUid: string, type: FolderType = FolderType.DRAFTS): Promise<FolderSQL> {
        const obj: FolderSQL = new FolderSQL({
            mailboxUid,
            name: type,
            type,
            unreadCount: 0,
            totalCount: 0,
            syncKeyVersion: 0,
        });
        const result: FolderSQL = await folderRepo.save(obj);
        await aclRepo.save({
            uid: result.uid,
            dateCreated: new Date(),
            dateModified: new Date(),
            version: 0,
            records: [],
            parentUid: mailboxUid,
        });
        return result;
    };

    const createMessage = async function (mailboxUid: string, folderUid: string, data?: any): Promise<MessageSQL> {
        const obj: MessageSQL = new MessageSQL({
            mailboxUid,
            folderUid,
            messageId: `${uuid.v4()}@example.com`,
            subject: "Test Subject",
            from: { address: "owner@example.com", type: RecipientType.TO },
            recipients: [{ address: "recipient@example.com", type: RecipientType.TO }],
            sentDate: new Date(),
            receivedDate: new Date(),
            bodyBlobKey: `bodies/${uuid.v4()}`,
            bodyPreview: "Hello",
            flags: { read: false, flagged: false, answered: false, forwarded: false },
            importance: MessageImportance.NORMAL,
            references: [],
            hasAttachments: false,
            ...data,
        });
        return await messageRepo.save(obj);
    };

    const createMatter = async function (data?: any): Promise<MatterSQL> {
        const obj: MatterSQL = new MatterSQL({
            name: "Test Matter",
            escrowScopeId: uuid.v4(),
            custodianMailboxUids: [],
            dateRangeStart: new Date("2020-01-01"),
            dateRangeEnd: new Date("2030-01-01"),
            ...data,
        });
        return await matterRepo.save(obj);
    };

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        let conn: any = connMgr?.connections.get("acl");
        if (isSqlDataSource(conn)) {
            aclRepo = conn.getRepository(AccessControlListSQL);
        } else {
            throw new Error("Could not find sql acl connection");
        }
        conn = connMgr?.connections.get("sql");
        if (isSqlDataSource(conn)) {
            mailboxRepo = conn.getRepository(MailboxSQL);
            folderRepo = conn.getRepository(FolderSQL);
            messageRepo = conn.getRepository(MessageSQL);
            auditLogRepo = conn.getRepository(AuditLogEntrySQL);
            overrideRepo = conn.getRepository(FocusedInboxOverrideSQL);
            domainRepo = conn.getRepository(DomainSQL);
            matterRepo = conn.getRepository(MatterSQL);
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await messageRepo.clear();
        await folderRepo.clear();
        await mailboxRepo.clear();
        await auditLogRepo.clear();
        await overrideRepo.clear();
        await domainRepo.clear();
        await matterRepo.clear();
        // The recording transport accumulates across tests otherwise, since it's a singleton for the life of
        // this file's one `server` instance.
        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport");
        if (transport) {
            transport.sent = [];
        }
    });

    it("Owner can create (save as draft) a message in a folder they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send({
                mailboxUid: mailbox.uid,
                folderUid: folder.uid,
                messageId: `${uuid.v4()}@example.com`,
                subject: "Draft",
                from: { address: "owner@example.com", type: "to" },
                recipients: [],
                sentDate: new Date().toISOString(),
                receivedDate: new Date().toISOString(),
                bodyBlobKey: `bodies/${uuid.v4()}`,
                bodyPreview: "Draft preview",
                flags: { read: false, flagged: false, answered: false, forwarded: false },
                importance: "normal",
                references: [],
                hasAttachments: false,
            });

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.subject).toBe("Draft");
    });

    it("A different user cannot create a message in a folder they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + otherUserToken)
            .send({
                mailboxUid: mailbox.uid,
                folderUid: folder.uid,
                messageId: `${uuid.v4()}@example.com`,
                subject: "Intrusion",
                from: { address: "attacker@example.com", type: "to" },
                recipients: [],
                sentDate: new Date().toISOString(),
                receivedDate: new Date().toISOString(),
                bodyBlobKey: `bodies/${uuid.v4()}`,
                bodyPreview: "Intrusion preview",
                flags: { read: false, flagged: false, answered: false, forwarded: false },
                importance: "normal",
                references: [],
                hasAttachments: false,
            });

        expect(result.status).toBe(403);
    });

    it("Sending a clean draft relays it via MailTransport and moves it to Sent Items.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);
        const blobStore: InMemoryBlobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const bodyBlobKey = `bodies/${uuid.v4()}`;
        await blobStore.put(
            bodyBlobKey,
            Buffer.from(
                "From: owner@example.com\r\nTo: recipient@example.com\r\nSubject: Hi\r\n\r\nHello there.\r\n",
            ),
        );
        const message = await createMessage(mailbox.uid, draftsFolder.uid, { bodyBlobKey });

        const result = await request(server.getApplication())
            .post(`${baseUrl}/${message.uid}/send`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.flags.read).toBe(true);

        // Moved into a lazily-created Sent Items folder for the mailbox.
        const sentFolder = await folderRepo.findOne({ where: { mailboxUid: mailbox.uid, type: FolderType.SENT_ITEMS } });
        expect(sentFolder).toBeDefined();
        expect(result.body.folderUid).toBe(sentFolder!.uid);

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(1);
        expect(transport.sent[0].envelopeFrom).toBe("owner@example.com");
        expect(transport.sent[0].envelopeTo).toEqual(["recipient@example.com"]);
        expect(result.body.encrypted).toBe(false);
    });

    it("Sending an already S/MIME-encrypted draft persists encrypted: true on the sent message.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);
        const blobStore: InMemoryBlobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const bodyBlobKey = `bodies/${uuid.v4()}`;
        await blobStore.put(
            bodyBlobKey,
            Buffer.from(
                "From: owner@example.com\r\nTo: recipient@example.com\r\nSubject: Encrypted\r\n" +
                    'Content-Type: application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"\r\n' +
                    "Content-Transfer-Encoding: base64\r\n\r\n" +
                    Buffer.from("fake CMS EnvelopedData DER bytes").toString("base64"),
            ),
        );
        const message = await createMessage(mailbox.uid, draftsFolder.uid, { bodyBlobKey });

        const result = await request(server.getApplication())
            .post(`${baseUrl}/${message.uid}/send`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.encrypted).toBe(true);
    });

    it("Sending a draft with a future scheduledSendTime defers relay, moving it to Outbox instead of Sent Items.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);
        const blobStore: InMemoryBlobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const bodyBlobKey = `bodies/${uuid.v4()}`;
        await blobStore.put(
            bodyBlobKey,
            Buffer.from("From: owner@example.com\r\nTo: recipient@example.com\r\nSubject: Hi\r\n\r\nHello there.\r\n"),
        );
        const futureSendTime = new Date(Date.now() + 60 * 60 * 1000);
        const message = await createMessage(mailbox.uid, draftsFolder.uid, { bodyBlobKey, scheduledSendTime: futureSendTime });

        const result = await request(server.getApplication())
            .post(`${baseUrl}/${message.uid}/send`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);

        const outbox = await folderRepo.findOne({ where: { mailboxUid: mailbox.uid, type: FolderType.OUTBOX } });
        expect(outbox).toBeDefined();
        expect(result.body.folderUid).toBe(outbox!.uid);

        const sentFolder = await folderRepo.findOne({ where: { mailboxUid: mailbox.uid, type: FolderType.SENT_ITEMS } });
        expect(sentFolder).toBeNull();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(0);
    });

    it("Sending a draft whose scheduledSendTime has already elapsed sends immediately, same as no scheduledSendTime at all.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);
        const blobStore: InMemoryBlobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const bodyBlobKey = `bodies/${uuid.v4()}`;
        await blobStore.put(
            bodyBlobKey,
            Buffer.from("From: owner@example.com\r\nTo: recipient@example.com\r\nSubject: Hi\r\n\r\nHello there.\r\n"),
        );
        const pastSendTime = new Date(Date.now() - 60 * 60 * 1000);
        const message = await createMessage(mailbox.uid, draftsFolder.uid, { bodyBlobKey, scheduledSendTime: pastSendTime });

        const result = await request(server.getApplication())
            .post(`${baseUrl}/${message.uid}/send`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);

        const sentFolder = await folderRepo.findOne({ where: { mailboxUid: mailbox.uid, type: FolderType.SENT_ITEMS } });
        expect(result.body.folderUid).toBe(sentFolder!.uid);

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(1);
    });

    it("Sending a draft with no Message-ID header generates one and persists it on the record and the stored blob.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);
        const blobStore: InMemoryBlobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const bodyBlobKey = `bodies/${uuid.v4()}`;
        await blobStore.put(
            bodyBlobKey,
            Buffer.from("From: owner@example.com\r\nTo: recipient@example.com\r\nSubject: Hi\r\n\r\nHello there.\r\n"),
        );
        const message = await createMessage(mailbox.uid, draftsFolder.uid, { bodyBlobKey, messageId: "" });

        const result = await request(server.getApplication())
            .post(`${baseUrl}/${message.uid}/send`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.messageId).toBeTruthy();

        const storedRaw: Buffer = await blobStore.get(bodyBlobKey);
        expect(storedRaw.toString()).toContain(`Message-ID: <${result.body.messageId}>`);

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent[0].raw.toString()).toContain(`Message-ID: <${result.body.messageId}>`);
    });

    it("Sending a draft whose raw MIME already has a Message-ID header persists that exact value, unchanged.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);
        const blobStore: InMemoryBlobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const bodyBlobKey = `bodies/${uuid.v4()}`;
        const raw =
            "From: owner@example.com\r\nTo: recipient@example.com\r\nSubject: Hi\r\nMessage-ID: <original-id@example.com>\r\n\r\nHello there.\r\n";
        await blobStore.put(bodyBlobKey, Buffer.from(raw));
        const message = await createMessage(mailbox.uid, draftsFolder.uid, { bodyBlobKey });

        const result = await request(server.getApplication())
            .post(`${baseUrl}/${message.uid}/send`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.messageId).toBe("original-id@example.com");

        const storedRaw: Buffer = await blobStore.get(bodyBlobKey);
        expect(storedRaw.toString()).toBe(raw);
    });

    it("A different user cannot send a message they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);
        const blobStore: InMemoryBlobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const bodyBlobKey = `bodies/${uuid.v4()}`;
        await blobStore.put(bodyBlobKey, Buffer.from("From: a@example.com\r\nTo: b@example.com\r\n\r\nHi\r\n"));
        const message = await createMessage(mailbox.uid, draftsFolder.uid, { bodyBlobKey });

        const result = await request(server.getApplication())
            .post(`${baseUrl}/${message.uid}/send`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(403);

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(0);
    });

    it("Sending a nonexistent message returns 404.", async () => {
        const result = await request(server.getApplication())
            .post(`${baseUrl}/${uuid.v4()}/send`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(404);
    });

    describe("recall()", () => {
        it("Recalling a sent message sends an X-RapidMX-Recall-Of control message to every recipient and stamps recallRequestedAt.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const sentFolder = await createFolder(mailbox.uid, FolderType.SENT_ITEMS);
            const message = await createMessage(mailbox.uid, sentFolder.uid, {
                messageId: "abc123@example.com",
                from: { address: "owner@example.com", type: RecipientType.TO },
                recipients: [
                    { address: "recipient1@example.com", type: RecipientType.TO },
                    { address: "recipient2@example.com", type: RecipientType.CC },
                ],
            });

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/recall`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            expect(result.body.recallRequestedAt).toBeTruthy();

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent.length).toBe(1);
            expect(transport.sent[0].envelopeFrom).toBe("owner@example.com");
            expect(transport.sent[0].envelopeTo).toEqual(["recipient1@example.com", "recipient2@example.com"]);
            // `nodemailer`'s `MailComposer` re-capitalizes a custom header name (e.g. `X-Rapidmx-Recall-Of`) -
            // header names are case-insensitive per RFC 5322, and `ScanPipeline`'s own lookup normalizes to
            // lowercase the same way, so this compares case-insensitively rather than assuming exact casing.
            expect(transport.sent[0].raw.toString().toLowerCase()).toContain("x-rapidmx-recall-of: abc123@example.com");
        });

        it("Rejects recalling a message that isn't in Sent Items (400).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const inbox = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, inbox.uid);

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/recall`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(400);
        });

        it("Rejects recalling a message with no Message-ID (400).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const sentFolder = await createFolder(mailbox.uid, FolderType.SENT_ITEMS);
            const message = await createMessage(mailbox.uid, sentFolder.uid, { messageId: "" });

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/recall`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(400);
        });

        it("A different user cannot recall a message they don't have access to (403).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const sentFolder = await createFolder(mailbox.uid, FolderType.SENT_ITEMS);
            const message = await createMessage(mailbox.uid, sentFolder.uid);

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/recall`)
                .set("Authorization", "jwt " + otherUserToken);

            expect(result.status).toBe(403);
        });

        it("Recalling a nonexistent message returns 404.", async () => {
            const result = await request(server.getApplication())
                .post(`${baseUrl}/${uuid.v4()}/recall`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(404);
        });

        it("Writes an AuditLogEntry when a message is recalled.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const sentFolder = await createFolder(mailbox.uid, FolderType.SENT_ITEMS);
            const message = await createMessage(mailbox.uid, sentFolder.uid, {
                messageId: "recall-audit@example.com",
                subject: "Recall Me",
            });

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/recall`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);

            const entries = await auditLogRepo.find({ where: { targetUid: message.uid } });
            expect(entries.length).toBe(1);
            expect(entries[0].action).toBe(AuditAction.MESSAGE_RECALL);
            expect(entries[0].targetType).toBe("Message");
            expect(entries[0].mailboxUid).toBe(mailbox.uid);
            expect(entries[0].actorUserUid).toBe(owner.uid);
        });
    });

    describe("archive()", () => {
        it("Archiving a message lazily creates the mailbox's Archive folder and moves the message into it.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const inbox = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, inbox.uid);

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/archive`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);

            const archiveFolder = await folderRepo.findOne({ where: { mailboxUid: mailbox.uid, type: FolderType.ARCHIVE } });
            expect(archiveFolder).not.toBeNull();
            expect(result.body.folderUid).toBe(archiveFolder!.uid);
        });

        it("Reuses the mailbox's existing Archive folder rather than creating a second one.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const inbox = await createFolder(mailbox.uid, FolderType.INBOX);
            const archiveFolder = await createFolder(mailbox.uid, FolderType.ARCHIVE);
            const message = await createMessage(mailbox.uid, inbox.uid);

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/archive`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            expect(result.body.folderUid).toBe(archiveFolder.uid);

            const archiveFolders = await folderRepo.find({ where: { mailboxUid: mailbox.uid, type: FolderType.ARCHIVE } });
            expect(archiveFolders.length).toBe(1);
        });

        it("Archiving a message already in Archive succeeds as a no-op.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const archiveFolder = await createFolder(mailbox.uid, FolderType.ARCHIVE);
            const message = await createMessage(mailbox.uid, archiveFolder.uid);

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/archive`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            expect(result.body.folderUid).toBe(archiveFolder.uid);
        });

        it("Rejects archiving a message currently in Drafts (400).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);
            const message = await createMessage(mailbox.uid, draftsFolder.uid);

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/archive`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(400);
        });

        it("Rejects archiving a message currently in Outbox (400).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const outbox = await createFolder(mailbox.uid, FolderType.OUTBOX);
            const message = await createMessage(mailbox.uid, outbox.uid);

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/archive`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(400);
        });

        it("A different user cannot archive a message they don't have access to (403).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const inbox = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, inbox.uid);

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/archive`)
                .set("Authorization", "jwt " + otherUserToken);

            expect(result.status).toBe(403);
        });

        it("Archiving a nonexistent message returns 404.", async () => {
            const result = await request(server.getApplication())
                .post(`${baseUrl}/${uuid.v4()}/archive`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(404);
        });
    });

    describe("conversations()", () => {
        it("Groups a reply (sent via send()) with its parent message, across Inbox and Sent Items.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const inbox = await createFolder(mailbox.uid, FolderType.INBOX);
            const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);

            const rootMessage = await createMessage(mailbox.uid, inbox.uid, {
                messageId: "root@example.com",
                conversationId: "root@example.com",
                subject: "Original subject",
            });

            const blobStore: InMemoryBlobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
            const bodyBlobKey = `bodies/${uuid.v4()}`;
            await blobStore.put(
                bodyBlobKey,
                Buffer.from(
                    "From: owner@example.com\r\nTo: recipient@example.com\r\nSubject: Re: Original subject\r\n" +
                        "In-Reply-To: <root@example.com>\r\nReferences: <root@example.com>\r\n\r\nReply body.\r\n",
                ),
            );
            const draftReply = await createMessage(mailbox.uid, draftsFolder.uid, { bodyBlobKey, subject: "Re: Original subject" });

            const sendResult = await request(server.getApplication())
                .post(`${baseUrl}/${draftReply.uid}/send`)
                .set("Authorization", "jwt " + ownerToken);
            expect(sendResult.status).toBeGreaterThanOrEqual(200);
            expect(sendResult.status).toBeLessThan(300);
            expect(sendResult.body.conversationId).toBe("root@example.com");

            const sentFolder = await folderRepo.findOne({ where: { mailboxUid: mailbox.uid, type: FolderType.SENT_ITEMS } });

            const result = await request(server.getApplication())
                .get(`${baseUrl}/conversations?mailboxUid=${mailbox.uid}`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(200);
            expect(result.body.length).toBe(1);
            const conversation = result.body[0];
            expect(conversation.conversationId).toBe("root@example.com");
            expect(conversation.messageCount).toBe(2);
            expect([...conversation.messageUids].sort()).toEqual([rootMessage.uid, sendResult.body.uid].sort());
            expect([...conversation.folderUids].sort()).toEqual([inbox.uid, sentFolder!.uid].sort());
            // The root message is still unread (default); the sent copy is always marked read by send().
            expect(conversation.unreadCount).toBe(1);
            // The most recently active message's subject (the reply, sent after the root was created).
            expect(conversation.subject).toBe("Re: Original subject");
            expect(conversation.hasAttachments).toBe(false);
        });

        it("A message with no conversationId is its own singleton conversation.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid);

            const result = await request(server.getApplication())
                .get(`${baseUrl}/conversations?mailboxUid=${mailbox.uid}`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(200);
            expect(result.body.length).toBe(1);
            expect(result.body[0].messageCount).toBe(1);
            expect(result.body[0].messageUids).toEqual([message.uid]);
        });

        it("Sorts conversations by most recent activity first.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const older = await createMessage(mailbox.uid, folder.uid, { receivedDate: new Date(Date.now() - 60 * 60 * 1000) });
            const newer = await createMessage(mailbox.uid, folder.uid, { receivedDate: new Date() });

            const result = await request(server.getApplication())
                .get(`${baseUrl}/conversations?mailboxUid=${mailbox.uid}`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(200);
            expect(result.body.map((c: any) => c.messageUids[0])).toEqual([newer.uid, older.uid]);
        });

        it("Rejects a conversations() request with no mailboxUid (400).", async () => {
            const result = await request(server.getApplication())
                .get(`${baseUrl}/conversations`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(400);
        });

        it("Returns an empty array for a caller with no LIST permission on the mailbox.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            await createMessage(mailbox.uid, folder.uid);

            const result = await request(server.getApplication())
                .get(`${baseUrl}/conversations?mailboxUid=${mailbox.uid}`)
                .set("Authorization", "jwt " + otherUserToken);

            expect(result.status).toBe(200);
            expect(result.body).toEqual([]);
        });
    });

    it("Owner can fetch a message's sanitized HTML content once it has one.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid, FolderType.INBOX);
        const blobStore: InMemoryBlobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const sanitizedHtmlBlobKey = `bodies/${uuid.v4()}.html`;
        await blobStore.put(sanitizedHtmlBlobKey, Buffer.from("<p>Hello</p>"));
        const message = await createMessage(mailbox.uid, folder.uid, { sanitizedHtmlBlobKey });

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${message.uid}/content`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.headers["content-type"]).toContain("text/html");
        expect(result.text).toBe("<p>Hello</p>");
    });

    it("Falls back to the plain-text preview for a message with no sanitized HTML body.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid, FolderType.INBOX);
        const message = await createMessage(mailbox.uid, folder.uid, { bodyPreview: "Just plain text" });

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${message.uid}/content`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.headers["content-type"]).toContain("text/plain");
        expect(result.text).toBe("Just plain text");
    });

    it("A different user cannot fetch content for a message they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid, FolderType.INBOX);
        const message = await createMessage(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${message.uid}/content`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(404);
    });

    it("Fetching content for a nonexistent message returns 404.", async () => {
        const result = await request(server.getApplication())
            .get(`${baseUrl}/${uuid.v4()}/content`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(404);
    });

    it("Does not audit an owner reading their own message content.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid, FolderType.INBOX);
        const message = await createMessage(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${message.uid}/content`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        const entries = await auditLogRepo.find({ where: { targetUid: message.uid } });
        expect(entries.some((e) => e.action === AuditAction.MESSAGE_CONTENT_ACCESSED)).toBe(false);
    });

    it("Audits a trusted admin reading a message's content in another user's mailbox.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid, FolderType.INBOX);
        const message = await createMessage(mailbox.uid, folder.uid, { subject: "Confidential" });

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${message.uid}/content`)
            .set("Authorization", "jwt " + adminToken);

        expect(result.status).toBe(200);
        const entries = await auditLogRepo.find({ where: { targetUid: message.uid } });
        expect(entries.length).toBe(1);
        expect(entries[0].action).toBe(AuditAction.MESSAGE_CONTENT_ACCESSED);
        expect(entries[0].mailboxUid).toBe(mailbox.uid);
        expect(entries[0].actorUserUid).toBe(admin.uid);
    });

    it("Audits content access defensively when the message's mailbox record can't be resolved (e.g. deleted with no cascade), rather than silently skipping the audit.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid, FolderType.INBOX);
        const message = await createMessage(mailbox.uid, folder.uid, { subject: "Orphaned" });
        // The folder's own ACL (which still grants the owner READ) is independent of the Mailbox row - see
        // the architecture note on Message.mailboxUid. Deleting just the row simulates a dangling
        // mailboxUid without touching the ACL that still makes the message itself reachable.
        await mailboxRepo.delete({ uid: mailbox.uid });

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${message.uid}/content`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        const entries = await auditLogRepo.find({ where: { targetUid: message.uid } });
        expect(entries.length).toBe(1);
        expect(entries[0].action).toBe(AuditAction.MESSAGE_CONTENT_ACCESSED);
    });

    it("Owner can list messages in a folder they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid, FolderType.INBOX);
        await createMessage(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.length).toBe(1);
    });

    it("A different user's list of messages in a folder they don't own is empty.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid, FolderType.INBOX);
        await createMessage(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(200);
        expect(result.body).toEqual([]);
    });

    it("Writes an AuditLogEntry when a message is deleted.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid, FolderType.INBOX);
        const message = await createMessage(mailbox.uid, folder.uid, { subject: "Delete Me" });

        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${message.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);

        const entries = await auditLogRepo.find({ where: { targetUid: message.uid } });
        expect(entries.length).toBe(1);
        expect(entries[0].action).toBe(AuditAction.MESSAGE_DELETE);
        expect(entries[0].targetType).toBe("Message");
        expect(entries[0].mailboxUid).toBe(mailbox.uid);
        expect(entries[0].actorUserUid).toBe(owner.uid);
    });

    describe("legal hold", () => {
        it("Blocks a permanent (purge) delete of a message under an open Matter's hold, auditing the block.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid, { sentDate: new Date("2025-06-01") });
            await createMatter({ custodianMailboxUids: [mailbox.uid] });

            const result = await request(server.getApplication())
                .delete(`${baseUrl}/${message.uid}?purge=true`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(409);
            const stillExists = await messageRepo.findOne({ where: { uid: message.uid } });
            expect(stillExists).toBeTruthy();

            const entries = await auditLogRepo.find({ where: { targetUid: message.uid } });
            expect(entries.some((e) => e.action === AuditAction.LEGAL_HOLD_BLOCKED_DELETE)).toBe(true);
        });

        it("Allows an ordinary (non-purge) delete of a message under an open hold - only permanent destruction is blocked.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid, { sentDate: new Date("2025-06-01") });
            await createMatter({ custodianMailboxUids: [mailbox.uid] });

            const result = await request(server.getApplication())
                .delete(`${baseUrl}/${message.uid}`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            // The row is still present (a raw TypeORM query sees it regardless of the `deleted` flag),
            // but is now marked soft-deleted rather than gone - the hold blocks permanent loss, not this.
            const stillPresent = await messageRepo.findOne({ where: { uid: message.uid } });
            expect(stillPresent).toBeTruthy();
            expect(stillPresent!.deleted).toBe(true);
        });

        it("Allows a purge outside the hold's date range.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid, { sentDate: new Date("2010-01-01") });
            await createMatter({ custodianMailboxUids: [mailbox.uid], dateRangeStart: new Date("2020-01-01"), dateRangeEnd: new Date("2030-01-01") });

            const result = await request(server.getApplication())
                .delete(`${baseUrl}/${message.uid}?purge=true`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            const stillExists = await messageRepo.findOne({ where: { uid: message.uid } });
            expect(stillExists).toBeFalsy();
        });

        it("Allows a purge once the matter is closed.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid, { sentDate: new Date("2025-06-01") });
            await createMatter({ custodianMailboxUids: [mailbox.uid], closedAt: new Date() });

            const result = await request(server.getApplication())
                .delete(`${baseUrl}/${message.uid}?purge=true`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
        });

        it("Blocks a bulk truncate() of messages in a folder under an open Matter's hold - a caller cannot route around the singular purge-delete guard by using the bulk endpoint instead.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid, { sentDate: new Date("2025-06-01") });
            await createMatter({ custodianMailboxUids: [mailbox.uid] });

            const result = await request(server.getApplication())
                .delete(`${baseUrl}?folderUid=${folder.uid}`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(409);
            const stillExists = await messageRepo.findOne({ where: { uid: message.uid } });
            expect(stillExists).toBeTruthy();
        });

        it("Allows a bulk truncate() of messages in a folder once the matter is closed.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid, { sentDate: new Date("2025-06-01") });
            await createMatter({ custodianMailboxUids: [mailbox.uid], closedAt: new Date() });

            const result = await request(server.getApplication())
                .delete(`${baseUrl}?folderUid=${folder.uid}`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            const stillExists = await messageRepo.findOne({ where: { uid: message.uid } });
            expect(stillExists).toBeFalsy();
        });
    });

    describe("mailboxUid integrity", () => {
        // `RetentionEnforcementJob`/`ErasureExecutionJob`/`util/LegalHoldUtils.ts` all trust `Message.mailboxUid`
        // as authoritative - if a client could set it independently of the message's real folder, a message
        // could silently evade (or be wrongly swept into) a legal hold or GDPR erasure scoped to a mailbox it
        // was never really in. See `BaseScopedChildRoute.resolveMailboxUidFor()`'s own doc comment.
        it("Silently corrects a client-supplied mailboxUid on update() to the message's real folder's mailbox, rather than trusting it.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid);
            const otherMailbox = await createMailbox(owner.uid);

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${message.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: message.uid, version: message.version, mailboxUid: otherMailbox.uid });

            expect(result.status).toBe(200);
            expect(result.body.mailboxUid).toBe(mailbox.uid);
            const persisted = await messageRepo.findOne({ where: { uid: message.uid } });
            expect(persisted!.mailboxUid).toBe(mailbox.uid);
        });

        it("Sets mailboxUid to the DESTINATION folder's mailbox (not the client-supplied value) when a message is re-parented across folders.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid);
            const destinationFolder = await createFolder(mailbox.uid, FolderType.ARCHIVE);

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${message.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: message.uid, version: message.version, folderUid: destinationFolder.uid, mailboxUid: "attacker-supplied-uid" });

            expect(result.status).toBe(200);
            expect(result.body.folderUid).toBe(destinationFolder.uid);
            expect(result.body.mailboxUid).toBe(mailbox.uid);
        });
    });

    describe("classify()", () => {
        it("Moves a message to Other without recording a sender override.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid, {
                from: { address: "News@Example.com", type: RecipientType.TO },
            });

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/classify`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ classifyAs: MessageClassification.OTHER });

            expect(result.status).toBe(200);
            expect(result.body.inferenceClassification).toBe(MessageClassification.OTHER);

            const overrides = await overrideRepo.find({ where: { mailboxUid: mailbox.uid } });
            expect(overrides.length).toBe(0);
        });

        it("Records a normalized sender override when applyToSender is set.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid, {
                from: { address: "News@Example.com", type: RecipientType.TO },
            });

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/classify`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ classifyAs: MessageClassification.OTHER, applyToSender: true });

            expect(result.status).toBe(200);

            const overrides = await overrideRepo.find({ where: { mailboxUid: mailbox.uid } });
            expect(overrides.length).toBe(1);
            expect(overrides[0].senderAddress).toBe("news@example.com");
            expect(overrides[0].classifyAs).toBe(MessageClassification.OTHER);
        });

        it("Replaces the existing override for a sender rather than adding a second, contradictory one.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid, {
                from: { address: "news@example.com", type: RecipientType.TO },
            });

            for (const classifyAs of [MessageClassification.OTHER, MessageClassification.FOCUSED]) {
                const result = await request(server.getApplication())
                    .post(`${baseUrl}/${message.uid}/classify`)
                    .set("Authorization", "jwt " + ownerToken)
                    .send({ classifyAs, applyToSender: true });
                expect(result.status).toBe(200);
            }

            const overrides = await overrideRepo.find({ where: { mailboxUid: mailbox.uid } });
            expect(overrides.length).toBe(1);
            expect(overrides[0].classifyAs).toBe(MessageClassification.FOCUSED);
        });

        it("Rejects a classifyAs that isn't focused or other (400).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid);

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/classify`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ classifyAs: "important" });

            expect(result.status).toBe(400);
        });

        it("Rejects a request with no body at all (400).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid);

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/classify`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(400);
        });

        it("A different user cannot classify a message they don't have access to (403).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid);

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/classify`)
                .set("Authorization", "jwt " + otherUserToken)
                .send({ classifyAs: MessageClassification.OTHER });

            expect(result.status).toBe(403);
        });

        it("Classifying a nonexistent message returns 404.", async () => {
            const result = await request(server.getApplication())
                .post(`${baseUrl}/${uuid.v4()}/classify`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ classifyAs: MessageClassification.OTHER });

            expect(result.status).toBe(404);
        });

        it("Filtering by inferenceClassification returns only that half of the Inbox.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const focused = await createMessage(mailbox.uid, folder.uid, {
                inferenceClassification: MessageClassification.FOCUSED,
            });
            await createMessage(mailbox.uid, folder.uid, { inferenceClassification: MessageClassification.OTHER });

            const result = await request(server.getApplication())
                .get(`${baseUrl}?folderUid=${folder.uid}&inferenceClassification=${MessageClassification.FOCUSED}`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(200);
            expect(result.body.length).toBe(1);
            expect(result.body[0].uid).toBe(focused.uid);
        });
    });

    /** Registers "example.com" as a verified domain, so an "@example.com" address (`createMessage()`'s own
     * default `from`/`recipients` domain) is classified internal by `isInternalAddress()`. */
    const verifyOwnDomain = async function (): Promise<void> {
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

    describe("Read receipt trigger (update())", () => {
        it("Marking a message read sends the read receipt immediately for an internal requester (the mailbox default).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            await verifyOwnDomain();
            const message = await createMessage(mailbox.uid, folder.uid, {
                messageId: "original@example.com",
                dispositionNotificationTo: "colleague@example.com",
            });

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${message.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: message.uid, version: message.version, flags: { ...message.flags, read: true } });

            expect(result.status).toBe(200);
            expect(result.body.readReceiptSentAt).toBeTruthy();
            expect(result.body.readReceiptPending).toBe(false);

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent).toHaveLength(1);
            expect(transport.sent[0].envelopeTo).toEqual(["colleague@example.com"]);
            expect(transport.sent[0].raw.toString()).toContain("multipart/report");
        });

        it("Holds the read receipt pending approval for an external requester (the mailbox default).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid, {
                messageId: "original@example.com",
                dispositionNotificationTo: "stranger@outside.com",
            });

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${message.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: message.uid, version: message.version, flags: { ...message.flags, read: true } });

            expect(result.status).toBe(200);
            expect(result.body.readReceiptSentAt).toBeFalsy();
            expect(result.body.readReceiptPending).toBe(true);

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent).toHaveLength(0);
        });

        it("autoSendReceiptsFederated does NOT auto-send for an external requester - 'outside.com' publishes no _rapidmx record so it classifies as external, not federated, and the mailbox's own autoSendReceiptsExternal default (false) still governs.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await mailboxRepo.update({ uid: mailbox.uid }, { autoSendReceiptsFederated: true });
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid, {
                messageId: "original@example.com",
                dispositionNotificationTo: "stranger@outside.com",
            });

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${message.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: message.uid, version: message.version, flags: { ...message.flags, read: true } });

            expect(result.status).toBe(200);
            expect(result.body.readReceiptSentAt).toBeFalsy();
            expect(result.body.readReceiptPending).toBe(true);
        });

        it("Sends the read receipt at most once - a later update that keeps flags.read true does not re-send.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            await verifyOwnDomain();
            const message = await createMessage(mailbox.uid, folder.uid, {
                messageId: "original@example.com",
                dispositionNotificationTo: "colleague@example.com",
            });

            const first = await request(server.getApplication())
                .put(`${baseUrl}/${message.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: message.uid, version: message.version, flags: { ...message.flags, read: true } });
            expect(first.status).toBe(200);

            const second = await request(server.getApplication())
                .put(`${baseUrl}/${message.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: message.uid, version: first.body.version, flags: { ...first.body.flags, flagged: true } });
            expect(second.status).toBe(200);

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent).toHaveLength(1);
        });

        it("Does nothing receipt-related for an ordinary message with no receipt request at all.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid);

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${message.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: message.uid, version: message.version, flags: { ...message.flags, read: true } });

            expect(result.status).toBe(200);
            expect(result.body.readReceiptSentAt).toBeFalsy();
            expect(result.body.readReceiptPending).toBe(false);
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent).toHaveLength(0);
        });

        it("Leaves the message unchanged (still 200) when marking it read and its mailbox no longer exists.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid, {
                messageId: "original@example.com",
                dispositionNotificationTo: "stranger@outside.com",
            });
            await mailboxRepo.delete({ uid: mailbox.uid });

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${message.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: message.uid, version: message.version, flags: { ...message.flags, read: true } });

            expect(result.status).toBe(200);
            expect(result.body.readReceiptSentAt).toBeFalsy();
            expect(result.body.readReceiptPending).toBe(false);
        });

        it("Logs rather than throws when sending the read receipt fails outright.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            await verifyOwnDomain();
            const message = await createMessage(mailbox.uid, folder.uid, {
                messageId: "original@example.com",
                dispositionNotificationTo: "colleague@example.com",
            });
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            const spy = vi.spyOn(transport, "send").mockRejectedValueOnce(new Error("smtp is down"));

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${message.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: message.uid, version: message.version, flags: { ...message.flags, read: true } });

            expect(result.status).toBe(200);
            expect(result.body.readReceiptSentAt).toBeFalsy();
            expect(result.body.readReceiptPending).toBe(false);
            spy.mockRestore();
        });
    });

    describe("receipt/approve and receipt/decline", () => {
        it("Approves a pending read receipt, sending it and clearing the pending flag.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid, {
                messageId: "original@example.com",
                dispositionNotificationTo: "stranger@outside.com",
                readReceiptPending: true,
            });

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/receipt/approve`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ type: "read" });

            expect(result.status).toBe(200);
            expect(result.body.readReceiptPending).toBe(false);
            expect(result.body.readReceiptSentAt).toBeTruthy();
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent).toHaveLength(1);
        });

        it("Declines a pending delivery receipt permanently, without ever sending it.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid, {
                messageId: "original@example.com",
                dispositionNotificationTo: "stranger@outside.com",
                deliveryReceiptPending: true,
            });

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/receipt/decline`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ type: "delivery" });

            expect(result.status).toBe(200);
            expect(result.body.deliveryReceiptPending).toBe(false);
            expect(result.body.deliveryReceiptSentAt).toBeFalsy();
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent).toHaveLength(0);
        });

        it("Approves a pending delivery receipt (the other type branch).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid, {
                messageId: "original@example.com",
                dispositionNotificationTo: "stranger@outside.com",
                deliveryReceiptPending: true,
            });

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/receipt/approve`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ type: "delivery" });

            expect(result.status).toBe(200);
            expect(result.body.deliveryReceiptPending).toBe(false);
            expect(result.body.deliveryReceiptSentAt).toBeTruthy();
        });

        it("Declines a pending read receipt (the other type branch).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid, {
                messageId: "original@example.com",
                dispositionNotificationTo: "stranger@outside.com",
                readReceiptPending: true,
            });

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/receipt/decline`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ type: "read" });

            expect(result.status).toBe(200);
            expect(result.body.readReceiptPending).toBe(false);
            expect(result.body.readReceiptSentAt).toBeFalsy();
        });

        it("Logs rather than throws when sending an approved receipt fails outright.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid, {
                messageId: "original@example.com",
                dispositionNotificationTo: "stranger@outside.com",
                readReceiptPending: true,
            });
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            const spy = vi.spyOn(transport, "send").mockRejectedValueOnce(new Error("smtp is down"));

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/receipt/approve`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ type: "read" });

            expect(result.status).toBe(200);
            expect(result.body.readReceiptPending).toBe(false);
            expect(result.body.readReceiptSentAt).toBeFalsy();
            spy.mockRestore();
        });

        it("Returns 500 when approving a receipt whose mailbox no longer exists.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid, {
                messageId: "original@example.com",
                dispositionNotificationTo: "stranger@outside.com",
                deliveryReceiptPending: true,
            });
            await mailboxRepo.delete({ uid: mailbox.uid });

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/receipt/approve`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ type: "delivery" });

            expect(result.status).toBe(500);
        });

        it("Rejects an invalid type (400).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid, { deliveryReceiptPending: true });

            const approveResult = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/receipt/approve`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ type: "bogus" });
            expect(approveResult.status).toBe(400);

            const declineResult = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/receipt/decline`)
                .set("Authorization", "jwt " + ownerToken)
                .send({});
            expect(declineResult.status).toBe(400);
        });

        it("Rejects approving/declining a receipt that isn't pending (400).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid);

            const approveResult = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/receipt/approve`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ type: "delivery" });
            expect(approveResult.status).toBe(400);

            const declineResult = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/receipt/decline`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ type: "read" });
            expect(declineResult.status).toBe(400);
        });

        it("A different user cannot approve/decline a receipt on a message they don't have access to (403).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.INBOX);
            const message = await createMessage(mailbox.uid, folder.uid, { deliveryReceiptPending: true });

            const approveResult = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/receipt/approve`)
                .set("Authorization", "jwt " + otherUserToken)
                .send({ type: "delivery" });
            expect(approveResult.status).toBe(403);

            const declineResult = await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/receipt/decline`)
                .set("Authorization", "jwt " + otherUserToken)
                .send({ type: "delivery" });
            expect(declineResult.status).toBe(403);
        });

        it("Approving/declining a nonexistent message returns 404.", async () => {
            const approveResult = await request(server.getApplication())
                .post(`${baseUrl}/${uuid.v4()}/receipt/approve`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ type: "delivery" });
            expect(approveResult.status).toBe(404);

            const declineResult = await request(server.getApplication())
                .post(`${baseUrl}/${uuid.v4()}/receipt/decline`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ type: "delivery" });
            expect(declineResult.status).toBe(404);
        });
    });

    describe("send() receipt request injection", () => {
        const sendDraft = async function (mailbox: MailboxSQL, draftsFolder: FolderSQL, data?: any) {
            const blobStore: InMemoryBlobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
            const bodyBlobKey = `bodies/${uuid.v4()}`;
            await blobStore.put(
                bodyBlobKey,
                Buffer.from("From: owner@example.com\r\nTo: recipient@example.com\r\nSubject: Hi\r\n\r\nHello there.\r\n"),
            );
            const message = await createMessage(mailbox.uid, draftsFolder.uid, { bodyBlobKey, ...data });
            return await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/send`)
                .set("Authorization", "jwt " + ownerToken);
        };

        it("Attaches Disposition-Notification-To and seeds receiptStatus for an internal recipient (the mailbox default).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);
            await verifyOwnDomain();

            const result = await sendDraft(mailbox, draftsFolder);

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            expect(result.body.receiptStatus).toEqual([{ recipientAddress: "recipient@example.com" }]);

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent[0].raw.toString()).toContain("Disposition-Notification-To: owner@example.com");
        });

        it("Does not attach a request header for an external-only recipient by default.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);
            // "example.com" is never verified in this test, so "recipient@example.com" is external.

            const result = await sendDraft(mailbox, draftsFolder);

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.body.receiptStatus).toBeFalsy();
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent[0].raw.toString()).not.toContain("Disposition-Notification-To");
        });

        it("An explicit requestReceipt: false overrides the mailbox's own internal default off.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);
            await verifyOwnDomain();

            const result = await sendDraft(mailbox, draftsFolder, { requestReceipt: false });

            expect(result.body.receiptStatus).toBeFalsy();
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent[0].raw.toString()).not.toContain("Disposition-Notification-To");
        });

        it("alwaysRequestReceiptExternal opts an external recipient in.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await mailboxRepo.update({ uid: mailbox.uid }, { alwaysRequestReceiptExternal: true });
            const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);

            const result = await sendDraft(mailbox, draftsFolder);

            expect(result.body.receiptStatus).toEqual([{ recipientAddress: "recipient@example.com" }]);
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent[0].raw.toString()).toContain("Disposition-Notification-To: owner@example.com");
        });

        it("alwaysRequestReceiptFederated does NOT opt an external recipient in - federated and external are distinct tiers, and 'example.com' (never verified in this test) publishes no _rapidmx record so it classifies as external, not federated.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await mailboxRepo.update({ uid: mailbox.uid }, { alwaysRequestReceiptFederated: true });
            const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);

            const result = await sendDraft(mailbox, draftsFolder);

            expect(result.body.receiptStatus).toBeFalsy();
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent[0].raw.toString()).not.toContain("Disposition-Notification-To");
        });

        it("alwaysRequestReceiptFederated DOES opt in a real federated peer once its _rapidmx TXT record resolves (proves classifyRecipientTier() is wired to real DNS resolution, not just the stub).", async () => {
            const mailbox = await createMailbox(owner.uid);
            await mailboxRepo.update({ uid: mailbox.uid }, { alwaysRequestReceiptFederated: true });
            const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);

            const dnsResolver = objectFactory.getInstance<StaticDnsResolver>("DnsResolver")!;
            dnsResolver.records.set("_rapidmx.federated-peer-sql.example", [
                ["v=RMXv1; id=1; host=mail.federated-peer-sql.example;"],
            ]);
            const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
            const bodyBlobKey = `bodies/${uuid.v4()}`;
            await blobStore.put(
                bodyBlobKey,
                Buffer.from("From: owner@example.com\r\nTo: peer@federated-peer-sql.example\r\nSubject: Hi\r\n\r\nHello there.\r\n"),
            );

            // `envelopeTo` in send() comes from message.recipients (a structured field), not parsed from the
            // raw blob's own To: header - both must point at the federated peer for this test to actually
            // exercise that recipient's tier classification.
            const result = await sendDraft(mailbox, draftsFolder, {
                bodyBlobKey,
                recipients: [{ address: "peer@federated-peer-sql.example", type: RecipientType.TO }],
            });

            expect(result.body.receiptStatus).toEqual([{ recipientAddress: "peer@federated-peer-sql.example" }]);
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent[0].raw.toString()).toContain("Disposition-Notification-To: owner@example.com");
        });
    });

    describe("send() RapidMX-Key attachment (E4)", () => {
        const sendDraft = async function (mailbox: MailboxSQL, draftsFolder: FolderSQL, data?: any) {
            const blobStore: InMemoryBlobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
            const bodyBlobKey = `bodies/${uuid.v4()}`;
            await blobStore.put(
                bodyBlobKey,
                Buffer.from("From: owner@example.com\r\nTo: recipient@example.com\r\nSubject: Hi\r\n\r\nHello there.\r\n"),
            );
            const message = await createMessage(mailbox.uid, draftsFolder.uid, { bodyBlobKey, ...data });
            return await request(server.getApplication())
                .post(`${baseUrl}/${message.uid}/send`)
                .set("Authorization", "jwt " + ownerToken);
        };

        const activeKey: PublicKey = {
            publicKey: "ZmFrZS1jZXJ0LWJ5dGVz",
            type: "x509",
            useType: "encrypt",
            fingerprint: "aabbccdd",
            notBefore: Date.now() - 1000,
            notAfter: Date.now() + 1000 * 60 * 60 * 24 * 365,
        };

        it("Attaches RapidMX-Key when the sending mailbox has an active encrypt key.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await mailboxRepo.update(
                { uid: mailbox.uid },
                { keys: [activeKey], encryptPreference: { preferEncrypt: "mutual" } },
            );
            const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);

            const result = await sendDraft(mailbox, draftsFolder);

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent[0].raw.toString()).toContain(
                "RapidMX-Key: addr=owner@example.com; prefer-encrypt=mutual; type=x509; keydata=ZmFrZS1jZXJ0LWJ5dGVz",
            );
        });

        it("Does not attach RapidMX-Key when the sending mailbox has no keys.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);

            const result = await sendDraft(mailbox, draftsFolder);

            expect(result.status).toBeGreaterThanOrEqual(200);
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent[0].raw.toString()).not.toContain("RapidMX-Key");
        });

        it("Does not attach RapidMX-Key for a revoked key.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await mailboxRepo.update({ uid: mailbox.uid }, { keys: [{ ...activeKey, revokedAt: Date.now() - 1000 }] });
            const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);

            const result = await sendDraft(mailbox, draftsFolder);

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent[0].raw.toString()).not.toContain("RapidMX-Key");
        });

        it("Does not attach RapidMX-Key for an expired key.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await mailboxRepo.update({ uid: mailbox.uid }, { keys: [{ ...activeKey, notAfter: Date.now() - 1000 }] });
            const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);

            const result = await sendDraft(mailbox, draftsFolder);

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent[0].raw.toString()).not.toContain("RapidMX-Key");
        });

        it("Only announces a 'sign' key's absence - a signing key alone never yields a RapidMX-Key header.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await mailboxRepo.update({ uid: mailbox.uid }, { keys: [{ ...activeKey, useType: "sign" }] });
            const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);

            const result = await sendDraft(mailbox, draftsFolder);

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent[0].raw.toString()).not.toContain("RapidMX-Key");
        });
    });
});
