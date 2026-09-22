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
import { IngestQueueEntrySQL } from "../../../src/models/sql/IngestQueueEntrySQL.js";
import { IngestStatus } from "../../../src/models/types.js";
import { registerTestDoubles } from "../../testDoubles.js";

describe("Route:IngestQueueSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/ingest-queue";
    let mailboxRepo: Repository<MailboxSQL>;
    let ingestQueueRepo: Repository<IngestQueueEntrySQL>;
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

    const createIngestQueueEntry = async function (mailboxUid: string, data?: any): Promise<IngestQueueEntrySQL> {
        const obj: IngestQueueEntrySQL = new IngestQueueEntrySQL({
            mailboxUid,
            envelopeFrom: "sender@example.com",
            envelopeTo: ["recipient@example.com"],
            rawBlobKey: uuid.v4(),
            status: IngestStatus.PENDING,
            ...data,
        });
        return await ingestQueueRepo.save(obj);
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
            ingestQueueRepo = conn.getRepository(IngestQueueEntrySQL);
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await ingestQueueRepo.clear();
        await mailboxRepo.clear();
    });

    it("Requires an explicit mailboxUid query parameter to list ingest queue entries.", async () => {
        const result = await request(server.getApplication())
            .get(baseUrl)
            .set("Authorization", "jwt " + ownerToken);
        expect(result.status).toBe(400);
    });

    it("Owner can list ingest queue entries in a mailbox they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        await createIngestQueueEntry(mailbox.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?mailboxUid=${mailbox.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.length).toBe(1);
    });

    it("A different user cannot list ingest queue entries in a mailbox they don't have access to (silently empty).", async () => {
        const mailbox = await createMailbox(owner.uid);
        await createIngestQueueEntry(mailbox.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?mailboxUid=${mailbox.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(200);
        expect(result.body).toEqual([]);
    });

    it("A trusted (admin) caller sees no ingest queue entries of a mailbox they hold no grant on - unless they ask for the administration scope, which is audited.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const entry = await createIngestQueueEntry(mailbox.uid);

        const plain = await request(server.getApplication())
            .get(`${baseUrl}?mailboxUid=${mailbox.uid}`)
            .set("Authorization", "jwt " + adminToken);
        expect(plain.status).toBe(200);
        expect(plain.body).toEqual([]);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?mailboxUid=${mailbox.uid}&scope=admin`)
            .set("Authorization", "jwt " + adminToken);
        expect(result.status).toBe(200);
        expect(result.body.map((row: any) => row.uid)).toEqual([entry.uid]);

        const one = await request(server.getApplication())
            .get(`${baseUrl}/${entry.uid}?scope=admin`)
            .set("Authorization", "jwt " + adminToken);
        expect(one.status).toBe(200);
        const hidden = await request(server.getApplication())
            .get(`${baseUrl}/${entry.uid}`)
            .set("Authorization", "jwt " + adminToken);
        expect(hidden.status).toBe(404);

        const audit = await request(server.getApplication())
            .get(`/${baseUrl.split("/")[1]}/audit-logs?action=mail_queue.admin_access&mailboxUid=${mailbox.uid}`)
            .set("Authorization", "jwt " + adminToken);
        expect(audit.status).toBe(200);
        expect(audit.body.map((row: any) => row.details.operation).sort()).toEqual(["list", "read"]);
        expect(audit.body.every((row: any) => row.mailboxUid === mailbox.uid && row.actorUserUid === admin.uid)).toBe(true);
    });

    it("The administration scope needs a trusted role (403) and an elevated token (403) - an ordinary caller can't use it on their own ingest queue.", async () => {
        const mailbox = await createMailbox(owner.uid);
        await createIngestQueueEntry(mailbox.uid);

        const ordinary = await request(server.getApplication())
            .get(`${baseUrl}?mailboxUid=${mailbox.uid}&scope=admin`)
            .set("Authorization", "jwt " + ownerToken);
        expect(ordinary.status).toBe(403);
        const unelevated = JWTUtils.createTokenSync(config.get("auth"), { uid: admin.uid, roles: ["admin"], scopes: [] });
        const result = await request(server.getApplication())
            .get(`${baseUrl}?mailboxUid=${mailbox.uid}&scope=admin`)
            .set("Authorization", "jwt " + unelevated);
        expect(result.status).toBe(403);
    });

    it("Can make a count request scoped to a mailbox the caller has access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        await createIngestQueueEntry(mailbox.uid);
        await createIngestQueueEntry(mailbox.uid, { status: IngestStatus.FAILED, errorMessage: "boom" });

        const result = await request(server.getApplication())
            .head(`${baseUrl}?mailboxUid=${mailbox.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.headers["content-length"]).toBe("2");
    });
});
