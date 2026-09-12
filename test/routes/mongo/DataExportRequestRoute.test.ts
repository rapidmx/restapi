///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { request } from "@rapidrest/service-core/test";
import { MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { AuditLogEntryMongo } from "../../../src/models/mongo/AuditLogEntryMongo.js";
import { DataExportRequestMongo } from "../../../src/models/mongo/DataExportRequestMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { AuditAction } from "../../../src/models/types.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles, InMemoryBlobStore } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("Route:DataExportRequestMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/data-export-requests";
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let requestRepo: MongoRepository<DataExportRequestMongo>;
    let auditLogRepo: MongoRepository<AuditLogEntryMongo>;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);
    const otherUser: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const otherUserToken = JWTUtils.createTokenSync(config.get("auth"), otherUser);
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

    const createMailbox = async (ownerUid: string): Promise<MailboxMongo> =>
        await mailboxRepo.save(
            new MailboxMongo({
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
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("mongo");
        if (conn instanceof MongoConnection) {
            mailboxRepo = conn.getMongoRepository("MailboxMongo");
            requestRepo = conn.getMongoRepository("DataExportRequestMongo");
            auditLogRepo = conn.getMongoRepository("AuditLogEntryMongo");
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
        for (const repo of [requestRepo, mailboxRepo, auditLogRepo]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
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

            const entries = await auditLogRepo.find({ action: AuditAction.DATA_EXPORT_REQUESTED }).toArray();
            expect(entries).toHaveLength(1);
        });
    });

    describe("GET /data-export-requests", () => {
        it("An ordinary user sees only their own requests.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await requestRepo.save(
                new DataExportRequestMongo({ mailboxUid: mailbox.uid, requestedByUserUid: owner.uid, format: "json", status: "pending" }),
            );
            await requestRepo.save(
                new DataExportRequestMongo({ mailboxUid: mailbox.uid, requestedByUserUid: otherUser.uid, format: "json", status: "pending" }),
            );

            const result = await request(server.getApplication())
                .get(baseUrl)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(200);
            expect(result.body.length).toBe(1);
            expect(result.body[0].requestedByUserUid).toBe(owner.uid);
        });

        it("A trusted admin sees every request.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await requestRepo.save(
                new DataExportRequestMongo({ mailboxUid: mailbox.uid, requestedByUserUid: owner.uid, format: "json", status: "pending" }),
            );
            await requestRepo.save(
                new DataExportRequestMongo({ mailboxUid: mailbox.uid, requestedByUserUid: otherUser.uid, format: "json", status: "pending" }),
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
    });

    describe("GET /data-export-requests/:id", () => {
        it("The requester can view their own request.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const created = await requestRepo.save(
                new DataExportRequestMongo({ mailboxUid: mailbox.uid, requestedByUserUid: owner.uid, format: "json", status: "pending" }),
            );

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${created.uid}`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(200);
        });

        it("The target mailbox's owner can view a request an admin made on their behalf.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const created = await requestRepo.save(
                new DataExportRequestMongo({ mailboxUid: mailbox.uid, requestedByUserUid: admin.uid, format: "json", status: "pending" }),
            );

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${created.uid}`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(200);
        });

        it("An unrelated user cannot view someone else's request (403).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const created = await requestRepo.save(
                new DataExportRequestMongo({ mailboxUid: mailbox.uid, requestedByUserUid: owner.uid, format: "json", status: "pending" }),
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
                new DataExportRequestMongo({ mailboxUid: mailbox.uid, requestedByUserUid: owner.uid, format: "json", status: "pending" }),
            );

            const result = await request(server.getApplication()).get(`${baseUrl}/${created.uid}`);

            expect(result.status).toBe(403);
        });
    });

    describe("GET /data-export-requests/:id/download", () => {
        it("Returns 404 when the export isn't ready yet.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const created = await requestRepo.save(
                new DataExportRequestMongo({ mailboxUid: mailbox.uid, requestedByUserUid: owner.uid, format: "json", status: "pending" }),
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
                new DataExportRequestMongo({
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
                new DataExportRequestMongo({
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
