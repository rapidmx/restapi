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
import { EscrowAuditLogEntrySQL } from "../../../src/models/sql/EscrowAuditLogEntrySQL.js";
import { EscrowScopeSQL } from "../../../src/models/sql/EscrowScopeSQL.js";
import { MatterExportRequestSQL } from "../../../src/models/sql/MatterExportRequestSQL.js";
import { MatterSQL } from "../../../src/models/sql/MatterSQL.js";
import { EscrowAuditAction } from "../../../src/models/types.js";
import { registerTestDoubles, InMemoryBlobStore } from "../../testDoubles.js";

describe("Route:MatterExportRequestSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/matter-export-requests";
    let escrowScopeRepo: Repository<EscrowScopeSQL>;
    let matterRepo: Repository<MatterSQL>;
    let requestRepo: Repository<MatterExportRequestSQL>;
    let escrowAuditLogRepo: Repository<EscrowAuditLogEntrySQL>;

    const holder: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const holderToken = JWTUtils.createTokenSync(config.get("auth"), holder);
    const otherUser: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const otherUserToken = JWTUtils.createTokenSync(config.get("auth"), otherUser);

    const validPublicKey = { publicKey: "base64cert", type: "x509", fingerprint: "abc123", notBefore: 1000, notAfter: 2000 };

    const createEscrowScope = async (data?: Partial<EscrowScopeSQL>): Promise<EscrowScopeSQL> =>
        await escrowScopeRepo.save(
            new EscrowScopeSQL({ name: "legal", publicKey: validPublicKey, holderUserUids: [holder.uid], requiredHolders: 1, ...data }),
        );

    const createMatter = async (escrowScopeId: string, data?: Partial<MatterSQL>): Promise<MatterSQL> =>
        await matterRepo.save(
            new MatterSQL({
                name: "Investigation A",
                escrowScopeId,
                custodianMailboxUids: [uuid.v4(), uuid.v4()],
                dateRangeStart: new Date("2026-01-01"),
                dateRangeEnd: new Date("2026-06-01"),
                ...data,
            }),
        );

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("sql");
        if (isSqlDataSource(conn)) {
            escrowScopeRepo = conn.getRepository(EscrowScopeSQL);
            matterRepo = conn.getRepository(MatterSQL);
            requestRepo = conn.getRepository(MatterExportRequestSQL);
            escrowAuditLogRepo = conn.getRepository(EscrowAuditLogEntrySQL);
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

            const entries = await escrowAuditLogRepo.find({ where: { action: EscrowAuditAction.MATTER_EXPORT_REQUESTED } });
            expect(entries.length).toBe(matter.custodianMailboxUids.length);
            expect(entries.map((e) => e.mailboxUid).sort()).toEqual([...matter.custodianMailboxUids].sort());
        });
    });

    describe("GET /matter-export-requests", () => {
        it("A holder sees only requests for matters they hold.", async () => {
            const scope = await createEscrowScope();
            const matter = await createMatter(scope.uid);
            const otherScope = await createEscrowScope({ holderUserUids: [otherUser.uid] });
            const otherMatter = await createMatter(otherScope.uid);
            await requestRepo.save(new MatterExportRequestSQL({ matterId: matter.uid, requestedByUserUid: holder.uid, status: "pending" }));
            await requestRepo.save(new MatterExportRequestSQL({ matterId: otherMatter.uid, requestedByUserUid: otherUser.uid, status: "pending" }));

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
                new MatterExportRequestSQL({ matterId: matter.uid, requestedByUserUid: holder.uid, status: "pending" }),
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
                new MatterExportRequestSQL({ matterId: matter.uid, requestedByUserUid: holder.uid, status: "pending" }),
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
                new MatterExportRequestSQL({ matterId: matter.uid, requestedByUserUid: holder.uid, status: "pending" }),
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
                new MatterExportRequestSQL({ matterId: matter.uid, requestedByUserUid: holder.uid, status: "ready", blobKey }),
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
                new MatterExportRequestSQL({ matterId: matter.uid, requestedByUserUid: holder.uid, status: "ready", blobKey }),
            );

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${created.uid}/download`)
                .set("Authorization", "jwt " + otherUserToken);

            expect(result.status).toBe(403);
        });
    });
});
