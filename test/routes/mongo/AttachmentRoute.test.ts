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
import { AttachmentMongo } from "../../../src/models/mongo/AttachmentMongo.js";
import { FolderType, MessageImportance, RecipientType } from "../../../src/models/types.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles, InMemoryBlobStore } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:AttachmentMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/attachments";
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let folderRepo: MongoRepository<FolderMongo>;
    let messageRepo: MongoRepository<MessageMongo>;
    let attachmentRepo: MongoRepository<AttachmentMongo>;
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

    const createFolder = async function (mailboxUid: string): Promise<FolderMongo> {
        const obj: FolderMongo = new FolderMongo({
            mailboxUid,
            name: "Inbox",
            type: FolderType.INBOX,
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

    const createAttachment = async function (mailboxUid: string, folderUid: string, data?: any): Promise<AttachmentMongo> {
        const blobStore: InMemoryBlobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const blobKey = `attachments/${uuid.v4()}`;
        await blobStore.put(blobKey, Buffer.from("attachment content"));
        const obj: AttachmentMongo = new AttachmentMongo({
            messageUid: uuid.v4(),
            mailboxUid,
            folderUid,
            filename: "test.txt",
            mimeType: "text/plain",
            sizeBytes: 19,
            blobKey,
            isInline: false,
            ...data,
        });
        return await attachmentRepo.save(obj);
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
            attachmentRepo = conn.getMongoRepository("AttachmentMongo");
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
        for (const repo of [mailboxRepo, folderRepo, messageRepo, attachmentRepo]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
    });

    it("Owner can upload an attachment to a message in a folder they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const message = await createMessage(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .post(`${baseUrl}/upload?messageUid=${message.uid}&filename=test.txt&mimeType=text/plain`)
            .set("Authorization", "jwt " + ownerToken)
            .set("Content-Type", "application/octet-stream")
            .send(Buffer.from("hello world"));

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.filename).toBe("test.txt");
        expect(result.body.sizeBytes).toBe(11);
        // folderUid/mailboxUid are always derived server-side from the message, never from client input.
        expect(result.body.folderUid).toBe(folder.uid);
        expect(result.body.mailboxUid).toBe(mailbox.uid);

        const blobStore: InMemoryBlobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const stored: Buffer = await blobStore.get(result.body.blobKey);
        expect(stored.toString()).toBe("hello world");
    });

    it("Rejects an upload missing a required query parameter (e.g. filename).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const message = await createMessage(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .post(`${baseUrl}/upload?messageUid=${message.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .set("Content-Type", "application/octet-stream")
            .send(Buffer.from("hello world"));

        expect(result.status).toBe(400);
    });

    it("Rejects an upload whose messageUid doesn't correspond to any real message.", async () => {
        const result = await request(server.getApplication())
            .post(`${baseUrl}/upload?messageUid=${uuid.v4()}&filename=test.txt&mimeType=text/plain`)
            .set("Authorization", "jwt " + ownerToken)
            .set("Content-Type", "application/octet-stream")
            .send(Buffer.from("hello world"));

        expect(result.status).toBe(400);
    });

    it("Uses the first value of mimeType/contentId when the client repeats the query parameter (arriving as an array).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const message = await createMessage(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .post(
                `${baseUrl}/upload?messageUid=${message.uid}` +
                    `&filename=test.txt&mimeType=text/plain&mimeType=text/html&contentId=cid-1&contentId=cid-2`,
            )
            .set("Authorization", "jwt " + ownerToken)
            .set("Content-Type", "application/octet-stream")
            .send(Buffer.from("hello world"));

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.mimeType).toBe("text/plain");
        expect(result.body.contentId).toBe("cid-1");
    });

    it("Falls back to application/octet-stream when mimeType is omitted entirely.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const message = await createMessage(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .post(`${baseUrl}/upload?messageUid=${message.uid}&filename=test.txt`)
            .set("Authorization", "jwt " + ownerToken)
            .set("Content-Type", "application/octet-stream")
            .send(Buffer.from("hello world"));

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.mimeType).toBe("application/octet-stream");
    });

    it("A different user cannot upload an attachment to a message in a folder they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const message = await createMessage(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .post(`${baseUrl}/upload?messageUid=${message.uid}&filename=test.txt&mimeType=text/plain`)
            .set("Authorization", "jwt " + otherUserToken)
            .set("Content-Type", "application/octet-stream")
            .send(Buffer.from("hello world"));

        expect(result.status).toBe(403);
    });

    it("Cannot upload an attachment by supplying a spoofed folderUid/mailboxUid for a message in another mailbox (cross-mailbox attachment planting).", async () => {
        // Regression test: `upload()` used to trust client-supplied folderUid/mailboxUid outright, only
        // checking CREATE permission against the (attacker-controlled) folderUid value - letting a caller with
        // access to their OWN folder attach content to a `messageUid` belonging to a completely different
        // mailbox by simply asserting whatever folderUid/mailboxUid they liked. Confirms the caller's own
        // folder/mailbox uids, even though otherwise valid and CREATE-permitted, have no effect: only the
        // ownership of the target message (resolved server-side) is what's checked.
        const victimMailbox = await createMailbox(otherUser.uid);
        const victimFolder = await createFolder(victimMailbox.uid);
        const victimMessage = await createMessage(victimMailbox.uid, victimFolder.uid);
        const attackerMailbox = await createMailbox(owner.uid);
        const attackerFolder = await createFolder(attackerMailbox.uid);

        const result = await request(server.getApplication())
            .post(
                `${baseUrl}/upload?messageUid=${victimMessage.uid}&folderUid=${attackerFolder.uid}` +
                    `&mailboxUid=${attackerMailbox.uid}&filename=test.txt&mimeType=text/plain`,
            )
            .set("Authorization", "jwt " + ownerToken)
            .set("Content-Type", "application/octet-stream")
            .send(Buffer.from("hello world"));

        expect(result.status).toBe(403);
    });

    it("Owner can download an attachment's content.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const attachment = await createAttachment(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${attachment.uid}/content`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.text).toBe("attachment content");
        expect(result.headers["content-type"]).toBe("text/plain");
    });

    it("A different user cannot download an attachment's content they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const attachment = await createAttachment(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${attachment.uid}/content`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(404);
    });

    it("Downloading a nonexistent attachment returns 404.", async () => {
        const result = await request(server.getApplication())
            .get(`${baseUrl}/${uuid.v4()}/content`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(404);
    });

    it("Sets a content-disposition of 'inline' for an inline attachment.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const attachment = await createAttachment(mailbox.uid, folder.uid, { isInline: true });

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${attachment.uid}/content`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.headers["content-disposition"]).toContain("inline");
    });

    it("Owner can list attachments scoped to a folder they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        await createAttachment(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.length).toBe(1);
    });

    it("Owner can delete an attachment they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const attachment = await createAttachment(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${attachment.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);

        const existing = await attachmentRepo.findOne({ uid: attachment.uid } as any);
        expect(existing).toBeNull();
    });
});
