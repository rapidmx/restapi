///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { request } from "@rapidrest/service-core/test";
import { Server, ObjectFactory, ConnectionManager, ACLAction, AccessControlListSQL, isSqlDataSource } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { MailSignatureSQL } from "../../../src/models/sql/MailSignatureSQL.js";
import { registerTestDoubles } from "../../testDoubles.js";

describe("Route:MailSignatureSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/mail-signatures";
    let mailboxRepo: Repository<MailboxSQL>;
    let mailSignatureRepo: Repository<MailSignatureSQL>;
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

    const createSignature = async function (mailboxUid: string, data?: any): Promise<MailSignatureSQL> {
        const obj: MailSignatureSQL = new MailSignatureSQL({
            mailboxUid,
            name: "Work",
            contentHtml: "<p>Thanks,<br/>Jane</p>",
            isDefaultForNewMessages: true,
            isDefaultForReplyForward: false,
            ...data,
        });
        return await mailSignatureRepo.save(obj);
        // Deliberately no ACL document created — MailSignature has `recordACL: false`; permission is checked
        // directly against the owning mailbox's ACL (its scopeProperty is `mailboxUid`, not `folderUid`).
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
            mailSignatureRepo = conn.getRepository(MailSignatureSQL);
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await mailSignatureRepo.clear();
        await mailboxRepo.clear();
    });

    it("Requires an explicit mailboxUid query parameter to list signatures.", async () => {
        const result = await request(server.getApplication())
            .get(baseUrl)
            .set("Authorization", "jwt " + ownerToken);
        expect(result.status).toBe(400);
    });

    it("Owner can list signatures in a mailbox they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        await createSignature(mailbox.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?mailboxUid=${mailbox.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.length).toBe(1);
        expect(result.body[0].name).toBe("Work");
    });

    it("A different user cannot list signatures in a mailbox they don't have access to (silently empty).", async () => {
        const mailbox = await createMailbox(owner.uid);
        await createSignature(mailbox.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?mailboxUid=${mailbox.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(200);
        expect(result.body).toEqual([]);
    });

    it("Owner can create a signature in a mailbox they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send({
                mailboxUid: mailbox.uid,
                name: "Personal",
                contentHtml: "<p>Cheers</p>",
                isDefaultForNewMessages: false,
                isDefaultForReplyForward: true,
            });

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.name).toBe("Personal");
        expect(result.body.isDefaultForReplyForward).toBe(true);

        // No per-record ACL should have been created for this signature (recordACL: false).
        const acl = await aclRepo.findOne({ where: { uid: result.body.uid } });
        expect(acl).toBeNull();
    });

    it("Rejects creating a signature with an explicit empty name (400) - proves model validation actually runs on create().", async () => {
        const mailbox = await createMailbox(owner.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send({
                mailboxUid: mailbox.uid,
                name: "",
                contentHtml: "<p>Cheers</p>",
                isDefaultForNewMessages: false,
                isDefaultForReplyForward: false,
            });

        expect(result.status).toBe(400);
    });

    it("A different user cannot create a signature in a mailbox they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + otherUserToken)
            .send({
                mailboxUid: mailbox.uid,
                name: "Intruder signature",
                contentHtml: "",
                isDefaultForNewMessages: false,
                isDefaultForReplyForward: false,
            });

        expect(result.status).toBe(403);
    });

    it("Owner can read a signature by id.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const signature = await createSignature(mailbox.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${signature.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.uid).toBe(signature.uid);
    });

    it("A different user cannot read a signature by id (404, not 403 — avoids existence leakage).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const signature = await createSignature(mailbox.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${signature.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(404);
    });

    it("Owner can update a signature they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const signature = await createSignature(mailbox.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${signature.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: signature.uid, version: signature.version, contentHtml: "<p>Updated</p>" });

        expect(result.status).toBe(200);
        expect(result.body.contentHtml).toBe("<p>Updated</p>");
    });

    it("A different user cannot update a signature they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const signature = await createSignature(mailbox.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${signature.uid}`)
            .set("Authorization", "jwt " + otherUserToken)
            .send({ uid: signature.uid, version: signature.version, contentHtml: "<p>Hijacked</p>" });

        expect(result.status).toBe(403);
    });

    it("Owner can delete a signature they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const signature = await createSignature(mailbox.uid);

        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${signature.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);

        const existing = await mailSignatureRepo.findOne({ where: { uid: signature.uid } });
        expect(existing).toBeNull();
    });
});
