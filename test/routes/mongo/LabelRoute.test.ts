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
import { LabelMongo } from "../../../src/models/mongo/LabelMongo.js";
import { MessageMongo } from "../../../src/models/mongo/MessageMongo.js";
import { RecipientType } from "../../../src/models/types.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:LabelMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/labels";
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let labelRepo: MongoRepository<LabelMongo>;
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
            records: [{ userOrRoleId: ownerUid, actions: [ACLAction.FULL] }],
            parentUid: "Mailbox",
        });
        return result;
    };

    const createLabel = async function (mailboxUid: string, data?: any): Promise<LabelMongo> {
        const obj: LabelMongo = new LabelMongo({
            mailboxUid,
            name: "Important",
            ...data,
        });
        return await labelRepo.save(obj);
        // Deliberately no ACL document created — Label has `recordACL: false`; permission is checked
        // directly against the owning mailbox's ACL (its scopeProperty is `mailboxUid`, not `folderUid`).
    };

    const createMessage = async function (mailboxUid: string, data?: any): Promise<MessageMongo> {
        const obj: MessageMongo = new MessageMongo({
            folderUid: uuid.v4(),
            mailboxUid,
            messageId: `${uuid.v4()}@example.com`,
            subject: "Test message",
            from: { address: "sender@example.com", type: RecipientType.TO },
            bodyBlobKey: "raw/test",
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
            labelRepo = conn.getMongoRepository("LabelMongo");
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
        for (const repo of [mailboxRepo, labelRepo, messageRepo]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
    });

    it("Requires an explicit mailboxUid query parameter to list labels.", async () => {
        const result = await request(server.getApplication())
            .get(baseUrl)
            .set("Authorization", "jwt " + ownerToken);
        expect(result.status).toBe(400);
    });

    it("Owner can list labels in a mailbox they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        await createLabel(mailbox.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?mailboxUid=${mailbox.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.length).toBe(1);
        expect(result.body[0].name).toBe("Important");
    });

    it("A different user cannot list labels in a mailbox they don't have access to (silently empty).", async () => {
        const mailbox = await createMailbox(owner.uid);
        await createLabel(mailbox.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?mailboxUid=${mailbox.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(200);
        expect(result.body).toEqual([]);
    });

    it("Owner can create a label with a color in a mailbox they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send({
                mailboxUid: mailbox.uid,
                name: "Work",
                color: "#ff0000",
            });

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.name).toBe("Work");
        expect(result.body.color).toBe("#ff0000");

        // No per-record ACL should have been created for this label (recordACL: false).
        const acl = await aclRepo.findOne({ uid: result.body.uid } as any);
        expect(acl).toBeNull();
    });

    it("A different user cannot create a label in a mailbox they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + otherUserToken)
            .send({
                mailboxUid: mailbox.uid,
                name: "Intruder Label",
            });

        expect(result.status).toBe(403);
    });

    it("Owner can read a label by id.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const label = await createLabel(mailbox.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${label.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.uid).toBe(label.uid);
    });

    it("A different user cannot read a label by id (404, not 403 — avoids existence leakage).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const label = await createLabel(mailbox.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${label.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(404);
    });

    it("Owner can update a label they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const label = await createLabel(mailbox.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${label.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: label.uid, version: label.version, name: "Renamed" });

        expect(result.status).toBe(200);
        expect(result.body.name).toBe("Renamed");
    });

    it("A different user cannot update a label they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const label = await createLabel(mailbox.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${label.uid}`)
            .set("Authorization", "jwt " + otherUserToken)
            .send({ uid: label.uid, version: label.version, name: "Hijacked" });

        expect(result.status).toBe(403);
    });

    it("Owner can delete a label they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const label = await createLabel(mailbox.uid);

        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${label.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);

        const existing = await labelRepo.findOne({ uid: label.uid } as any);
        expect(existing).toBeNull();
    });

    it("A different user cannot delete a label they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const label = await createLabel(mailbox.uid);

        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${label.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(403);
    });

    it("Deleting a label strips its uid from every message in the mailbox that referenced it, leaving other labels/messages untouched.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const label = await createLabel(mailbox.uid);
        const otherLabel = await createLabel(mailbox.uid, { name: "Other" });

        const taggedMessage = await createMessage(mailbox.uid, { labelUids: [label.uid, otherLabel.uid] });
        const untaggedMessage = await createMessage(mailbox.uid, { labelUids: [otherLabel.uid] });

        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${label.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);

        const updatedTagged = await messageRepo.findOne({ uid: taggedMessage.uid } as any);
        expect(updatedTagged?.labelUids).toEqual([otherLabel.uid]);

        const updatedUntagged = await messageRepo.findOne({ uid: untaggedMessage.uid } as any);
        expect(updatedUntagged?.labelUids).toEqual([otherLabel.uid]);
    });

    it("Deleting a label does not affect messages in a different mailbox.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const otherMailbox = await createMailbox(owner.uid);
        const label = await createLabel(mailbox.uid);

        const otherMailboxMessage = await createMessage(otherMailbox.uid, { labelUids: [label.uid] });

        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${label.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);

        const unchanged = await messageRepo.findOne({ uid: otherMailboxMessage.uid } as any);
        expect(unchanged?.labelUids).toEqual([label.uid]);
    });

    it("Can make a count request scoped to a mailbox the caller has access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        await createLabel(mailbox.uid);
        await createLabel(mailbox.uid, { name: "Second" });

        const result = await request(server.getApplication())
            .head(`${baseUrl}?mailboxUid=${mailbox.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.headers["content-length"]).toBe("2");
    });

    it("A different user's count request for a mailbox they can't access returns 0.", async () => {
        const mailbox = await createMailbox(owner.uid);
        await createLabel(mailbox.uid);

        const result = await request(server.getApplication())
            .head(`${baseUrl}?mailboxUid=${mailbox.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(200);
        expect(result.headers["content-length"]).toBe("0");
    });
});
