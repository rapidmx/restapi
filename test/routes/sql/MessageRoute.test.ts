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
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { FolderSQL } from "../../../src/models/sql/FolderSQL.js";
import { MessageSQL } from "../../../src/models/sql/MessageSQL.js";
import { AuditAction, FolderType, MessageImportance, RecipientType } from "../../../src/models/types.js";
import { registerTestDoubles, InMemoryBlobStore, RecordingMailTransport } from "../../testDoubles.js";

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

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);
    const otherUser: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const otherUserToken = JWTUtils.createTokenSync(config.get("auth"), otherUser);

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
});
