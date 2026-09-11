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
import { LabelSQL } from "../../../src/models/sql/LabelSQL.js";
import { MessageSQL } from "../../../src/models/sql/MessageSQL.js";
import { RecipientType } from "../../../src/models/types.js";
import { registerTestDoubles } from "../../testDoubles.js";

describe("Route:LabelSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/labels";
    let mailboxRepo: Repository<MailboxSQL>;
    let labelRepo: Repository<LabelSQL>;
    let messageRepo: Repository<MessageSQL>;
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

    const createLabel = async function (mailboxUid: string, data?: any): Promise<LabelSQL> {
        const obj: LabelSQL = new LabelSQL({
            mailboxUid,
            name: "Important",
            ...data,
        });
        return await labelRepo.save(obj);
        // Deliberately no ACL document created — Label has `recordACL: false`; permission is checked
        // directly against the owning mailbox's ACL (its scopeProperty is `mailboxUid`, not `folderUid`).
    };

    const createMessage = async function (mailboxUid: string, data?: any): Promise<MessageSQL> {
        const obj: MessageSQL = new MessageSQL({
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
            labelRepo = conn.getRepository(LabelSQL);
            messageRepo = conn.getRepository(MessageSQL);
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
        await labelRepo.clear();
        await mailboxRepo.clear();
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
        const acl = await aclRepo.findOne({ where: { uid: result.body.uid } });
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

        const existing = await labelRepo.findOne({ where: { uid: label.uid } });
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

        const updatedTagged = await messageRepo.findOne({ where: { uid: taggedMessage.uid } });
        expect(updatedTagged?.labelUids).toEqual([otherLabel.uid]);

        const updatedUntagged = await messageRepo.findOne({ where: { uid: untaggedMessage.uid } });
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

        const unchanged = await messageRepo.findOne({ where: { uid: otherMailboxMessage.uid } });
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
