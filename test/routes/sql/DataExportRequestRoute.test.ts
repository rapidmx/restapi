///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { request } from "@rapidrest/service-core/test";
import { Server, ObjectFactory, ConnectionManager, isSqlDataSource } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import { AuditLogEntrySQL } from "../../../src/models/sql/AuditLogEntrySQL.js";
import { DataExportRequestSQL } from "../../../src/models/sql/DataExportRequestSQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { AuditAction } from "../../../src/models/types.js";
import { registerTestDoubles, InMemoryBlobStore } from "../../testDoubles.js";

describe("Route:DataExportRequestSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/data-export-requests";
    let mailboxRepo: Repository<MailboxSQL>;
    let requestRepo: Repository<DataExportRequestSQL>;
    let auditLogRepo: Repository<AuditLogEntrySQL>;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);
    const otherUser: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const otherUserToken = JWTUtils.createTokenSync(config.get("auth"), otherUser);
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

    const createMailbox = async (ownerUid: string): Promise<MailboxSQL> =>
        await mailboxRepo.save(
            new MailboxSQL({
                ownerUserUid: ownerUid,
                primarySmtpAddress: `${uuid.v4()}@example.com`,
                aliasAddresses: [],
                displayName: "Test Mailbox",
                timezone: "UTC",
                quotaBytes: 1_000_000_000,
                usedBytes: 0,
            }),
        );

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("sql");
        if (isSqlDataSource(conn)) {
            mailboxRepo = conn.getRepository(MailboxSQL);
            requestRepo = conn.getRepository(DataExportRequestSQL);
            auditLogRepo = conn.getRepository(AuditLogEntrySQL);
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await requestRepo.clear();
        await mailboxRepo.clear();
        await auditLogRepo.clear();
    });

    describe("POST /data-export-requests", () => {
        it("Rejects an unauthenticated caller.", async () => {
            const result = await request(server.getApplication()).post(baseUrl).send({ format: "json" });
            expect(result.status).toBe(403);
        });

        it("Rejects an invalid format (400).", async () => {
            await createMailbox(owner.uid);
            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + ownerToken)
                .send({ format: "pst" });

            expect(result.status).toBe(400);
        });

        it("Returns 404 when the caller owns no mailbox.", async () => {
            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + ownerToken)
                .send({ format: "json" });

            expect(result.status).toBe(404);
        });

        it("Self-service: creates a pending request for the caller's own mailbox, ignoring any mailboxUid they send.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const someoneElsesMailbox = await createMailbox(otherUser.uid);

            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + ownerToken)
                .send({ mailboxUid: someoneElsesMailbox.uid, format: "json" });

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            expect(result.body.mailboxUid).toBe(mailbox.uid);
            expect(result.body.status).toBe("pending");
            expect(result.body.requestedByUserUid).toBe(owner.uid);
        });

        it("Admin-mediated: a trusted caller can create a request for another user's mailbox.", async () => {
            const mailbox = await createMailbox(owner.uid);

            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ mailboxUid: mailbox.uid, format: "mbox" });

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            expect(result.body.mailboxUid).toBe(mailbox.uid);
            expect(result.body.requestedByUserUid).toBe(admin.uid);
        });

        it("Rejects a trusted caller's request for a nonexistent mailbox (404).", async () => {
            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ mailboxUid: uuid.v4(), format: "json" });

            expect(result.status).toBe(404);
        });

        it("Records an audit log entry.", async () => {
            await createMailbox(owner.uid);
            await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + ownerToken)
                .send({ format: "json" });

            const entries = await auditLogRepo.find({ where: { action: AuditAction.DATA_EXPORT_REQUESTED } });
            expect(entries).toHaveLength(1);
        });
    });

    describe("GET /data-export-requests", () => {
        it("An ordinary user sees their own requests, plus any other request made for a mailbox they own (e.g. an admin-mediated one).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const ownRequest = await requestRepo.save(
                new DataExportRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: owner.uid, format: "json", status: "pending" }),
            );
            // Simulates an admin-mediated request for the owner's own mailbox - `requestedByUserUid` here
            // is the requester's uid (an admin, in practice), never the owner's, so the owner could
            // otherwise never discover this request exists via this list endpoint at all.
            const requestForOwnedMailbox = await requestRepo.save(
                new DataExportRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: otherUser.uid, format: "json", status: "pending" }),
            );

            const result = await request(server.getApplication())
                .get(baseUrl)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(200);
            expect(result.body.map((r: any) => r.uid).sort()).toEqual([ownRequest.uid, requestForOwnedMailbox.uid].sort());
        });

        it("A caller who made a request for someone else's mailbox sees only their own request, not the mailbox owner's other requests.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await requestRepo.save(
                new DataExportRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: owner.uid, format: "json", status: "pending" }),
            );
            const requestByOtherUser = await requestRepo.save(
                new DataExportRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: otherUser.uid, format: "json", status: "pending" }),
            );

            const result = await request(server.getApplication())
                .get(baseUrl)
                .set("Authorization", "jwt " + otherUserToken);

            expect(result.status).toBe(200);
            expect(result.body.length).toBe(1);
            expect(result.body[0].uid).toBe(requestByOtherUser.uid);
        });

        it("A trusted admin sees every request.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await requestRepo.save(
                new DataExportRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: owner.uid, format: "json", status: "pending" }),
            );
            await requestRepo.save(
                new DataExportRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: otherUser.uid, format: "json", status: "pending" }),
            );

            const result = await request(server.getApplication())
                .get(baseUrl)
                .set("Authorization", "jwt " + adminToken);

            expect(result.status).toBe(200);
            expect(result.body.length).toBe(2);
        });

        it("An unauthenticated caller gets an empty list.", async () => {
            const result = await request(server.getApplication()).get(baseUrl);
            expect(result.status).toBe(200);
            expect(result.body).toEqual([]);
        });

        it("A crafted comma-containing mailbox uid can't widen the visible-mailbox filter to another user's mailbox (in()-injection guard).", async () => {
            const victimMailbox = await createMailbox(otherUser.uid);
            // Simulates a client-supplied `uid` landing in the mailbox row unstripped - `BaseMailboxRoute.
            // create()` doesn't currently strip a client-supplied `uid` the way `BaseMatterRoute.create()`/
            // `BaseEscrowScopeRoute.create()` do (a separate, bigger issue flagged but not fixed here). This
            // test proves `find()`'s own `in(...)` construction can't be widened by such a uid regardless of
            // how it got onto a row, rather than relying on `create()` to be the only thing standing in the way.
            await mailboxRepo.save(
                new MailboxSQL({
                    uid: `,${victimMailbox.uid}`,
                    ownerUserUid: owner.uid,
                    primarySmtpAddress: `${uuid.v4()}@example.com`,
                    aliasAddresses: [],
                    displayName: "Attacker Mailbox",
                    timezone: "UTC",
                    quotaBytes: 1_000_000_000,
                    usedBytes: 0,
                }),
            );
            const victimRequest = await requestRepo.save(
                new DataExportRequestSQL({ mailboxUid: victimMailbox.uid, requestedByUserUid: otherUser.uid, format: "json", status: "pending" }),
            );

            const result = await request(server.getApplication())
                .get(baseUrl)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(200);
            expect(result.body.map((r: any) => r.uid)).not.toContain(victimRequest.uid);
        });
    });

    describe("GET /data-export-requests/:id", () => {
        it("The requester can view their own request.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const created = await requestRepo.save(
                new DataExportRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: owner.uid, format: "json", status: "pending" }),
            );

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${created.uid}`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(200);
        });

        it("The target mailbox's owner can view a request an admin made on their behalf.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const created = await requestRepo.save(
                new DataExportRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: admin.uid, format: "json", status: "pending" }),
            );

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${created.uid}`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(200);
        });

        it("An unrelated user cannot view someone else's request (403).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const created = await requestRepo.save(
                new DataExportRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: owner.uid, format: "json", status: "pending" }),
            );

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${created.uid}`)
                .set("Authorization", "jwt " + otherUserToken);

            expect(result.status).toBe(403);
        });

        it("Returns 404 for a nonexistent request.", async () => {
            const result = await request(server.getApplication())
                .get(`${baseUrl}/${uuid.v4()}`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(404);
        });

        it("An unauthenticated caller cannot view a request (403).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const created = await requestRepo.save(
                new DataExportRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: owner.uid, format: "json", status: "pending" }),
            );

            const result = await request(server.getApplication()).get(`${baseUrl}/${created.uid}`);

            expect(result.status).toBe(403);
        });
    });

    describe("GET /data-export-requests/:id/download", () => {
        it("Returns 404 when the export isn't ready yet.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const created = await requestRepo.save(
                new DataExportRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: owner.uid, format: "json", status: "pending" }),
            );

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${created.uid}/download`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(404);
        });

        it("Streams the finished bundle once ready, for the requester.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
            const blobKey = `data-exports/${uuid.v4()}.ndjson`;
            await blobStore.put(blobKey, Buffer.from('{"entityType":"Mailbox"}'));
            const created = await requestRepo.save(
                new DataExportRequestSQL({
                    mailboxUid: mailbox.uid,
                    requestedByUserUid: owner.uid,
                    format: "json",
                    status: "ready",
                    blobKey,
                }),
            );

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${created.uid}/download`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(200);
            expect(result.headers["content-disposition"]).toContain("attachment");
            expect(result.text).toBe('{"entityType":"Mailbox"}');
        });

        it("An unrelated user cannot download someone else's export (403).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
            const blobKey = `data-exports/${uuid.v4()}.ndjson`;
            await blobStore.put(blobKey, Buffer.from("content"));
            const created = await requestRepo.save(
                new DataExportRequestSQL({
                    mailboxUid: mailbox.uid,
                    requestedByUserUid: owner.uid,
                    format: "json",
                    status: "ready",
                    blobKey,
                }),
            );

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${created.uid}/download`)
                .set("Authorization", "jwt " + otherUserToken);

            expect(result.status).toBe(403);
        });
    });
});
