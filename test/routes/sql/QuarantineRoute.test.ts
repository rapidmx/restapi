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
import { QuarantineEntrySQL } from "../../../src/models/sql/QuarantineEntrySQL.js";
import { QuarantineReason } from "../../../src/models/types.js";
import { registerTestDoubles } from "../../testDoubles.js";

describe("Route:QuarantineSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/quarantine";
    let mailboxRepo: Repository<MailboxSQL>;
    let quarantineRepo: Repository<QuarantineEntrySQL>;
    let aclRepo: Repository<AccessControlListSQL>;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);
    const otherUser: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const otherUserToken = JWTUtils.createTokenSync(config.get("auth"), otherUser);
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

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
        } as any);
        return result;
    };

    const createQuarantineEntry = async function (mailboxUid: string, data?: any): Promise<QuarantineEntrySQL> {
        const obj: QuarantineEntrySQL = new QuarantineEntrySQL({
            mailboxUid,
            reason: QuarantineReason.SPAM_POLICY,
            scanResultUid: uuid.v4(),
            rawBlobKey: uuid.v4(),
            ...data,
        });
        return await quarantineRepo.save(obj);
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
            quarantineRepo = conn.getRepository(QuarantineEntrySQL);
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await quarantineRepo.clear();
        await mailboxRepo.clear();
    });

    it("Requires an explicit mailboxUid query parameter to list quarantine entries.", async () => {
        const result = await request(server.getApplication())
            .get(baseUrl)
            .set("Authorization", "jwt " + ownerToken);
        expect(result.status).toBe(400);
    });

    it("Owner can list quarantine entries in a mailbox they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        await createQuarantineEntry(mailbox.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?mailboxUid=${mailbox.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.length).toBe(1);
    });

    it("A different user cannot list quarantine entries in a mailbox they don't have access to (silently empty).", async () => {
        const mailbox = await createMailbox(owner.uid);
        await createQuarantineEntry(mailbox.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?mailboxUid=${mailbox.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(200);
        expect(result.body).toEqual([]);
    });

    it("A trusted (admin) caller can list quarantine entries in any mailbox.", async () => {
        const mailbox = await createMailbox(owner.uid);
        await createQuarantineEntry(mailbox.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?mailboxUid=${mailbox.uid}`)
            .set("Authorization", "jwt " + adminToken);

        expect(result.status).toBe(200);
        expect(result.body.length).toBe(1);
    });

    it("Owner can 'release' a quarantine entry via a normal update.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const entry = await createQuarantineEntry(mailbox.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${entry.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: entry.uid, version: entry.version, releasedAt: new Date().toISOString(), releasedByUserUid: owner.uid });

        expect(result.status).toBe(200);
        expect(result.body.releasedByUserUid).toBe(owner.uid);
        expect(result.body.releasedAt).toBeDefined();
    });

    it("A different user cannot release a quarantine entry they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const entry = await createQuarantineEntry(mailbox.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${entry.uid}`)
            .set("Authorization", "jwt " + otherUserToken)
            .send({ uid: entry.uid, version: entry.version, releasedByUserUid: otherUser.uid });

        expect(result.status).toBe(403);
    });

    it("Can make a count request scoped to a mailbox the caller has access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        await createQuarantineEntry(mailbox.uid);
        await createQuarantineEntry(mailbox.uid);

        const result = await request(server.getApplication())
            .head(`${baseUrl}?mailboxUid=${mailbox.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.headers["content-length"]).toBe("2");
    });
});
