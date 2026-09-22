///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { request } from "@rapidrest/service-core/test";
import { MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { AuditLogEntryMongo } from "../../../src/models/mongo/AuditLogEntryMongo.js";
import { FocusedInboxOverrideMongo } from "../../../src/models/mongo/FocusedInboxOverrideMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { DomainMongo } from "../../../src/models/mongo/DomainMongo.js";
import { FolderMongo } from "../../../src/models/mongo/FolderMongo.js";
import { MatterMongo } from "../../../src/models/mongo/MatterMongo.js";
import { MessageMongo } from "../../../src/models/mongo/MessageMongo.js";
import {
    AuditAction,
    FolderType,
    MessageClassification,
    MessageImportance,
    PublicKey,
    RecipientType,
} from "../../../src/models/types.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles, InMemoryBlobStore, RecordingMailTransport, StaticDnsResolver } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:MessageMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/messages";
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let folderRepo: MongoRepository<FolderMongo>;
    let messageRepo: MongoRepository<MessageMongo>;
    let aclRepo: MongoRepository<any>;
    let auditLogRepo: MongoRepository<AuditLogEntryMongo>;
    let overrideRepo: MongoRepository<FocusedInboxOverrideMongo>;
    let domainRepo: MongoRepository<DomainMongo>;
    let matterRepo: MongoRepository<MatterMongo>;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);
    const otherUser: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const otherUserToken = JWTUtils.createTokenSync(config.get("auth"), otherUser);
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

    const createMailbox = async function (ownerUid: string): Promise<MailboxMongo> {
        const obj: MailboxMongo = new MailboxMongo({
            ownerUserUid: ownerUid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            // The address every draft below is sent from - `send()`/`recall()` only accept a sender that is the mailbox's own.
            aliasAddresses: ["owner@example.com"],
            displayName: "Test Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });
        const result: MailboxMongo = await mailboxRepo.save(obj);
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

    const createFolder = async function (mailboxUid: string, type: FolderType = FolderType.DRAFTS): Promise<FolderMongo> {
        const obj: FolderMongo = new FolderMongo({
            mailboxUid,
            name: type,
            type,
            unreadCount: 0,
            totalCount: 0,
            syncKeyVersion: 0,
        });
        const result: FolderMongo = await folderRepo.save(obj);
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

    const createMessage = async function (mailboxUid: string, folderUid: string, data?: any): Promise<MessageMongo> {
        const obj: MessageMongo = new MessageMongo({
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

    const createMatter = async function (data?: any): Promise<MatterMongo> {
        const obj: MatterMongo = new MatterMongo({
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
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        let conn: any = connMgr?.connections.get("acl");
        if (conn instanceof MongoConnection) {
            aclRepo = conn.getMongoRepository("AccessControlListMongo");
        }
        conn = connMgr?.connections.get("mongo");
        if (conn instanceof MongoConnection) {
            mailboxRepo = conn.getMongoRepository("MailboxMongo");
            folderRepo = conn.getMongoRepository("FolderMongo");
            messageRepo = conn.getMongoRepository("MessageMongo");
            auditLogRepo = conn.getMongoRepository("AuditLogEntryMongo");
            overrideRepo = conn.getMongoRepository("FocusedInboxOverrideMongo");
            domainRepo = conn.getMongoRepository("DomainMongo");
            matterRepo = conn.getMongoRepository("MatterMongo");
        } else {
            throw new Error("Could not find mongo connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        for (const repo of [mailboxRepo, folderRepo, messageRepo, auditLogRepo, overrideRepo, domainRepo, matterRepo]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
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
        const sentFolder = await folderRepo.findOne({ mailboxUid: mailbox.uid, type: FolderType.SENT_ITEMS } as any);
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

        const outbox = await folderRepo.findOne({ mailboxUid: mailbox.uid, type: FolderType.OUTBOX } as any);
        expect(outbox).toBeDefined();
        expect(result.body.folderUid).toBe(outbox!.uid);

        const sentFolder = await folderRepo.findOne({ mailboxUid: mailbox.uid, type: FolderType.SENT_ITEMS } as any);
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

        const sentFolder = await folderRepo.findOne({ mailboxUid: mailbox.uid, type: FolderType.SENT_ITEMS } as any);
        expect(result.body.folderUid).toBe(sentFolder!.uid);

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(1);
    });

    it("Sending an HTML draft persists its sanitized HTML under sanitizedHtmlBlobKey, separate from the raw MIME.", async () => {
        // Regression test: `scanResult.sanitizedHtml` used to be computed by ScanPipeline and then discarded on
        // send, just as on ingestion - confirms it's now actually stored.
        const mailbox = await createMailbox(owner.uid);
        const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);
        const blobStore: InMemoryBlobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const bodyBlobKey = `bodies/${uuid.v4()}`;
        await blobStore.put(
            bodyBlobKey,
            Buffer.from(
                "From: owner@example.com\r\nTo: recipient@example.com\r\nSubject: Hi\r\nContent-Type: text/html\r\n\r\n" +
                    "<html><body><p>Hello</p><script>alert(1)</script></body></html>\r\n",
            ),
        );
        const message = await createMessage(mailbox.uid, draftsFolder.uid, { bodyBlobKey });

        const result = await request(server.getApplication())
            .post(`${baseUrl}/${message.uid}/send`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.sanitizedHtmlBlobKey).toBeTruthy();
        expect(result.body.sanitizedHtmlBlobKey).not.toBe(result.body.bodyBlobKey);

        const sanitized: Buffer = await blobStore.get(result.body.sanitizedHtmlBlobKey);
        expect(sanitized.toString()).not.toContain("<script>");
        expect(sanitized.toString()).toContain("Hello");
    });

    it("Sending a second clean draft reuses the already-resolved Sent Items folder (folderRepo cache).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);
        const blobStore: InMemoryBlobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;

        const firstBodyBlobKey = `bodies/${uuid.v4()}`;
        await blobStore.put(
            firstBodyBlobKey,
            Buffer.from("From: owner@example.com\r\nTo: recipient@example.com\r\n\r\nFirst.\r\n"),
        );
        const firstMessage = await createMessage(mailbox.uid, draftsFolder.uid, { bodyBlobKey: firstBodyBlobKey });
        const firstResult = await request(server.getApplication())
            .post(`${baseUrl}/${firstMessage.uid}/send`)
            .set("Authorization", "jwt " + ownerToken);
        expect(firstResult.status).toBeGreaterThanOrEqual(200);
        expect(firstResult.status).toBeLessThan(300);
        const sentFolder = await folderRepo.findOne({ mailboxUid: mailbox.uid, type: FolderType.SENT_ITEMS } as any);
        expect(sentFolder).toBeDefined();

        const secondBodyBlobKey = `bodies/${uuid.v4()}`;
        await blobStore.put(
            secondBodyBlobKey,
            Buffer.from("From: owner@example.com\r\nTo: recipient@example.com\r\n\r\nSecond.\r\n"),
        );
        const secondMessage = await createMessage(mailbox.uid, draftsFolder.uid, { bodyBlobKey: secondBodyBlobKey });

        const secondResult = await request(server.getApplication())
            .post(`${baseUrl}/${secondMessage.uid}/send`)
            .set("Authorization", "jwt " + ownerToken);

        expect(secondResult.status).toBeGreaterThanOrEqual(200);
        expect(secondResult.status).toBeLessThan(300);
        expect(secondResult.body.folderUid).toBe(sentFolder!.uid);

        // Only ever one Sent Items folder was created for this mailbox - proof the second send() reused the
        // cached folderRepo/lookup rather than re-deriving (or re-creating) it from scratch.
        const sentFolders = await folderRepo.find({ mailboxUid: mailbox.uid, type: FolderType.SENT_ITEMS }).toArray();
        expect(sentFolders.length).toBe(1);
    });

    it("Sending a message that fails spam scanning returns 422 and does not relay or move it.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);
        const blobStore: InMemoryBlobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const bodyBlobKey = `bodies/${uuid.v4()}`;
        await blobStore.put(
            bodyBlobKey,
            Buffer.from(
                "From: owner@example.com\r\nTo: recipient@example.com\r\nX-Test-Force-Spam: true\r\n\r\nHello.\r\n",
            ),
        );
        const message = await createMessage(mailbox.uid, draftsFolder.uid, { bodyBlobKey });

        const result = await request(server.getApplication())
            .post(`${baseUrl}/${message.uid}/send`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(422);

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(0);
        const stillDraft = await messageRepo.findOne({ uid: message.uid } as any);
        expect(stillDraft?.folderUid).toBe(draftsFolder.uid);
    });

    it("Sending a message the mail transport rejects returns 502 and does not move it out of Drafts.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);
        const blobStore: InMemoryBlobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const bodyBlobKey = `bodies/${uuid.v4()}`;
        await blobStore.put(
            bodyBlobKey,
            Buffer.from("From: owner@example.com\r\nTo: reject@example.com\r\n\r\nHello.\r\n"),
        );
        const message = await createMessage(mailbox.uid, draftsFolder.uid, {
            bodyBlobKey,
            recipients: [{ address: "reject@example.com", type: RecipientType.TO }],
        });

        const result = await request(server.getApplication())
            .post(`${baseUrl}/${message.uid}/send`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(502);

        const stillDraft = await messageRepo.findOne({ uid: message.uid } as any);
        expect(stillDraft?.folderUid).toBe(draftsFolder.uid);
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

            const entries = await auditLogRepo.find({ targetUid: message.uid }).toArray();
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

            const archiveFolder = await folderRepo.findOne({ mailboxUid: mailbox.uid, type: FolderType.ARCHIVE } as any);
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

            const archiveFolders = await folderRepo.find({ mailboxUid: mailbox.uid, type: FolderType.ARCHIVE }).toArray();
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

    describe("Threading a reply this API composed", () => {
        /** A draft whose stored MIME carries no threading headers at all - what `POST /mail/compose/:id/assemble`
         * produces, since it composes from recipients, subject and HTML and knows nothing about a reply chain. */
        const draftReplying = async (mailboxUid: string, folderUid: string, subject: string, thread: any) => {
            const blobStore: InMemoryBlobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
            const bodyBlobKey = `bodies/${uuid.v4()}`;
            await blobStore.put(
                bodyBlobKey,
                Buffer.from(`From: owner@example.com\r\nTo: recipient@example.com\r\nSubject: ${subject}\r\n\r\nReply body.\r\n`),
            );
            return await createMessage(mailboxUid, folderUid, { bodyBlobKey, subject, ...thread });
        };
        const send = async (uid: string) =>
            await request(server.getApplication()).post(`${baseUrl}/${uid}/send`).set("Authorization", "jwt " + ownerToken);
        const relayed = (): string => {
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            return transport.sent[transport.sent.length - 1].raw.toString();
        };

        it("Writes In-Reply-To and References into the relayed MIME from what the draft records, and files the copy into the parent's conversation.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const inbox = await createFolder(mailbox.uid, FolderType.INBOX);
            const drafts = await createFolder(mailbox.uid, FolderType.DRAFTS);
            await createMessage(mailbox.uid, inbox.uid, { messageId: "root@example.com", conversationId: "root@example.com", subject: "Hello" });
            const draft = await draftReplying(mailbox.uid, drafts.uid, "Re: Hello", {
                inReplyTo: "root@example.com",
                references: ["root@example.com"],
            });

            const result = await send(draft.uid);

            expect(result.status).toBe(200);
            expect(relayed()).toContain("In-Reply-To: <root@example.com>");
            expect(relayed()).toContain("References: <root@example.com>");
            expect(result.body.conversationId).toBe("root@example.com");
            expect(result.body.inReplyTo).toBe("root@example.com");
            expect(result.body.references).toEqual(["root@example.com"]);
        });

        it("Persists those headers onto the stored body, so the Sent Items copy's own source shows the thread.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const drafts = await createFolder(mailbox.uid, FolderType.DRAFTS);
            const draft = await draftReplying(mailbox.uid, drafts.uid, "Re: Hello", { inReplyTo: "root@example.com", references: [] });

            expect((await send(draft.uid)).status).toBe(200);

            const blobStore: InMemoryBlobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
            const stored: string = (await blobStore.get(draft.bodyBlobKey)).toString();
            expect(stored).toContain("In-Reply-To: <root@example.com>");
            expect(stored).toContain("References: <root@example.com>");
        });

        it("Joins the conversation of a parent that is itself a reply, three deep, with only a direct parent named.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const inbox = await createFolder(mailbox.uid, FolderType.INBOX);
            const drafts = await createFolder(mailbox.uid, FolderType.DRAFTS);
            await createMessage(mailbox.uid, inbox.uid, { messageId: "root@example.com", conversationId: "root@example.com", subject: "Hello" });
            await createMessage(mailbox.uid, inbox.uid, {
                messageId: "second@example.com",
                conversationId: "root@example.com",
                inReplyTo: "root@example.com",
                subject: "Re: Hello",
            });
            const draft = await draftReplying(mailbox.uid, drafts.uid, "Re: Hello", { inReplyTo: "second@example.com", references: [] });

            const result = await send(draft.uid);

            expect(result.status).toBe(200);
            expect(result.body.conversationId).toBe("root@example.com");
        });

        it("Threads a reply that records References but no In-Reply-To.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const inbox = await createFolder(mailbox.uid, FolderType.INBOX);
            const drafts = await createFolder(mailbox.uid, FolderType.DRAFTS);
            await createMessage(mailbox.uid, inbox.uid, { messageId: "root@example.com", conversationId: "root@example.com", subject: "Hello" });
            const draft = await draftReplying(mailbox.uid, drafts.uid, "Re: Hello", { references: ["root@example.com"] });

            const result = await send(draft.uid);

            expect(result.status).toBe(200);
            expect(relayed()).not.toContain("In-Reply-To:");
            expect(relayed()).toContain("References: <root@example.com>");
            expect(result.body.conversationId).toBe("root@example.com");
        });

        it("Leaves a message that replies to nothing in its own conversation, relaying no threading headers.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const inbox = await createFolder(mailbox.uid, FolderType.INBOX);
            const drafts = await createFolder(mailbox.uid, FolderType.DRAFTS);
            await createMessage(mailbox.uid, inbox.uid, { messageId: "root@example.com", conversationId: "root@example.com", subject: "Hello" });
            const draft = await draftReplying(mailbox.uid, drafts.uid, "Hello", { references: [] });

            const result = await send(draft.uid);

            expect(result.status).toBe(200);
            expect(relayed()).not.toContain("In-Reply-To:");
            expect(relayed()).not.toContain("References:");
            expect(result.body.conversationId).toBe(result.body.messageId);
            expect(result.body.conversationId).not.toBe("root@example.com");
        });

        it("Keeps a renamed reply in the same conversation - the subject is never what threads a message.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const inbox = await createFolder(mailbox.uid, FolderType.INBOX);
            const drafts = await createFolder(mailbox.uid, FolderType.DRAFTS);
            await createMessage(mailbox.uid, inbox.uid, { messageId: "root@example.com", conversationId: "root@example.com", subject: "Hello" });
            const draft = await draftReplying(mailbox.uid, drafts.uid, "Lunch on Friday instead", {
                inReplyTo: "root@example.com",
                references: ["root@example.com"],
            });

            expect((await send(draft.uid)).body.conversationId).toBe("root@example.com");
        });

        it("Leaves a draft whose own MIME already carries threading headers exactly as it is.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const drafts = await createFolder(mailbox.uid, FolderType.DRAFTS);
            const blobStore: InMemoryBlobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
            const bodyBlobKey = `bodies/${uuid.v4()}`;
            await blobStore.put(
                bodyBlobKey,
                Buffer.from(
                    "From: owner@example.com\r\nTo: recipient@example.com\r\nSubject: Re: Hello\r\n" +
                        "In-Reply-To: <own@example.com>\r\nReferences: <own@example.com>\r\n\r\nReply body.\r\n",
                ),
            );
            const draft = await createMessage(mailbox.uid, drafts.uid, {
                bodyBlobKey,
                subject: "Re: Hello",
                inReplyTo: "other@example.com",
                references: ["other@example.com"],
            });

            const result = await send(draft.uid);

            expect(result.status).toBe(200);
            expect(relayed()).toContain("In-Reply-To: <own@example.com>");
            expect(relayed()).not.toContain("other@example.com");
            // The relayed bytes are what the sent copy records, not what the draft row happened to say.
            expect(result.body.inReplyTo).toBe("own@example.com");
            expect(result.body.conversationId).toBe("own@example.com");
        });

        it("Reports every message exactly once - a conversation never comes back alongside its own members.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const inbox = await createFolder(mailbox.uid, FolderType.INBOX);
            const drafts = await createFolder(mailbox.uid, FolderType.DRAFTS);
            const root = await createMessage(mailbox.uid, inbox.uid, {
                messageId: "root@example.com",
                conversationId: "root@example.com",
                subject: "Hello",
                receivedDate: new Date(Date.now() - 3600_000),
            });
            const second = await createMessage(mailbox.uid, inbox.uid, {
                messageId: "second@example.com",
                conversationId: "root@example.com",
                inReplyTo: "root@example.com",
                subject: "Re: Hello",
                receivedDate: new Date(Date.now() - 1800_000),
            });
            const loner = await createMessage(mailbox.uid, inbox.uid, { messageId: "loner@example.com", subject: "Unrelated" });
            const draft = await draftReplying(mailbox.uid, drafts.uid, "Re: Hello", { inReplyTo: "second@example.com", references: [] });
            const sent = await send(draft.uid);
            expect(sent.status).toBe(200);

            const result = await request(server.getApplication())
                .get(`${baseUrl}/conversations?mailboxUid=${mailbox.uid}`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(200);
            const uids: string[] = result.body.flatMap((conversation: any) => conversation.messageUids);
            expect([...uids].sort()).toEqual([root.uid, second.uid, loner.uid, sent.body.uid].sort());
            expect(new Set(uids).size).toBe(uids.length);
            const thread = result.body.find((conversation: any) => conversation.conversationId === "root@example.com");
            expect(thread.messageCount).toBe(3);
            expect(result.body).toHaveLength(2);

            const expanded = await request(server.getApplication())
                .get(`${baseUrl}/conversations/root%40example.com?mailboxUid=${mailbox.uid}`)
                .set("Authorization", "jwt " + ownerToken);
            expect(expanded.body.map((message: any) => message.uid).sort()).toEqual([root.uid, second.uid, sent.body.uid].sort());
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
                // Explicitly older than the reply sent below, which is stamped `new Date()` - without it the two
                // can share a millisecond and which one the summary calls "latest" comes down to uid ordering.
                receivedDate: new Date(Date.now() - 60 * 60 * 1000),
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

            const sentFolder = await folderRepo.findOne({ mailboxUid: mailbox.uid, type: FolderType.SENT_ITEMS } as any);

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
        const entries = await auditLogRepo.find({ targetUid: message.uid }).toArray();
        expect(entries.some((e) => e.action === AuditAction.MESSAGE_CONTENT_ACCESSED)).toBe(false);
    });

    it("A trusted admin with no grant on the mailbox can't read a message's content (404, like a message that doesn't exist) and leaves no trace of it.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid, FolderType.INBOX);
        const message = await createMessage(mailbox.uid, folder.uid, { subject: "Confidential" });

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${message.uid}/content`)
            .set("Authorization", "jwt " + adminToken);
        const missing = await request(server.getApplication())
            .get(`${baseUrl}/${uuid.v4()}/content`)
            .set("Authorization", "jwt " + adminToken);

        expect(result.status).toBe(404);
        expect(missing.status).toBe(404);
        expect(await auditLogRepo.find({ targetUid: message.uid }).toArray()).toEqual([]);
    });

    it("Audits an admin who has been granted the mailbox (a delegate) reading a message's content in another user's mailbox.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid, FolderType.INBOX);
        const message = await createMessage(mailbox.uid, folder.uid, { subject: "Confidential" });
        await aclRepo.updateOne({ uid: mailbox.uid } as any, { $push: { records: { userOrRoleId: admin.uid, actions: ["read", "list"] } } } as any);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${message.uid}/content`)
            .set("Authorization", "jwt " + adminToken);

        expect(result.status).toBe(200);
        const entries = await auditLogRepo.find({ targetUid: message.uid }).toArray();
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
        await mailboxRepo.deleteOne({ uid: mailbox.uid });

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${message.uid}/content`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        const entries = await auditLogRepo.find({ targetUid: message.uid }).toArray();
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

        const entries = await auditLogRepo.find({ targetUid: message.uid }).toArray();
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
            const stillExists = await messageRepo.findOne({ uid: message.uid } as any);
            expect(stillExists).toBeTruthy();

            const entries = await auditLogRepo.find({ targetUid: message.uid }).toArray();
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
            const stillPresent = await messageRepo.findOne({ uid: message.uid } as any);
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
            const stillExists = await messageRepo.findOne({ uid: message.uid } as any);
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
            const stillExists = await messageRepo.findOne({ uid: message.uid } as any);
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
            const stillExists = await messageRepo.findOne({ uid: message.uid } as any);
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
            const persisted = await messageRepo.findOne({ uid: message.uid } as any);
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

            const overrides = await overrideRepo.find({ mailboxUid: mailbox.uid }).toArray();
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

            const overrides = await overrideRepo.find({ mailboxUid: mailbox.uid }).toArray();
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

            const overrides = await overrideRepo.find({ mailboxUid: mailbox.uid }).toArray();
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
            new DomainMongo({
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
            await mailboxRepo.updateOne({ uid: mailbox.uid }, { $set: { autoSendReceiptsFederated: true } });
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
            await mailboxRepo.deleteOne({ uid: mailbox.uid });

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
            await mailboxRepo.deleteOne({ uid: mailbox.uid });

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
        const sendDraft = async function (mailbox: MailboxMongo, draftsFolder: FolderMongo, data?: any) {
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
            await mailboxRepo.updateOne({ uid: mailbox.uid }, { $set: { alwaysRequestReceiptExternal: true } });
            const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);

            const result = await sendDraft(mailbox, draftsFolder);

            expect(result.body.receiptStatus).toEqual([{ recipientAddress: "recipient@example.com" }]);
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent[0].raw.toString()).toContain("Disposition-Notification-To: owner@example.com");
        });

        it("alwaysRequestReceiptFederated does NOT opt an external recipient in - federated and external are distinct tiers, and 'example.com' (never verified in this test) publishes no _rapidmx record so it classifies as external, not federated.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await mailboxRepo.updateOne({ uid: mailbox.uid }, { $set: { alwaysRequestReceiptFederated: true } });
            const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);

            const result = await sendDraft(mailbox, draftsFolder);

            expect(result.body.receiptStatus).toBeFalsy();
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent[0].raw.toString()).not.toContain("Disposition-Notification-To");
        });

        it("alwaysRequestReceiptFederated DOES opt in a real federated peer once its _rapidmx TXT record resolves (proves classifyRecipientTier() is wired to real DNS resolution, not just the stub).", async () => {
            const mailbox = await createMailbox(owner.uid);
            await mailboxRepo.updateOne({ uid: mailbox.uid }, { $set: { alwaysRequestReceiptFederated: true } });
            const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);

            const dnsResolver = objectFactory.getInstance<StaticDnsResolver>("DnsResolver")!;
            dnsResolver.records.set("_rapidmx.federated-peer-mongo.example", [
                ["v=RMXv1; id=1; host=mail.federated-peer-mongo.example;"],
            ]);
            const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
            const bodyBlobKey = `bodies/${uuid.v4()}`;
            await blobStore.put(
                bodyBlobKey,
                Buffer.from("From: owner@example.com\r\nTo: peer@federated-peer-mongo.example\r\nSubject: Hi\r\n\r\nHello there.\r\n"),
            );

            // `envelopeTo` in send() comes from message.recipients (a structured field), not parsed from the
            // raw blob's own To: header - both must point at the federated peer for this test to actually
            // exercise that recipient's tier classification.
            const result = await sendDraft(mailbox, draftsFolder, {
                bodyBlobKey,
                recipients: [{ address: "peer@federated-peer-mongo.example", type: RecipientType.TO }],
            });

            expect(result.body.receiptStatus).toEqual([{ recipientAddress: "peer@federated-peer-mongo.example" }]);
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent[0].raw.toString()).toContain("Disposition-Notification-To: owner@example.com");
        });
    });

    describe("send() RapidMX-Key attachment (E4)", () => {
        const sendDraft = async function (mailbox: MailboxMongo, draftsFolder: FolderMongo, data?: any) {
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
            await mailboxRepo.updateOne(
                { uid: mailbox.uid },
                { $set: { keys: [activeKey], encryptPreference: { preferEncrypt: "mutual" } } },
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
            await mailboxRepo.updateOne(
                { uid: mailbox.uid },
                { $set: { keys: [{ ...activeKey, revokedAt: Date.now() - 1000 }] } },
            );
            const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);

            const result = await sendDraft(mailbox, draftsFolder);

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent[0].raw.toString()).not.toContain("RapidMX-Key");
        });

        it("Does not attach RapidMX-Key for an expired key.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await mailboxRepo.updateOne(
                { uid: mailbox.uid },
                { $set: { keys: [{ ...activeKey, notAfter: Date.now() - 1000 }] } },
            );
            const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);

            const result = await sendDraft(mailbox, draftsFolder);

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent[0].raw.toString()).not.toContain("RapidMX-Key");
        });

        it("Only announces a 'sign' key's absence - a signing key alone never yields a RapidMX-Key header.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await mailboxRepo.updateOne(
                { uid: mailbox.uid },
                { $set: { keys: [{ ...activeKey, useType: "sign" }] } },
            );
            const draftsFolder = await createFolder(mailbox.uid, FolderType.DRAFTS);

            const result = await sendDraft(mailbox, draftsFolder);

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent[0].raw.toString()).not.toContain("RapidMX-Key");
        });
    });
});
