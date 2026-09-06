///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { request } from "@rapidrest/service-core/test";
import {
    ACLRecord,
    MongoConnection,
    MongoRepository,
    Server,
    ObjectFactory,
    ConnectionManager,
    ACLAction,
    NotificationUtils,
} from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { FolderMongo } from "../../../src/models/mongo/FolderMongo.js";
import { ContactMongo } from "../../../src/models/mongo/ContactMongo.js";
import { ContactAddressKind, FolderType } from "../../../src/models/types.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:ContactMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/contacts";
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let folderRepo: MongoRepository<FolderMongo>;
    let contactRepo: MongoRepository<ContactMongo>;
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
            records: [{ userOrRoleId: ownerUid, actions: [ACLAction.FULL] }],
            parentUid: "Mailbox",
        });
        return result;
    };

    const createFolder = async function (mailboxUid: string, data?: any): Promise<FolderMongo> {
        const obj: FolderMongo = new FolderMongo({
            mailboxUid,
            name: "Contacts",
            type: FolderType.CONTACTS,
            unreadCount: 0,
            totalCount: 0,
            syncKeyVersion: 0,
            ...data,
        });
        const result: FolderMongo = await folderRepo.save(obj);
        // No explicit records — inherits from the mailbox's ACL via parentUid, same as
        // `BaseFolderRoute.create()`'s own seeding.
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

    const createContact = async function (mailboxUid: string, folderUid: string, data?: any): Promise<ContactMongo> {
        const obj: ContactMongo = new ContactMongo({
            mailboxUid,
            folderUid,
            displayName: "Jane Doe",
            emails: [{ address: "jane@example.com", type: ContactAddressKind.WORK }],
            phones: [],
            addresses: [],
            ...data,
        });
        return await contactRepo.save(obj);
        // Deliberately no ACL document created — Contact has `recordACL: false`; permission is checked
        // against the containing folder's ACL instead.
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
            contactRepo = conn.getMongoRepository("ContactMongo");
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
        for (const repo of [mailboxRepo, folderRepo, contactRepo]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
    });

    it("Requires an explicit folderUid query parameter to list contacts.", async () => {
        const result = await request(server.getApplication())
            .get(baseUrl)
            .set("Authorization", "jwt " + ownerToken);
        expect(result.status).toBe(400);
    });

    it("Owner can list contacts in a folder they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.length).toBe(1);
        expect(result.body[0].displayName).toBe("Jane Doe");
    });

    it("A different user cannot list contacts in a folder they don't have access to (silently empty).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(200);
        expect(result.body).toEqual([]);
    });

    it("Owner can create a contact in a folder they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send({
                mailboxUid: mailbox.uid,
                folderUid: folder.uid,
                displayName: "New Contact",
                emails: [],
                phones: [],
                addresses: [],
            });

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.displayName).toBe("New Contact");

        // No per-record ACL should have been created for this contact (recordACL: false).
        const acl = await aclRepo.findOne({ uid: result.body.uid } as any);
        expect(acl).toBeNull();
    });

    it("Publishes a live-update notification to the folder's channel on create.", async () => {
        const sendMessageSpy = vi.spyOn(NotificationUtils.prototype, "sendMessage");
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send({
                mailboxUid: mailbox.uid,
                folderUid: folder.uid,
                displayName: "New Contact",
                emails: [],
                phones: [],
                addresses: [],
            });

        expect(sendMessageSpy).toHaveBeenCalledWith(
            folder.uid,
            "ContactMongo",
            "create",
            expect.objectContaining({ uid: result.body.uid }),
        );
        sendMessageSpy.mockRestore();
    });

    it("A different user cannot create a contact in a folder they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + otherUserToken)
            .send({
                mailboxUid: mailbox.uid,
                folderUid: folder.uid,
                displayName: "Intruder",
                emails: [],
                phones: [],
                addresses: [],
            });

        expect(result.status).toBe(403);
    });

    it("Owner can create multiple contacts in a single bulk (array-body) request when every item is permitted.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send([
                {
                    mailboxUid: mailbox.uid,
                    folderUid: folder.uid,
                    displayName: "Bulk One",
                    emails: [],
                    phones: [],
                    addresses: [],
                },
                {
                    mailboxUid: mailbox.uid,
                    folderUid: folder.uid,
                    displayName: "Bulk Two",
                    emails: [],
                    phones: [],
                    addresses: [],
                },
            ]);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(Array.isArray(result.body)).toBe(true);
        expect(result.body.map((c: any) => c.displayName).sort()).toEqual(["Bulk One", "Bulk Two"]);
    });

    it("A bulk (array-body) create is rejected with 403, creating none of them, when any single item's folder is one the caller can't access.", async () => {
        const ownedMailbox = await createMailbox(otherUser.uid);
        const ownedFolder = await createFolder(ownedMailbox.uid);
        const deniedMailbox = await createMailbox(owner.uid);
        const deniedFolder = await createFolder(deniedMailbox.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + otherUserToken)
            .send([
                {
                    mailboxUid: ownedMailbox.uid,
                    folderUid: ownedFolder.uid,
                    displayName: "Permitted",
                    emails: [],
                    phones: [],
                    addresses: [],
                },
                {
                    mailboxUid: deniedMailbox.uid,
                    folderUid: deniedFolder.uid,
                    displayName: "Not permitted",
                    emails: [],
                    phones: [],
                    addresses: [],
                },
            ]);

        expect(result.status).toBe(403);

        const count = await contactRepo.count({});
        expect(count).toBe(0);
    });

    it("Owner can read a contact by id.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const contact = await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${contact.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.uid).toBe(contact.uid);
    });

    it("Reading a nonexistent contact returns 404.", async () => {
        const result = await request(server.getApplication())
            .get(`${baseUrl}/${uuid.v4()}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(404);
    });

    it("A different user cannot read a contact by id (404, not 403 — avoids existence leakage).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const contact = await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${contact.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(404);
    });

    it("Owner sees a contact they have access to exists (200, content-length 1).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const contact = await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .head(`${baseUrl}/${contact.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.headers["content-length"]).toBe("1");
    });

    it("Checking existence of a nonexistent contact returns 404.", async () => {
        const result = await request(server.getApplication())
            .head(`${baseUrl}/${uuid.v4()}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(404);
    });

    it("A different user gets 404 (not 200/1) checking existence of a contact they can't access.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const contact = await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .head(`${baseUrl}/${contact.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(404);
    });

    it("Owner can update a contact they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const contact = await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${contact.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: contact.uid, version: contact.version, displayName: "Renamed" });

        expect(result.status).toBe(200);
        expect(result.body.displayName).toBe("Renamed");
    });

    it("A different user cannot update a contact they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const contact = await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${contact.uid}`)
            .set("Authorization", "jwt " + otherUserToken)
            .send({ uid: contact.uid, version: contact.version, displayName: "Hijacked" });

        expect(result.status).toBe(403);
    });

    it("Owner cannot re-parent a contact into a folder they don't have access to (folderUid change is permission-checked against the NEW scope, not just the old one).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const contact = await createContact(mailbox.uid, folder.uid);
        const otherMailbox = await createMailbox(otherUser.uid);
        const otherFolder = await createFolder(otherMailbox.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${contact.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: contact.uid, version: contact.version, folderUid: otherFolder.uid });

        expect(result.status).toBe(403);
        const existing = await contactRepo.findOne({ uid: contact.uid } as any);
        expect(existing!.folderUid).toBe(folder.uid);
    });

    it("Owner can re-parent a contact into another folder of their own they DO have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const destinationFolder = await createFolder(mailbox.uid);
        const contact = await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${contact.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: contact.uid, version: contact.version, folderUid: destinationFolder.uid });

        expect(result.status).toBe(200);
        expect(result.body.folderUid).toBe(destinationFolder.uid);
    });

    it("Publishes live-update notifications to BOTH the old and new folder channels when a re-parenting update moves a contact.", async () => {
        const sendMessageSpy = vi.spyOn(NotificationUtils.prototype, "sendMessage");
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const destinationFolder = await createFolder(mailbox.uid);
        const contact = await createContact(mailbox.uid, folder.uid);

        await request(server.getApplication())
            .put(`${baseUrl}/${contact.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: contact.uid, version: contact.version, folderUid: destinationFolder.uid });

        expect(sendMessageSpy).toHaveBeenCalledWith(
            destinationFolder.uid,
            "ContactMongo",
            "update",
            expect.objectContaining({ uid: contact.uid, folderUid: destinationFolder.uid }),
        );
        expect(sendMessageSpy).toHaveBeenCalledWith(folder.uid, "ContactMongo", "delete", { uid: contact.uid });
        sendMessageSpy.mockRestore();
    });

    it("Owner can delete a contact they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const contact = await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${contact.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);

        // `Contact` extends `RecoverableBaseEntity` (soft delete) so EAS `Sync` can later report the deletion
        // to an already-synced device - the row stays present with `deleted: true` rather than being
        // physically removed. See the identical note on `CalendarEventRoute.test.ts`.
        const existing = await contactRepo.findOne({ uid: contact.uid } as any);
        expect(existing?.deleted).toBe(true);
    });

    it("Publishes a live-update notification to the folder's channel on delete.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const contact = await createContact(mailbox.uid, folder.uid);
        const sendMessageSpy = vi.spyOn(NotificationUtils.prototype, "sendMessage");

        await request(server.getApplication())
            .delete(`${baseUrl}/${contact.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(sendMessageSpy).toHaveBeenCalledWith(folder.uid, "ContactMongo", "delete", { uid: contact.uid });
        sendMessageSpy.mockRestore();
    });

    it("Deleting a nonexistent contact returns 404.", async () => {
        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${uuid.v4()}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(404);
    });

    it("A different user cannot delete a contact they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const contact = await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${contact.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(403);

        const existing = await contactRepo.findOne({ uid: contact.uid } as any);
        expect(existing).toBeDefined();
    });

    it("Owner can update one property of a contact via updateProperty.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const contact = await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${contact.uid}/displayName`)
            .set("Authorization", "jwt " + ownerToken)
            .send("Renamed via property");

        expect(result.status).toBe(200);
        expect(result.body.displayName).toBe("Renamed via property");
    });

    it("Owner can update multiple contacts in a single bulk (array-body) PUT request.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const contactA = await createContact(mailbox.uid, folder.uid, { displayName: "A" });
        const contactB = await createContact(mailbox.uid, folder.uid, { displayName: "B" });

        const result = await request(server.getApplication())
            .put(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send([
                { uid: contactA.uid, version: contactA.version, displayName: "A Renamed" },
                { uid: contactB.uid, version: contactB.version, displayName: "B Renamed" },
            ]);

        expect(result.status).toBe(200);
        expect(Array.isArray(result.body)).toBe(true);
        expect(result.body.map((c: any) => c.displayName).sort()).toEqual(["A Renamed", "B Renamed"]);
    });

    it("Owner can truncate (bulk-delete) all contacts scoped to a folder they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        await createContact(mailbox.uid, folder.uid);
        await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .delete(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);

        const count = await contactRepo.count({ folderUid: folder.uid });
        expect(count).toBe(0);
    });

    it("A different user cannot truncate contacts in a folder they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .delete(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(403);

        const count = await contactRepo.count({ folderUid: folder.uid });
        expect(count).toBe(1);
    });

    it("Requires an explicit folderUid query parameter to count contacts.", async () => {
        const result = await request(server.getApplication())
            .head(baseUrl)
            .set("Authorization", "jwt " + ownerToken);
        expect(result.status).toBe(400);
    });

    it("Updating a nonexistent contact returns 404.", async () => {
        const result = await request(server.getApplication())
            .put(`${baseUrl}/${uuid.v4()}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: uuid.v4(), version: 0, displayName: "Ghost" });

        expect(result.status).toBe(404);
    });

    it("Updating one property of a nonexistent contact returns 404.", async () => {
        const result = await request(server.getApplication())
            .put(`${baseUrl}/${uuid.v4()}/displayName`)
            .set("Authorization", "jwt " + ownerToken)
            .send("Ghost");

        expect(result.status).toBe(404);
    });

    it("Can make a count request scoped to a folder the caller has access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        await createContact(mailbox.uid, folder.uid);
        await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .head(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.headers["content-length"]).toBe("2");
    });

    it("A different user's count request for a folder they can't access returns 0.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .head(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(200);
        expect(result.headers["content-length"]).toBe("0");
    });
});
