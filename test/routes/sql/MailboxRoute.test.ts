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
import { registerTestDoubles } from "../../testDoubles.js";

describe("Route:MailboxSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/mailboxes";
    let repo: Repository<MailboxSQL>;
    let aclRepo: Repository<AccessControlListSQL>;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);
    const otherUser: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const otherUserToken = JWTUtils.createTokenSync(config.get("auth"), otherUser);
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

    const createMailboxSQL = async function (data?: any, ownerUid: string = owner.uid): Promise<MailboxSQL> {
        const obj: MailboxSQL = new MailboxSQL({
            ownerUserUid: ownerUid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Test Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
            ...data,
        });

        const result: MailboxSQL = await repo.save(obj);

        const records: ACLRecord[] = [
            {
                userOrRoleId: ownerUid,
                actions: [
                    ACLAction.COUNT,
                    ACLAction.CREATE,
                    ACLAction.DELETE,
                    ACLAction.EXISTS,
                    ACLAction.LIST,
                    ACLAction.READ,
                    ACLAction.TRUNCATE,
                    ACLAction.UPDATE,
                ],
            },
        ];

        await aclRepo.save({
            uid: result.uid,
            dateCreated: new Date(),
            dateModified: new Date(),
            version: 0,
            records,
            parentUid: "Mailbox",
        });

        return result;
    };

    // dateCreated, dateModified, uid and version are assigned by the server. `_id` never applies to a SQL
    // model but is harmless to keep excluded for parity with the Mongo original.
    const SERVER_ASSIGNED_FIELDS = ["uid", "dateCreated", "dateModified", "version", "_id"];

    const expectMatchingFields = function (actual: any, expected: any): void {
        for (const key in expected) {
            if (SERVER_ASSIGNED_FIELDS.includes(key)) {
                continue;
            }
            expect(actual[key]).toEqual(expected[key]);
        }
        expect(actual.uid).toBeDefined();
        expect(new Date(actual.dateCreated).getTime()).not.toBeNaN();
        expect(new Date(actual.dateModified).getTime()).not.toBeNaN();
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
            repo = conn.getRepository(MailboxSQL);
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await repo.clear();
    });

    it("Listing mailboxes anonymously (no Authorization header) returns an empty list, not another user's data.", async () => {
        await createMailboxSQL();
        const result = await request(server.getApplication()).get(baseUrl);
        expect(result.status).toBe(200);
        expect(result.body).toEqual([]);
    });

    it("Can create a mailbox as any authenticated user, and it is automatically owned by the creator.", async () => {
        const obj: MailboxSQL = new MailboxSQL({
            ownerUserUid: owner.uid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: ["alias@example.com"],
            displayName: "My Mailbox",
            timezone: "America/Los_Angeles",
            quotaBytes: 5_000_000_000,
            usedBytes: 0,
        });

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send(obj);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expectMatchingFields(result.body, obj);

        const existing: MailboxSQL | null = await repo.findOne({ where: { uid: result.body.uid } });
        expect(existing).toBeDefined();
        if (existing) {
            expectMatchingFields(existing, obj);
        }
    });

    it("Owner can read their own mailbox by id.", async () => {
        const obj = await createMailboxSQL();

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${obj.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expectMatchingFields(result.body, obj);
    });

    it("A different authenticated user cannot read someone else's mailbox by id (record-level ACL denies it, native 403).", async () => {
        const obj = await createMailboxSQL();

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${obj.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(403);
    });

    it("A different authenticated user's list of mailboxes does not include another user's mailbox.", async () => {
        await createMailboxSQL({ displayName: "Owner's mailbox" });
        await createMailboxSQL({ displayName: "Other user's mailbox" }, otherUser.uid);

        const result = await request(server.getApplication())
            .get(baseUrl)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(Array.isArray(result.body)).toBe(true);
        expect(result.body.length).toBe(1);
        expect(result.body[0].displayName).toBe("Owner's mailbox");
    });

    it("Owner can update their own mailbox.", async () => {
        const obj = await createMailboxSQL();

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${obj.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: obj.uid, version: obj.version, displayName: "Renamed Mailbox" });

        expect(result.status).toBe(200);
        expect(result.body.displayName).toBe("Renamed Mailbox");
    });

    it("A different authenticated user cannot update someone else's mailbox.", async () => {
        const obj = await createMailboxSQL();

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${obj.uid}`)
            .set("Authorization", "jwt " + otherUserToken)
            .send({ uid: obj.uid, version: obj.version, displayName: "Hijacked" });

        expect(result.status).toBe(403);
    });

    it("Owner can delete their own mailbox.", async () => {
        const obj = await createMailboxSQL();

        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${obj.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);

        const existing: MailboxSQL | null = await repo.findOne({ where: { uid: obj.uid } });
        expect(existing).toBeNull();
    });

    it("Can make a count request scoped to the caller's own mailboxes.", async () => {
        await createMailboxSQL();
        await createMailboxSQL();
        await createMailboxSQL({}, otherUser.uid);

        const result = await request(server.getApplication())
            .head(baseUrl)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.headers["content-length"]).toBe("2");
    });

    it("A caller with a delegate ACL grant (not owner) sees a shared mailbox in their list, alongside their own.", async () => {
        await createMailboxSQL({ displayName: "Owner's own mailbox" });
        const shared = await createMailboxSQL({ displayName: "Shared Mailbox" }, otherUser.uid);

        const acl: any = await aclRepo.findOne({ where: { uid: shared.uid } });
        acl.records.push({ userOrRoleId: owner.uid, actions: [ACLAction.READ, ACLAction.LIST] });
        await aclRepo.save(acl);

        const result = await request(server.getApplication())
            .get(baseUrl)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        const names = result.body.map((m: any) => m.displayName).sort();
        expect(names).toEqual(["Owner's own mailbox", "Shared Mailbox"]);
    });

    it("A trusted (admin) caller's list includes every mailbox, not just their own.", async () => {
        await createMailboxSQL({ displayName: "Owner's mailbox" });
        await createMailboxSQL({ displayName: "Other user's mailbox" }, otherUser.uid);

        const result = await request(server.getApplication())
            .get(baseUrl)
            .set("Authorization", "jwt " + adminToken);

        expect(result.status).toBe(200);
        const names = result.body.map((m: any) => m.displayName).sort();
        expect(names).toEqual(["Other user's mailbox", "Owner's mailbox"]);
    });

    it("A trusted (admin) caller's count includes every mailbox, not just their own.", async () => {
        await createMailboxSQL();
        await createMailboxSQL({}, otherUser.uid);

        const result = await request(server.getApplication())
            .head(baseUrl)
            .set("Authorization", "jwt " + adminToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.headers["content-length"]).toBe("2");
    });

    it("A non-trusted caller's ownerUserUid is always forced to their own uid, even if the request body claims another.", async () => {
        const obj: MailboxSQL = new MailboxSQL({
            ownerUserUid: otherUser.uid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Claimed Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send(obj);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.ownerUserUid).toBe(owner.uid);
    });

    it("A trusted (admin) caller can create a true ownerless shared mailbox by omitting ownerUserUid.", async () => {
        const obj: any = {
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Shared Support Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        };

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send(obj);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.ownerUserUid == null).toBe(true);

        // The admin who created it shouldn't be left with a stray self-grant on its ACL either.
        const acl: any = await aclRepo.findOne({ where: { uid: result.body.uid } });
        expect(acl?.records ?? []).toEqual([]);
    });

    it("An admin can still create a mailbox for themselves like any other authenticated user.", async () => {
        const obj: MailboxSQL = new MailboxSQL({
            ownerUserUid: admin.uid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Admin Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send(obj);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expectMatchingFields(result.body, obj);
    });
});
