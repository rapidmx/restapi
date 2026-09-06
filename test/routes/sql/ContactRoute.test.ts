///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { request } from "@rapidrest/service-core/test";
import {
    ACLRecord,
    Server,
    ObjectFactory,
    ConnectionManager,
    ACLAction,
    AccessControlListSQL,
    isSqlDataSource,
} from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { FolderSQL } from "../../../src/models/sql/FolderSQL.js";
import { ContactSQL } from "../../../src/models/sql/ContactSQL.js";
import { ContactAddressKind, FolderType } from "../../../src/models/types.js";
import { registerTestDoubles } from "../../testDoubles.js";

describe("Route:ContactSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/contacts";
    let mailboxRepo: Repository<MailboxSQL>;
    let folderRepo: Repository<FolderSQL>;
    let contactRepo: Repository<ContactSQL>;
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
            records: [{ userOrRoleId: ownerUid, actions: [ACLAction.FULL] }],
            parentUid: "Mailbox",
        });
        return result;
    };

    const createFolder = async function (mailboxUid: string, data?: any): Promise<FolderSQL> {
        const obj: FolderSQL = new FolderSQL({
            mailboxUid,
            name: "Contacts",
            type: FolderType.CONTACTS,
            unreadCount: 0,
            totalCount: 0,
            syncKeyVersion: 0,
            ...data,
        });
        const result: FolderSQL = await folderRepo.save(obj);
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

    const createContact = async function (mailboxUid: string, folderUid: string, data?: any): Promise<ContactSQL> {
        const obj: ContactSQL = new ContactSQL({
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
            contactRepo = conn.getRepository(ContactSQL);
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await contactRepo.clear();
        await folderRepo.clear();
        await mailboxRepo.clear();
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
        const acl = await aclRepo.findOne({ where: { uid: result.body.uid } });
        expect(acl).toBeNull();
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

    it("A different user cannot read a contact by id (404, not 403 — avoids existence leakage).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const contact = await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${contact.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

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
        const existing = await contactRepo.findOne({ where: { uid: contact.uid } });
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

    it("Owner can delete a contact they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const contact = await createContact(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${contact.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);

        // See the identical note in test/routes/mongo/ContactRoute.test.ts - `Contact` is now a
        // `RecoverableBaseEntity` (soft delete), so the raw row stays present with `deleted: true`.
        const existing = await contactRepo.findOne({ where: { uid: contact.uid } });
        expect(existing?.deleted).toBe(true);
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
