///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { request } from "@rapidrest/service-core/test";
import { MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { EscrowAuditLogEntryMongo } from "../../../src/models/mongo/EscrowAuditLogEntryMongo.js";
import { EscrowScopeMongo } from "../../../src/models/mongo/EscrowScopeMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { MatterExportRequestMongo } from "../../../src/models/mongo/MatterExportRequestMongo.js";
import { MatterMongo } from "../../../src/models/mongo/MatterMongo.js";
import { EscrowAuditAction } from "../../../src/models/types.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles, InMemoryBlobStore } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("Route:MatterExportRequestMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/matter-export-requests";
    let escrowScopeRepo: MongoRepository<EscrowScopeMongo>;
    let matterRepo: MongoRepository<MatterMongo>;
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let requestRepo: MongoRepository<MatterExportRequestMongo>;
    let escrowAuditLogRepo: MongoRepository<EscrowAuditLogEntryMongo>;

    const holder: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const holderToken = JWTUtils.createTokenSync(config.get("auth"), holder);
    const otherUser: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const otherUserToken = JWTUtils.createTokenSync(config.get("auth"), otherUser);

    const validPublicKey = { publicKey: "base64cert", type: "x509", fingerprint: "abc123", notBefore: 1000, notAfter: 2000 };

    const createEscrowScope = async (data?: Partial<EscrowScopeMongo>): Promise<EscrowScopeMongo> =>
        await escrowScopeRepo.save(
            new EscrowScopeMongo({ name: "legal", publicKey: validPublicKey, holderUserUids: [holder.uid], requiredHolders: 1, ...data }),
        );

    // A custodian mailbox is only actually attested (recorded in the escrow audit ledger) when its own
    // `escrowScopeId` matches the matter's - see `BaseMatterExportRequestRoute.create()`'s own doc
    // comment. Real `Mailbox` rows (rather than bare `uuid.v4()` placeholders) are required so that check
    // can pass.
    const createMailbox = async (escrowScopeId: string, data?: Partial<MailboxMongo>): Promise<MailboxMongo> =>
        await mailboxRepo.save(
            new MailboxMongo({
                ownerUserUid: uuid.v4(),
                primarySmtpAddress: `${uuid.v4()}@example.com`,
                aliasAddresses: [],
                displayName: "Custodian Mailbox",
                timezone: "UTC",
                quotaBytes: 1_000_000_000,
                usedBytes: 0,
                escrowScopeId,
                ...data,
            }),
        );

    const createMatter = async (escrowScopeId: string, data?: Partial<MatterMongo>): Promise<MatterMongo> =>
        await matterRepo.save(
            new MatterMongo({
                name: "Investigation A",
                escrowScopeId,
                custodianMailboxUids: [(await createMailbox(escrowScopeId)).uid, (await createMailbox(escrowScopeId)).uid],
                dateRangeStart: new Date("2026-01-01"),
                dateRangeEnd: new Date("2026-06-01"),
                ...data,
            }),
        );

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("mongo");
        if (conn instanceof MongoConnection) {
            escrowScopeRepo = conn.getMongoRepository("EscrowScopeMongo");
            matterRepo = conn.getMongoRepository("MatterMongo");
            mailboxRepo = conn.getMongoRepository("MailboxMongo");
            requestRepo = conn.getMongoRepository("MatterExportRequestMongo");
            escrowAuditLogRepo = conn.getMongoRepository("EscrowAuditLogEntryMongo");
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
        await matterRepo.clear();
        await mailboxRepo.clear();
        await escrowScopeRepo.clear();
        await escrowAuditLogRepo.clear();
    });

    describe("POST /matter-export-requests", () => {
        it("Rejects an unauthenticated caller.", async () => {
            const scope = await createEscrowScope();
            const matter = await createMatter(scope.uid);
            const result = await request(server.getApplication()).post(baseUrl).send({ matterId: matter.uid });
            expect(result.status).toBe(403);
        });

        it("Returns 404 for a nonexistent matter.", async () => {
            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + holderToken)
                .send({ matterId: uuid.v4() });
            expect(result.status).toBe(404);
        });

        it("Rejects a caller who isn't a holder of the matter's escrow scope (403).", async () => {
            const scope = await createEscrowScope();
            const matter = await createMatter(scope.uid);
            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + otherUserToken)
                .send({ matterId: matter.uid });
            expect(result.status).toBe(403);
        });

        it("A holder creates a pending request, recording one hash-chained audit entry per custodian mailbox.", async () => {
            const scope = await createEscrowScope();
            const matter = await createMatter(scope.uid);

            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + holderToken)
                .send({ matterId: matter.uid });

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            expect(result.body.matterId).toBe(matter.uid);
            expect(result.body.status).toBe("pending");
            expect(result.body.requestedByUserUid).toBe(holder.uid);

            const entries = await escrowAuditLogRepo.find({ action: EscrowAuditAction.MATTER_EXPORT_REQUESTED }).toArray();
            expect(entries.length).toBe(matter.custodianMailboxUids.length);
            expect(entries.map((e) => e.mailboxUid).sort()).toEqual([...matter.custodianMailboxUids].sort());
        });

        it("Does not record an escrow audit entry for a listed custodian mailbox whose own escrowScopeId doesn't actually match the matter's.", async () => {
            const scope = await createEscrowScope();
            const outOfScopeMailbox = await createMailbox(uuid.v4());
            const matter = await createMatter(scope.uid, { custodianMailboxUids: [outOfScopeMailbox.uid] });

            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + holderToken)
                .send({ matterId: matter.uid });

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);

            const entries = await escrowAuditLogRepo.find({ action: EscrowAuditAction.MATTER_EXPORT_REQUESTED }).toArray();
            expect(entries).toHaveLength(0);
        });
    });

    describe("GET /matter-export-requests", () => {
        it("A holder sees only requests for matters they hold.", async () => {
            const scope = await createEscrowScope();
            const matter = await createMatter(scope.uid);
            const otherScope = await createEscrowScope({ holderUserUids: [otherUser.uid] });
            const otherMatter = await createMatter(otherScope.uid);
            await requestRepo.save(new MatterExportRequestMongo({ matterId: matter.uid, requestedByUserUid: holder.uid, status: "pending" }));
            await requestRepo.save(
                new MatterExportRequestMongo({ matterId: otherMatter.uid, requestedByUserUid: otherUser.uid, status: "pending" }),
            );

            const result = await request(server.getApplication())
                .get(baseUrl)
                .set("Authorization", "jwt " + holderToken);

            expect(result.status).toBe(200);
            expect(result.body.length).toBe(1);
            expect(result.body[0].matterId).toBe(matter.uid);
        });

        it("An unauthenticated caller gets an empty list.", async () => {
            const result = await request(server.getApplication()).get(baseUrl);
            expect(result.status).toBe(200);
            expect(result.body).toEqual([]);
        });

        it("Returns an empty list when the caller holds a scope no matter currently uses.", async () => {
            await createEscrowScope();

            const result = await request(server.getApplication())
                .get(baseUrl)
                .set("Authorization", "jwt " + holderToken);

            expect(result.status).toBe(200);
            expect(result.body).toEqual([]);
        });
    });

    describe("GET /matter-export-requests/:id", () => {
        it("A holder can view a request for their own matter.", async () => {
            const scope = await createEscrowScope();
            const matter = await createMatter(scope.uid);
            const created = await requestRepo.save(
                new MatterExportRequestMongo({ matterId: matter.uid, requestedByUserUid: holder.uid, status: "pending" }),
            );

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${created.uid}`)
                .set("Authorization", "jwt " + holderToken);

            expect(result.status).toBe(200);
        });

        it("Rejects a non-holder (403).", async () => {
            const scope = await createEscrowScope();
            const matter = await createMatter(scope.uid);
            const created = await requestRepo.save(
                new MatterExportRequestMongo({ matterId: matter.uid, requestedByUserUid: holder.uid, status: "pending" }),
            );

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${created.uid}`)
                .set("Authorization", "jwt " + otherUserToken);

            expect(result.status).toBe(403);
        });

        it("Returns 404 for a nonexistent request.", async () => {
            const result = await request(server.getApplication())
                .get(`${baseUrl}/${uuid.v4()}`)
                .set("Authorization", "jwt " + holderToken);
            expect(result.status).toBe(404);
        });
    });

    describe("GET /matter-export-requests/:id/download", () => {
        it("Returns 404 when the export isn't ready yet.", async () => {
            const scope = await createEscrowScope();
            const matter = await createMatter(scope.uid);
            const created = await requestRepo.save(
                new MatterExportRequestMongo({ matterId: matter.uid, requestedByUserUid: holder.uid, status: "pending" }),
            );

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${created.uid}/download`)
                .set("Authorization", "jwt " + holderToken);

            expect(result.status).toBe(404);
        });

        it("Streams the finished bundle once ready, for a holder.", async () => {
            const scope = await createEscrowScope();
            const matter = await createMatter(scope.uid);
            const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
            const blobKey = `matter-exports/${uuid.v4()}.ndjson`;
            await blobStore.put(blobKey, Buffer.from('{"entityType":"Mailbox"}'));
            const created = await requestRepo.save(
                new MatterExportRequestMongo({ matterId: matter.uid, requestedByUserUid: holder.uid, status: "ready", blobKey }),
            );

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${created.uid}/download`)
                .set("Authorization", "jwt " + holderToken);

            expect(result.status).toBe(200);
            expect(result.headers["content-disposition"]).toContain("attachment");
            expect(result.text).toBe('{"entityType":"Mailbox"}');
        });

        it("Rejects a non-holder (403).", async () => {
            const scope = await createEscrowScope();
            const matter = await createMatter(scope.uid);
            const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
            const blobKey = `matter-exports/${uuid.v4()}.ndjson`;
            await blobStore.put(blobKey, Buffer.from("content"));
            const created = await requestRepo.save(
                new MatterExportRequestMongo({ matterId: matter.uid, requestedByUserUid: holder.uid, status: "ready", blobKey }),
            );

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${created.uid}/download`)
                .set("Authorization", "jwt " + otherUserToken);

            expect(result.status).toBe(403);
        });
    });
});
