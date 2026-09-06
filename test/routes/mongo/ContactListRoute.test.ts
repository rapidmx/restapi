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
} from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { ContactListMongo } from "../../../src/models/mongo/ContactListMongo.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:ContactListMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/contact-lists";
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let contactListRepo: MongoRepository<ContactListMongo>;
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

    const createContactList = async function (mailboxUid: string, data?: any): Promise<ContactListMongo> {
        const obj: ContactListMongo = new ContactListMongo({
            mailboxUid,
            name: "Friends",
            ...data,
        });
        return await contactListRepo.save(obj);
        // Deliberately no ACL document created — ContactList has `recordACL: false`; permission is checked
        // directly against the owning mailbox's ACL (its scopeProperty is `mailboxUid`, not `folderUid`).
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
            contactListRepo = conn.getMongoRepository("ContactListMongo");
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
        for (const repo of [mailboxRepo, contactListRepo]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
    });

    it("Requires an explicit mailboxUid query parameter to list contact lists.", async () => {
        const result = await request(server.getApplication())
            .get(baseUrl)
            .set("Authorization", "jwt " + ownerToken);
        expect(result.status).toBe(400);
    });

    it("Owner can list contact lists in a mailbox they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        await createContactList(mailbox.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?mailboxUid=${mailbox.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.length).toBe(1);
        expect(result.body[0].name).toBe("Friends");
    });

    it("A different user cannot list contact lists in a mailbox they don't have access to (silently empty).", async () => {
        const mailbox = await createMailbox(owner.uid);
        await createContactList(mailbox.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?mailboxUid=${mailbox.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(200);
        expect(result.body).toEqual([]);
    });

    it("Owner can create a contact list in a mailbox they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send({
                mailboxUid: mailbox.uid,
                name: "New List",
            });

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.name).toBe("New List");

        // No per-record ACL should have been created for this contact list (recordACL: false).
        const acl = await aclRepo.findOne({ uid: result.body.uid } as any);
        expect(acl).toBeNull();
    });

    it("A different user cannot create a contact list in a mailbox they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + otherUserToken)
            .send({
                mailboxUid: mailbox.uid,
                name: "Intruder List",
            });

        expect(result.status).toBe(403);
    });

    it("Owner can read a contact list by id.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const contactList = await createContactList(mailbox.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${contactList.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.uid).toBe(contactList.uid);
    });

    it("A different user cannot read a contact list by id (404, not 403 — avoids existence leakage).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const contactList = await createContactList(mailbox.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${contactList.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(404);
    });

    it("A different user gets 404 (not 200/1) checking existence of a contact list they can't access.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const contactList = await createContactList(mailbox.uid);

        const result = await request(server.getApplication())
            .head(`${baseUrl}/${contactList.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(404);
    });

    it("Owner can update a contact list they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const contactList = await createContactList(mailbox.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${contactList.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: contactList.uid, version: contactList.version, name: "Renamed" });

        expect(result.status).toBe(200);
        expect(result.body.name).toBe("Renamed");
    });

    it("A different user cannot update a contact list they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const contactList = await createContactList(mailbox.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${contactList.uid}`)
            .set("Authorization", "jwt " + otherUserToken)
            .send({ uid: contactList.uid, version: contactList.version, name: "Hijacked" });

        expect(result.status).toBe(403);
    });

    it("Owner can delete a contact list they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const contactList = await createContactList(mailbox.uid);

        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${contactList.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);

        const existing = await contactListRepo.findOne({ uid: contactList.uid } as any);
        expect(existing).toBeNull();
    });

    it("Can make a count request scoped to a mailbox the caller has access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        await createContactList(mailbox.uid);
        await createContactList(mailbox.uid);

        const result = await request(server.getApplication())
            .head(`${baseUrl}?mailboxUid=${mailbox.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.headers["content-length"]).toBe("2");
    });

    it("A different user's count request for a mailbox they can't access returns 0.", async () => {
        const mailbox = await createMailbox(owner.uid);
        await createContactList(mailbox.uid);

        const result = await request(server.getApplication())
            .head(`${baseUrl}?mailboxUid=${mailbox.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(200);
        expect(result.headers["content-length"]).toBe("0");
    });
});
