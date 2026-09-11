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
import { MailFilterRuleSQL } from "../../../src/models/sql/MailFilterRuleSQL.js";
import { MailFilterActionType } from "../../../src/models/types.js";
import { registerTestDoubles } from "../../testDoubles.js";

describe("Route:MailFilterRuleSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/mail-filter-rules";
    let mailboxRepo: Repository<MailboxSQL>;
    let mailFilterRuleRepo: Repository<MailFilterRuleSQL>;
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

    const createRule = async function (mailboxUid: string, data?: any): Promise<MailFilterRuleSQL> {
        const obj: MailFilterRuleSQL = new MailFilterRuleSQL({
            mailboxUid,
            name: "Move newsletters",
            enabled: true,
            sequence: 0,
            stopProcessingRules: false,
            conditions: { subjectContains: ["newsletter"] },
            actions: [{ type: MailFilterActionType.MARK_AS_READ }],
            ...data,
        });
        return await mailFilterRuleRepo.save(obj);
        // Deliberately no ACL document created — MailFilterRule has `recordACL: false`; permission is checked
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
            mailFilterRuleRepo = conn.getRepository(MailFilterRuleSQL);
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await mailFilterRuleRepo.clear();
        await mailboxRepo.clear();
    });

    it("Requires an explicit mailboxUid query parameter to list rules.", async () => {
        const result = await request(server.getApplication())
            .get(baseUrl)
            .set("Authorization", "jwt " + ownerToken);
        expect(result.status).toBe(400);
    });

    it("Owner can list rules in a mailbox they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        await createRule(mailbox.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?mailboxUid=${mailbox.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.length).toBe(1);
        expect(result.body[0].name).toBe("Move newsletters");
    });

    it("A different user cannot list rules in a mailbox they don't have access to (silently empty).", async () => {
        const mailbox = await createMailbox(owner.uid);
        await createRule(mailbox.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?mailboxUid=${mailbox.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(200);
        expect(result.body).toEqual([]);
    });

    it("Owner can create a rule in a mailbox they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send({
                mailboxUid: mailbox.uid,
                name: "Delete spammy senders",
                enabled: true,
                sequence: 1,
                stopProcessingRules: true,
                conditions: { fromContains: ["spam@example.com"] },
                actions: [{ type: MailFilterActionType.DELETE }],
            });

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.name).toBe("Delete spammy senders");
        expect(result.body.actions).toEqual([{ type: MailFilterActionType.DELETE }]);

        // No per-record ACL should have been created for this rule (recordACL: false).
        const acl = await aclRepo.findOne({ where: { uid: result.body.uid } });
        expect(acl).toBeNull();
    });

    it("Rejects creating a rule with an explicit empty name (400) - proves model validation actually runs on create().", async () => {
        const mailbox = await createMailbox(owner.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send({
                mailboxUid: mailbox.uid,
                name: "",
                enabled: true,
                sequence: 1,
                stopProcessingRules: true,
                conditions: {},
                actions: [],
            });

        expect(result.status).toBe(400);
    });

    it("A different user cannot create a rule in a mailbox they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + otherUserToken)
            .send({
                mailboxUid: mailbox.uid,
                name: "Intruder rule",
                enabled: true,
                sequence: 0,
                stopProcessingRules: false,
                conditions: {},
                actions: [],
            });

        expect(result.status).toBe(403);
    });

    it("Owner can read a rule by id.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const rule = await createRule(mailbox.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${rule.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.uid).toBe(rule.uid);
    });

    it("A different user cannot read a rule by id (404, not 403 — avoids existence leakage).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const rule = await createRule(mailbox.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${rule.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(404);
    });

    it("Owner can update a rule they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const rule = await createRule(mailbox.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${rule.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: rule.uid, version: rule.version, enabled: false });

        expect(result.status).toBe(200);
        expect(result.body.enabled).toBe(false);
    });

    it("A different user cannot update a rule they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const rule = await createRule(mailbox.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${rule.uid}`)
            .set("Authorization", "jwt " + otherUserToken)
            .send({ uid: rule.uid, version: rule.version, enabled: false });

        expect(result.status).toBe(403);
    });

    it("Owner can delete a rule they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const rule = await createRule(mailbox.uid);

        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${rule.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);

        const existing = await mailFilterRuleRepo.findOne({ where: { uid: rule.uid } });
        expect(existing).toBeNull();
    });
});
