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
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { FolderSQL } from "../../../src/models/sql/FolderSQL.js";
import { MessageSQL } from "../../../src/models/sql/MessageSQL.js";
import { AttachmentSQL } from "../../../src/models/sql/AttachmentSQL.js";
import { FolderType, MessageImportance, RecipientType } from "../../../src/models/types.js";
import { registerTestDoubles, InMemoryBlobStore } from "../../testDoubles.js";

describe("Route:AttachmentSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/attachments";
    let mailboxRepo: Repository<MailboxSQL>;
    let folderRepo: Repository<FolderSQL>;
    let messageRepo: Repository<MessageSQL>;
    let attachmentRepo: Repository<AttachmentSQL>;
    let aclRepo: Repository<AccessControlListSQL>;

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

    const createFolder = async function (mailboxUid: string): Promise<FolderSQL> {
        const obj: FolderSQL = new FolderSQL({
            mailboxUid,
            name: "Inbox",
            type: FolderType.INBOX,
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

    const createAttachment = async function (mailboxUid: string, folderUid: string, data?: any): Promise<AttachmentSQL> {
        const blobStore: InMemoryBlobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const blobKey = `attachments/${uuid.v4()}`;
        await blobStore.put(blobKey, Buffer.from("attachment content"));
        const obj: AttachmentSQL = new AttachmentSQL({
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
            attachmentRepo = conn.getRepository(AttachmentSQL);
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await attachmentRepo.clear();
        await messageRepo.clear();
        await folderRepo.clear();
        await mailboxRepo.clear();
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

    it("Rejects an upload whose messageUid doesn't correspond to any real message.", async () => {
        const result = await request(server.getApplication())
            .post(`${baseUrl}/upload?messageUid=${uuid.v4()}&filename=test.txt&mimeType=text/plain`)
            .set("Authorization", "jwt " + ownerToken)
            .set("Content-Type", "application/octet-stream")
            .send(Buffer.from("hello world"));

        expect(result.status).toBe(400);
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

        const existing = await attachmentRepo.findOne({ where: { uid: attachment.uid } });
        expect(existing).toBeNull();
    });
});
