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
import { FolderMongo } from "../../../src/models/mongo/FolderMongo.js";
import { MailboxImportRequestMongo } from "../../../src/models/mongo/MailboxImportRequestMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { AuditAction } from "../../../src/models/types.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles, InMemoryBlobStore } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("Route:MailboxImportRequestMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/mailbox-import-requests";
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let folderRepo: MongoRepository<FolderMongo>;
    let requestRepo: MongoRepository<MailboxImportRequestMongo>;
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

    const createFolder = async (mailboxUid: string): Promise<FolderMongo> => await folderRepo.save(new FolderMongo({ mailboxUid, name: "Imported" }));

    const importUrl = (params: Record<string, string | undefined>): string => {
        const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]);
        return `${baseUrl}?${query.toString()}`;
    };

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("mongo");
        if (conn instanceof MongoConnection) {
            mailboxRepo = conn.getMongoRepository("MailboxMongo");
            folderRepo = conn.getMongoRepository("FolderMongo");
            requestRepo = conn.getMongoRepository("MailboxImportRequestMongo");
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
        await requestRepo.clear();
        await folderRepo.clear();
        await mailboxRepo.clear();
        await auditLogRepo.clear();
    });

    describe("POST /mailbox-import-requests", () => {
        it("Rejects an unauthenticated caller.", async () => {
            const result = await request(server.getApplication())
                .post(importUrl({ format: "mbox", targetFolderUid: uuid.v4() }))
                .set("Content-Type", "application/mbox")
                .send(Buffer.from("From x\r\n\r\n"));
            expect(result.status).toBe(403);
        });

        it("Rejects an invalid format (400).", async () => {
            const result = await request(server.getApplication())
                .post(importUrl({ format: "pst-invalid", targetFolderUid: uuid.v4() }))
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/mbox")
                .send(Buffer.from("From x\r\n\r\n"));
            expect(result.status).toBe(400);
        });

        it("Rejects a request with no targetFolderUid (400).", async () => {
            const result = await request(server.getApplication())
                .post(importUrl({ format: "mbox" }))
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/mbox")
                .send(Buffer.from("From x\r\n\r\n"));
            expect(result.status).toBe(400);
        });

        it("Rejects an empty body (400).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            const result = await request(server.getApplication())
                .post(importUrl({ format: "mbox", targetFolderUid: folder.uid }))
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/mbox")
                .send(Buffer.alloc(0));
            expect(result.status).toBe(400);
        });

        it("Returns 404 when the caller owns no mailbox.", async () => {
            const result = await request(server.getApplication())
                .post(importUrl({ format: "mbox", targetFolderUid: uuid.v4() }))
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/mbox")
                .send(Buffer.from("From x\r\n\r\n"));
            expect(result.status).toBe(404);
        });

        it("Rejects a targetFolderUid that doesn't belong to the target mailbox (400).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const someoneElsesMailbox = await createMailbox(otherUser.uid);
            const wrongFolder = await createFolder(someoneElsesMailbox.uid);
            void mailbox;
            const result = await request(server.getApplication())
                .post(importUrl({ format: "mbox", targetFolderUid: wrongFolder.uid }))
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/mbox")
                .send(Buffer.from("From x\r\n\r\n"));
            expect(result.status).toBe(400);
        });

        it("Self-service: creates a pending request for the caller's own mailbox, ignoring any mailboxUid they send, and stores the uploaded bytes.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            const someoneElsesMailbox = await createMailbox(otherUser.uid);
            const raw = Buffer.from("From alice@example.com Thu Jan 01 00:00:00 2026\r\nSubject: Hi\r\n\r\nBody\r\n\r\n");

            const result = await request(server.getApplication())
                .post(importUrl({ format: "mbox", targetFolderUid: folder.uid, mailboxUid: someoneElsesMailbox.uid }))
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/mbox")
                .send(raw);

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            expect(result.body.mailboxUid).toBe(mailbox.uid);
            expect(result.body.targetFolderUid).toBe(folder.uid);
            expect(result.body.status).toBe("pending");
            expect(result.body.requestedByUserUid).toBe(owner.uid);

            const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
            const stored = await blobStore.get(result.body.sourceBlobKey);
            expect(Buffer.compare(stored, raw)).toBe(0);
        });

        it("Admin-mediated: a trusted caller can create a request for another user's mailbox.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);

            const result = await request(server.getApplication())
                .post(importUrl({ format: "pst", targetFolderUid: folder.uid, mailboxUid: mailbox.uid }))
                .set("Authorization", "jwt " + adminToken)
                .set("Content-Type", "application/vnd.ms-outlook")
                .send(Buffer.from("fake pst bytes"));

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            expect(result.body.mailboxUid).toBe(mailbox.uid);
            expect(result.body.requestedByUserUid).toBe(admin.uid);
        });

        it("Rejects a trusted caller's request for a nonexistent mailbox (404).", async () => {
            const result = await request(server.getApplication())
                .post(importUrl({ format: "mbox", targetFolderUid: uuid.v4(), mailboxUid: uuid.v4() }))
                .set("Authorization", "jwt " + adminToken)
                .set("Content-Type", "application/mbox")
                .send(Buffer.from("From x\r\n\r\n"));
            expect(result.status).toBe(404);
        });

        it("Records an audit log entry.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            await request(server.getApplication())
                .post(importUrl({ format: "mbox", targetFolderUid: folder.uid }))
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/mbox")
                .send(Buffer.from("From x\r\n\r\n"));

            const entries = await auditLogRepo.find({ action: AuditAction.MAILBOX_IMPORT_REQUESTED }).toArray();
            expect(entries).toHaveLength(1);
        });
    });

    describe("GET /mailbox-import-requests", () => {
        it("An ordinary user sees their own requests, plus any other request made for a mailbox they own (e.g. an admin-mediated one).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            const ownRequest = await requestRepo.save(
                new MailboxImportRequestMongo({
                    mailboxUid: mailbox.uid,
                    requestedByUserUid: owner.uid,
                    targetFolderUid: folder.uid,
                    format: "mbox",
                    sourceBlobKey: "k1",
                    status: "pending",
                }),
            );
            // Simulates an admin-mediated request for the owner's own mailbox - `requestedByUserUid` here
            // is the requester's uid (an admin, in practice), never the owner's, so the owner could
            // otherwise never discover this request exists via this list endpoint at all.
            const requestForOwnedMailbox = await requestRepo.save(
                new MailboxImportRequestMongo({
                    mailboxUid: mailbox.uid,
                    requestedByUserUid: otherUser.uid,
                    targetFolderUid: folder.uid,
                    format: "mbox",
                    sourceBlobKey: "k2",
                    status: "pending",
                }),
            );

            const result = await request(server.getApplication())
                .get(baseUrl)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(200);
            expect(result.body.map((r: any) => r.uid).sort()).toEqual([ownRequest.uid, requestForOwnedMailbox.uid].sort());
        });

        it("A caller who made a request for someone else's mailbox sees only their own request, not the mailbox owner's other requests.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            await requestRepo.save(
                new MailboxImportRequestMongo({
                    mailboxUid: mailbox.uid,
                    requestedByUserUid: owner.uid,
                    targetFolderUid: folder.uid,
                    format: "mbox",
                    sourceBlobKey: "k1",
                    status: "pending",
                }),
            );
            const requestByOtherUser = await requestRepo.save(
                new MailboxImportRequestMongo({
                    mailboxUid: mailbox.uid,
                    requestedByUserUid: otherUser.uid,
                    targetFolderUid: folder.uid,
                    format: "mbox",
                    sourceBlobKey: "k2",
                    status: "pending",
                }),
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
            const folder = await createFolder(mailbox.uid);
            await requestRepo.save(
                new MailboxImportRequestMongo({
                    mailboxUid: mailbox.uid,
                    requestedByUserUid: owner.uid,
                    targetFolderUid: folder.uid,
                    format: "mbox",
                    sourceBlobKey: "k1",
                    status: "pending",
                }),
            );
            await requestRepo.save(
                new MailboxImportRequestMongo({
                    mailboxUid: mailbox.uid,
                    requestedByUserUid: otherUser.uid,
                    targetFolderUid: folder.uid,
                    format: "mbox",
                    sourceBlobKey: "k2",
                    status: "pending",
                }),
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

    describe("GET /mailbox-import-requests/:id", () => {
        it("The requester can view their own request.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            const created = await requestRepo.save(
                new MailboxImportRequestMongo({
                    mailboxUid: mailbox.uid,
                    requestedByUserUid: owner.uid,
                    targetFolderUid: folder.uid,
                    format: "mbox",
                    sourceBlobKey: "k1",
                    status: "pending",
                }),
            );

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${created.uid}`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(200);
        });

        it("The target mailbox's owner can view a request an admin made on their behalf.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            const created = await requestRepo.save(
                new MailboxImportRequestMongo({
                    mailboxUid: mailbox.uid,
                    requestedByUserUid: admin.uid,
                    targetFolderUid: folder.uid,
                    format: "mbox",
                    sourceBlobKey: "k1",
                    status: "pending",
                }),
            );

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${created.uid}`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(200);
        });

        it("An unrelated user cannot view someone else's request (403).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            const created = await requestRepo.save(
                new MailboxImportRequestMongo({
                    mailboxUid: mailbox.uid,
                    requestedByUserUid: owner.uid,
                    targetFolderUid: folder.uid,
                    format: "mbox",
                    sourceBlobKey: "k1",
                    status: "pending",
                }),
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
            const folder = await createFolder(mailbox.uid);
            const created = await requestRepo.save(
                new MailboxImportRequestMongo({
                    mailboxUid: mailbox.uid,
                    requestedByUserUid: owner.uid,
                    targetFolderUid: folder.uid,
                    format: "mbox",
                    sourceBlobKey: "k1",
                    status: "pending",
                }),
            );

            const result = await request(server.getApplication()).get(`${baseUrl}/${created.uid}`);

            expect(result.status).toBe(403);
        });
    });
});
