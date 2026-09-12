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
import { DataSubjectErasureRequestSQL } from "../../../src/models/sql/DataSubjectErasureRequestSQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { MatterSQL } from "../../../src/models/sql/MatterSQL.js";
import { AuditAction } from "../../../src/models/types.js";
import { registerTestDoubles } from "../../testDoubles.js";

describe("Route:DataSubjectErasureRequestSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/erasure-requests";
    let mailboxRepo: Repository<MailboxSQL>;
    let matterRepo: Repository<MatterSQL>;
    let requestRepo: Repository<DataSubjectErasureRequestSQL>;
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

    const createMatter = async (data?: Partial<MatterSQL>): Promise<MatterSQL> =>
        await matterRepo.save(
            new MatterSQL({
                name: "Test Matter",
                escrowScopeId: uuid.v4(),
                custodianMailboxUids: [],
                dateRangeStart: new Date("2020-01-01"),
                dateRangeEnd: new Date("2030-01-01"),
                ...data,
            }),
        );

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("sql");
        if (isSqlDataSource(conn)) {
            mailboxRepo = conn.getRepository(MailboxSQL);
            matterRepo = conn.getRepository(MatterSQL);
            requestRepo = conn.getRepository(DataSubjectErasureRequestSQL);
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
        await matterRepo.clear();
        await mailboxRepo.clear();
        await auditLogRepo.clear();
    });

    describe("POST /erasure-requests", () => {
        it("Rejects an unauthenticated caller.", async () => {
            const result = await request(server.getApplication()).post(baseUrl);
            expect(result.status).toBe(403);
        });

        it("Returns 404 when the caller owns no mailbox.", async () => {
            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + ownerToken);
            expect(result.status).toBe(404);
        });

        it("Self-service: creates a pending request for the caller's own mailbox.", async () => {
            const mailbox = await createMailbox(owner.uid);

            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            expect(result.body.mailboxUid).toBe(mailbox.uid);
            expect(result.body.status).toBe("pending");
            expect(result.body.requestedByUserUid).toBe(owner.uid);

            const entries = await auditLogRepo.find({ where: { action: AuditAction.ERASURE_REQUEST_CREATED } });
            expect(entries).toHaveLength(1);
        });

        it("Rejects a second request while one is already pending for the same mailbox (409).", async () => {
            await createMailbox(owner.uid);
            await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + ownerToken);

            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(409);
        });
    });

    describe("POST /erasure-requests/:id/approve", () => {
        it("Rejects an unauthenticated caller.", async () => {
            const result = await request(server.getApplication()).post(`${baseUrl}/${uuid.v4()}/approve`);
            expect(result.status).toBe(403);
        });

        it("Rejects a non-trusted caller.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const created = await requestRepo.save(
                new DataSubjectErasureRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: owner.uid, status: "pending" }),
            );

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${created.uid}/approve`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(403);
        });

        it("Returns 404 for a nonexistent request.", async () => {
            const result = await request(server.getApplication())
                .post(`${baseUrl}/${uuid.v4()}/approve`)
                .set("Authorization", "jwt " + adminToken);
            expect(result.status).toBe(404);
        });

        it("Rejects approving a request that isn't pending (409).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const created = await requestRepo.save(
                new DataSubjectErasureRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: owner.uid, status: "denied" }),
            );

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${created.uid}/approve`)
                .set("Authorization", "jwt " + adminToken);

            expect(result.status).toBe(409);
        });

        it("Rejects approval while the target mailbox is under an active legal hold (409).", async () => {
            const mailbox = await createMailbox(owner.uid);
            await createMatter({ custodianMailboxUids: [mailbox.uid] });
            const created = await requestRepo.save(
                new DataSubjectErasureRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: owner.uid, status: "pending" }),
            );

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${created.uid}/approve`)
                .set("Authorization", "jwt " + adminToken);

            expect(result.status).toBe(409);

            const stillPending = await requestRepo.findOne({ where: { uid: created.uid } });
            expect(stillPending!.status).toBe("pending");
        });

        it("A trusted admin approves a pending request.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const created = await requestRepo.save(
                new DataSubjectErasureRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: owner.uid, status: "pending" }),
            );

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${created.uid}/approve`)
                .set("Authorization", "jwt " + adminToken);

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            expect(result.body.status).toBe("approved");
            expect(result.body.reviewedByUserUid).toBe(admin.uid);

            const entries = await auditLogRepo.find({ where: { action: AuditAction.ERASURE_REQUEST_APPROVED } });
            expect(entries).toHaveLength(1);
        });
    });

    describe("POST /erasure-requests/:id/deny", () => {
        it("Rejects a non-trusted caller.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const created = await requestRepo.save(
                new DataSubjectErasureRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: owner.uid, status: "pending" }),
            );

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${created.uid}/deny`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ reason: "test" });

            expect(result.status).toBe(403);
        });

        it("Rejects a denial with no reason given (400).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const created = await requestRepo.save(
                new DataSubjectErasureRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: owner.uid, status: "pending" }),
            );

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${created.uid}/deny`)
                .set("Authorization", "jwt " + adminToken)
                .send({});

            expect(result.status).toBe(400);
        });

        it("Rejects denying a request that isn't pending (409).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const created = await requestRepo.save(
                new DataSubjectErasureRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: owner.uid, status: "approved" }),
            );

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${created.uid}/deny`)
                .set("Authorization", "jwt " + adminToken)
                .send({ reason: "test" });

            expect(result.status).toBe(409);
        });

        it("A trusted admin denies a pending request with a reason.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const created = await requestRepo.save(
                new DataSubjectErasureRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: owner.uid, status: "pending" }),
            );

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${created.uid}/deny`)
                .set("Authorization", "jwt " + adminToken)
                .send({ reason: "Unresolved billing dispute." });

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            expect(result.body.status).toBe("denied");
            expect(result.body.reviewedByUserUid).toBe(admin.uid);
            expect(result.body.reason).toBe("Unresolved billing dispute.");

            const entries = await auditLogRepo.find({ where: { action: AuditAction.ERASURE_REQUEST_DENIED } });
            expect(entries).toHaveLength(1);
        });
    });

    describe("GET /erasure-requests", () => {
        it("An ordinary user sees only their own requests.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await requestRepo.save(new DataSubjectErasureRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: owner.uid, status: "pending" }));
            await requestRepo.save(
                new DataSubjectErasureRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: otherUser.uid, status: "pending" }),
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
            await requestRepo.save(new DataSubjectErasureRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: owner.uid, status: "pending" }));
            await requestRepo.save(
                new DataSubjectErasureRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: otherUser.uid, status: "pending" }),
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

    describe("GET /erasure-requests/:id", () => {
        it("The requester can view their own request.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const created = await requestRepo.save(
                new DataSubjectErasureRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: owner.uid, status: "pending" }),
            );

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${created.uid}`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(200);
        });

        it("An unrelated user cannot view someone else's request (403).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const created = await requestRepo.save(
                new DataSubjectErasureRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: owner.uid, status: "pending" }),
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
                new DataSubjectErasureRequestSQL({ mailboxUid: mailbox.uid, requestedByUserUid: owner.uid, status: "pending" }),
            );

            const result = await request(server.getApplication()).get(`${baseUrl}/${created.uid}`);

            expect(result.status).toBe(403);
        });
    });
});
