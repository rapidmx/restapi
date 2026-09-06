///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { request } from "@rapidrest/service-core/test";
import { MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { FolderMongo } from "../../../src/models/mongo/FolderMongo.js";
import { MessageMongo } from "../../../src/models/mongo/MessageMongo.js";
import { FolderType, MessageImportance, RecipientType } from "../../../src/models/types.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles, InMemoryBlobStore, RecordingMailTransport } from "../../testDoubles.js";

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

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);
    const otherUser: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const otherUserToken = JWTUtils.createTokenSync(config.get("auth"), otherUser);

    const createMailbox = async function (ownerUid: string): Promise<MailboxMongo> {
        const obj: MailboxMongo = new MailboxMongo({
            ownerUserUid: ownerUid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
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
        for (const repo of [mailboxRepo, folderRepo, messageRepo]) {
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
});
