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
import { EscrowAccessRequestMongo } from "../../../src/models/mongo/EscrowAccessRequestMongo.js";
import { EscrowScopeMongo } from "../../../src/models/mongo/EscrowScopeMongo.js";
import { MatterMongo } from "../../../src/models/mongo/MatterMongo.js";
import { AuditAction } from "../../../src/models/types.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:MatterMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/matters";
    let escrowScopeRepo: MongoRepository<EscrowScopeMongo>;
    let matterRepo: MongoRepository<MatterMongo>;
    let auditLogRepo: MongoRepository<AuditLogEntryMongo>;
    let escrowAccessRequestRepo: MongoRepository<EscrowAccessRequestMongo>;

    const holderA: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const holderAToken = JWTUtils.createTokenSync(config.get("auth"), holderA);
    const holderB: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const holderBToken = JWTUtils.createTokenSync(config.get("auth"), holderB);
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

    const validPublicKey = { publicKey: "base64cert", type: "x509", fingerprint: "abc123", notBefore: 1000, notAfter: 2000 };

    const createEscrowScope = async function (data?: any): Promise<EscrowScopeMongo> {
        const obj: EscrowScopeMongo = new EscrowScopeMongo({
            name: "legal",
            publicKey: validPublicKey,
            holderUserUids: [holderA.uid],
            requiredHolders: 1,
            notifySubjectOnAccess: false,
            ...data,
        });
        return await escrowScopeRepo.save(obj);
    };

    const createMatter = async function (escrowScopeId: string, data?: any): Promise<MatterMongo> {
        const obj: MatterMongo = new MatterMongo({
            name: "Investigation A",
            escrowScopeId,
            custodianMailboxUids: [uuid.v4()],
            dateRangeStart: new Date("2026-01-01"),
            dateRangeEnd: new Date("2026-06-01"),
            ...data,
        });
        return await matterRepo.save(obj);
    };

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("mongo");
        if (conn instanceof MongoConnection) {
            escrowScopeRepo = conn.getMongoRepository("EscrowScopeMongo");
            matterRepo = conn.getMongoRepository("MatterMongo");
            auditLogRepo = conn.getMongoRepository("AuditLogEntryMongo");
            escrowAccessRequestRepo = conn.getMongoRepository("EscrowAccessRequestMongo");
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
        for (const r of [matterRepo, escrowScopeRepo, auditLogRepo, escrowAccessRequestRepo]) {
            try {
                await r.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
    });

    it("Rejects creating a matter as a non-holder of the referenced scope (403).", async () => {
        const scope = await createEscrowScope();

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + holderBToken)
            .send({
                name: "Investigation A",
                escrowScopeId: scope.uid,
                custodianMailboxUids: [uuid.v4()],
                dateRangeStart: "2026-01-01",
                dateRangeEnd: "2026-06-01",
            });

        expect(result.status).toBe(403);
    });

    it("Rejects creating a matter as a holder of a different scope (403).", async () => {
        const scope = await createEscrowScope();
        await createEscrowScope({ name: "other", holderUserUids: [holderB.uid] });

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + holderBToken)
            .send({
                name: "Investigation A",
                escrowScopeId: scope.uid,
                custodianMailboxUids: [uuid.v4()],
                dateRangeStart: "2026-01-01",
                dateRangeEnd: "2026-06-01",
            });

        expect(result.status).toBe(403);
    });

    it("Rejects creating a matter referencing a nonexistent scope (404).", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + holderAToken)
            .send({
                name: "Investigation A",
                escrowScopeId: uuid.v4(),
                custodianMailboxUids: [uuid.v4()],
                dateRangeStart: "2026-01-01",
                dateRangeEnd: "2026-06-01",
            });

        expect(result.status).toBe(404);
    });

    it("A trusted admin who is not a holder gets 403 on create/read/update/close/delete - proves separation of duties.", async () => {
        const scope = await createEscrowScope();
        const matter = await createMatter(scope.uid);

        const createResult = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({
                name: "Investigation B",
                escrowScopeId: scope.uid,
                custodianMailboxUids: [uuid.v4()],
                dateRangeStart: "2026-01-01",
                dateRangeEnd: "2026-06-01",
            });
        expect(createResult.status).toBe(403);

        const readResult = await request(server.getApplication())
            .get(`${baseUrl}/${matter.uid}`)
            .set("Authorization", "jwt " + adminToken);
        expect(readResult.status).toBe(403);

        const updateResult = await request(server.getApplication())
            .put(`${baseUrl}/${matter.uid}`)
            .set("Authorization", "jwt " + adminToken)
            .send({ uid: matter.uid, version: matter.version, name: "renamed" });
        expect(updateResult.status).toBe(403);

        const closeResult = await request(server.getApplication())
            .post(`${baseUrl}/${matter.uid}/close`)
            .set("Authorization", "jwt " + adminToken);
        expect(closeResult.status).toBe(403);

        const deleteResult = await request(server.getApplication())
            .delete(`${baseUrl}/${matter.uid}`)
            .set("Authorization", "jwt " + adminToken);
        expect(deleteResult.status).toBe(403);
    });

    it("Rejects a dateRangeStart on or after dateRangeEnd (400).", async () => {
        const scope = await createEscrowScope();

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + holderAToken)
            .send({
                name: "Investigation A",
                escrowScopeId: scope.uid,
                custodianMailboxUids: [uuid.v4()],
                dateRangeStart: "2026-06-01",
                dateRangeEnd: "2026-01-01",
            });

        expect(result.status).toBe(400);
    });

    it("Rejects an empty custodianMailboxUids (400).", async () => {
        const scope = await createEscrowScope();

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + holderAToken)
            .send({
                name: "Investigation A",
                escrowScopeId: scope.uid,
                custodianMailboxUids: [],
                dateRangeStart: "2026-01-01",
                dateRangeEnd: "2026-06-01",
            });

        expect(result.status).toBe(400);
    });

    it("A holder can create, read, update, close, and delete a matter under their own scope.", async () => {
        const scope = await createEscrowScope();

        const createResult = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + holderAToken)
            .send({
                name: "Investigation A",
                escrowScopeId: scope.uid,
                custodianMailboxUids: [uuid.v4()],
                dateRangeStart: "2026-01-01",
                dateRangeEnd: "2026-06-01",
            });
        expect(createResult.status).toBeGreaterThanOrEqual(200);
        expect(createResult.status).toBeLessThan(300);

        const entries = await auditLogRepo.find({ targetUid: createResult.body.uid }).toArray();
        expect(entries.some((e) => e.action === AuditAction.MATTER_CREATE)).toBe(true);

        const readResult = await request(server.getApplication())
            .get(`${baseUrl}/${createResult.body.uid}`)
            .set("Authorization", "jwt " + holderAToken);
        expect(readResult.status).toBe(200);

        const updateResult = await request(server.getApplication())
            .put(`${baseUrl}/${createResult.body.uid}`)
            .set("Authorization", "jwt " + holderAToken)
            .send({ uid: createResult.body.uid, version: createResult.body.version, name: "renamed" });
        expect(updateResult.status).toBe(200);
        expect(updateResult.body.name).toBe("renamed");

        const closeResult = await request(server.getApplication())
            .post(`${baseUrl}/${createResult.body.uid}/close`)
            .set("Authorization", "jwt " + holderAToken);
        expect(closeResult.status).toBe(200);
        expect(closeResult.body.closedAt).toBeTruthy();

        const deleteResult = await request(server.getApplication())
            .delete(`${baseUrl}/${createResult.body.uid}`)
            .set("Authorization", "jwt " + holderAToken);
        expect(deleteResult.status).toBeGreaterThanOrEqual(200);
        expect(deleteResult.status).toBeLessThan(300);
    });

    it("Rejects deleting a single matter that still has EscrowAccessRequests referencing it (409).", async () => {
        const scope = await createEscrowScope();
        const matter = await createMatter(scope.uid);
        await escrowAccessRequestRepo.save(
            new EscrowAccessRequestMongo({
                matterId: matter.uid,
                mailboxUid: matter.custodianMailboxUids[0],
                requestedByUserUid: holderA.uid,
                status: "pending",
            }),
        );

        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${matter.uid}`)
            .set("Authorization", "jwt " + holderAToken);

        expect(result.status).toBe(409);
        expect(await matterRepo.findOne({ uid: matter.uid } as any)).toBeTruthy();
    });

    it("Rejects changing escrowScopeId on update (400).", async () => {
        const scope = await createEscrowScope();
        const otherScope = await createEscrowScope({ name: "other" });
        const matter = await createMatter(scope.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${matter.uid}`)
            .set("Authorization", "jwt " + holderAToken)
            .send({ uid: matter.uid, version: matter.version, escrowScopeId: otherScope.uid });

        expect(result.status).toBe(400);
    });

    it("Rejects any update once a matter is closed (400).", async () => {
        const scope = await createEscrowScope();
        const matter = await createMatter(scope.uid, { closedAt: new Date() });

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${matter.uid}`)
            .set("Authorization", "jwt " + holderAToken)
            .send({ uid: matter.uid, version: matter.version, name: "renamed" });

        expect(result.status).toBe(400);
    });

    it("Rejects closing an already-closed matter (400).", async () => {
        const scope = await createEscrowScope();
        const matter = await createMatter(scope.uid, { closedAt: new Date() });

        const result = await request(server.getApplication())
            .post(`${baseUrl}/${matter.uid}/close`)
            .set("Authorization", "jwt " + holderAToken);

        expect(result.status).toBe(400);
    });

    it("find()/count() return only matters for scopes the caller holds.", async () => {
        const scopeA = await createEscrowScope();
        const scopeB = await createEscrowScope({ name: "other", holderUserUids: [holderB.uid] });
        await createMatter(scopeA.uid, { name: "Matter A" });
        await createMatter(scopeB.uid, { name: "Matter B" });

        const listResult = await request(server.getApplication()).get(baseUrl).set("Authorization", "jwt " + holderAToken);
        expect(listResult.status).toBe(200);
        expect(listResult.body.length).toBe(1);
        expect(listResult.body[0].name).toBe("Matter A");

        const countResult = await request(server.getApplication()).head(baseUrl).set("Authorization", "jwt " + holderAToken);
        expect(countResult.headers["content-length"]).toBe("1");
    });

    it("find()/count() return empty for a caller who holds no scope at all.", async () => {
        const scope = await createEscrowScope();
        await createMatter(scope.uid);

        const listResult = await request(server.getApplication()).get(baseUrl).set("Authorization", "jwt " + holderBToken);
        expect(listResult.status).toBe(200);
        expect(listResult.body).toEqual([]);

        const countResult = await request(server.getApplication()).head(baseUrl).set("Authorization", "jwt " + holderBToken);
        expect(countResult.headers["content-length"]).toBe("0");
    });

    it("Rejects creating a matter with no escrowScopeId (400).", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + holderAToken)
            .send({
                name: "Investigation A",
                custodianMailboxUids: [uuid.v4()],
                dateRangeStart: "2026-01-01",
                dateRangeEnd: "2026-06-01",
            });

        expect(result.status).toBe(400);
    });

    it("Rejects creating a matter with an empty name (400).", async () => {
        const scope = await createEscrowScope();

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + holderAToken)
            .send({
                name: "",
                escrowScopeId: scope.uid,
                custodianMailboxUids: [uuid.v4()],
                dateRangeStart: "2026-01-01",
                dateRangeEnd: "2026-06-01",
            });

        expect(result.status).toBe(400);
    });

    it("Allows creating a matter with custodianMailboxUids omitted entirely (skips that validation, defaults to an empty array).", async () => {
        const scope = await createEscrowScope();

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + holderAToken)
            .send({ name: "Investigation A", escrowScopeId: scope.uid, dateRangeStart: "2026-01-01", dateRangeEnd: "2026-06-01" });

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.custodianMailboxUids).toEqual([]);
    });

    it("Allows creating a matter with only one of dateRangeStart/dateRangeEnd set (skips the ordering check for an absent field).", async () => {
        const scope = await createEscrowScope();

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + holderAToken)
            .send({ name: "Investigation A", escrowScopeId: scope.uid, custodianMailboxUids: [uuid.v4()], dateRangeStart: "2026-01-01" });

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
    });

    it("Accepts a bulk create of distinct matters under the caller's own scope.", async () => {
        const scope = await createEscrowScope();

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + holderAToken)
            .send([
                {
                    name: "Investigation A",
                    escrowScopeId: scope.uid,
                    custodianMailboxUids: [uuid.v4()],
                    dateRangeStart: "2026-01-01",
                    dateRangeEnd: "2026-06-01",
                },
                {
                    name: "Investigation B",
                    escrowScopeId: scope.uid,
                    custodianMailboxUids: [uuid.v4()],
                    dateRangeStart: "2026-01-01",
                    dateRangeEnd: "2026-06-01",
                },
            ]);

        expect(result.status).toBe(200);
        expect(result.body.map((m: any) => m.name).sort()).toEqual(["Investigation A", "Investigation B"]);
    });

    it("Rejects closing a nonexistent matter (404).", async () => {
        const result = await request(server.getApplication())
            .post(`${baseUrl}/${uuid.v4()}/close`)
            .set("Authorization", "jwt " + holderAToken);
        expect(result.status).toBe(404);
    });

    it("Rejects updating a nonexistent matter (404).", async () => {
        const result = await request(server.getApplication())
            .put(`${baseUrl}/${uuid.v4()}`)
            .set("Authorization", "jwt " + holderAToken)
            .send({ uid: uuid.v4(), version: 0, name: "renamed" });
        expect(result.status).toBe(404);
    });

    it("Rejects deleting a nonexistent matter (404).", async () => {
        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${uuid.v4()}`)
            .set("Authorization", "jwt " + holderAToken);
        expect(result.status).toBe(404);
    });

    it("Rejects finding a nonexistent matter by id (404).", async () => {
        const result = await request(server.getApplication())
            .get(`${baseUrl}/${uuid.v4()}`)
            .set("Authorization", "jwt " + holderAToken);
        expect(result.status).toBe(404);
    });

    describe("HEAD /matters/:id (exists)", () => {
        it("A holder gets a positive exists check for their own matter.", async () => {
            const scope = await createEscrowScope();
            const matter = await createMatter(scope.uid);

            const result = await request(server.getApplication())
                .head(`${baseUrl}/${matter.uid}`)
                .set("Authorization", "jwt " + holderAToken);

            expect(result.status).toBe(200);
            expect(result.headers["content-length"]).toBe("1");
        });

        it("Returns 404 for a nonexistent matter.", async () => {
            const result = await request(server.getApplication())
                .head(`${baseUrl}/${uuid.v4()}`)
                .set("Authorization", "jwt " + holderAToken);

            expect(result.status).toBe(404);
        });

        it("Returns 404 (not a permission error) for a caller who doesn't hold the matter's scope, so existence itself isn't leaked to a non-holder.", async () => {
            const scope = await createEscrowScope();
            const matter = await createMatter(scope.uid);

            const result = await request(server.getApplication())
                .head(`${baseUrl}/${matter.uid}`)
                .set("Authorization", "jwt " + holderBToken);

            expect(result.status).toBe(404);
        });

        it("A trusted admin who is not a holder cannot confirm a matter's existence (404) - proves separation of duties extends to this endpoint too, unlike the framework's own generic trusted-role bypass.", async () => {
            const scope = await createEscrowScope();
            const matter = await createMatter(scope.uid);

            const result = await request(server.getApplication())
                .head(`${baseUrl}/${matter.uid}`)
                .set("Authorization", "jwt " + adminToken);

            expect(result.status).toBe(404);
        });
    });

    describe("PUT /matters (updateBulk)", () => {
        it("A holder can bulk-update matters under their own scope.", async () => {
            const scope = await createEscrowScope();
            const matterA = await createMatter(scope.uid, { name: "A" });
            const matterB = await createMatter(scope.uid, { name: "B" });

            const result = await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + holderAToken)
                .send([
                    { uid: matterA.uid, version: matterA.version, name: "A renamed" },
                    { uid: matterB.uid, version: matterB.version, name: "B renamed" },
                ]);

            expect(result.status).toBe(200);
            expect(result.body.map((m: any) => m.name).sort()).toEqual(["A renamed", "B renamed"]);
        });

        it("A trusted admin who is not a holder cannot bulk-update matters (403) - proves separation of duties extends to the bulk endpoint, not just the singular one.", async () => {
            const scope = await createEscrowScope();
            const matter = await createMatter(scope.uid);

            const result = await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send([{ uid: matter.uid, version: matter.version, name: "renamed" }]);

            expect(result.status).toBe(403);
            const stillOriginal = await matterRepo.findOne({ uid: matter.uid } as any);
            expect(stillOriginal!.name).toBe("Investigation A");
        });

        it("Stops (403) at the first matter in the batch not held by the caller, without touching any entry after it - matches this endpoint's own simple sequential-loop semantics (not a rollback of entries already applied earlier in the same batch).", async () => {
            const scope = await createEscrowScope();
            const otherScope = await createEscrowScope({ name: "other", holderUserUids: [holderB.uid] });
            const notHeldMatter = await createMatter(otherScope.uid, { name: "Not Held" });
            const neverReached = await createMatter(scope.uid, { name: "Never Reached" });

            const result = await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + holderAToken)
                .send([
                    { uid: notHeldMatter.uid, version: notHeldMatter.version, name: "Not Held renamed" },
                    { uid: neverReached.uid, version: neverReached.version, name: "Never Reached renamed" },
                ]);

            expect(result.status).toBe(403);
            expect((await matterRepo.findOne({ uid: notHeldMatter.uid } as any))!.name).toBe("Not Held");
            expect((await matterRepo.findOne({ uid: neverReached.uid } as any))!.name).toBe("Never Reached");
        });

        it("Rejects a closed matter within a bulk update (400).", async () => {
            const scope = await createEscrowScope();
            const matter = await createMatter(scope.uid, { closedAt: new Date() });

            const result = await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + holderAToken)
                .send([{ uid: matter.uid, version: matter.version, name: "renamed" }]);

            expect(result.status).toBe(400);
        });
    });

    describe("PUT /matters/:id/:property (updateProperty)", () => {
        it("A holder can update a single property of their own matter.", async () => {
            const scope = await createEscrowScope();
            const matter = await createMatter(scope.uid);

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${matter.uid}/name`)
                .set("Authorization", "jwt " + holderAToken)
                .send("renamed via property");

            expect(result.status).toBe(200);
            expect(result.body.name).toBe("renamed via property");
        });

        it("A trusted admin who is not a holder cannot update a single property (403) - proves separation of duties extends to this endpoint too.", async () => {
            const scope = await createEscrowScope();
            const matter = await createMatter(scope.uid);

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${matter.uid}/name`)
                .set("Authorization", "jwt " + adminToken)
                .send("renamed");

            expect(result.status).toBe(403);
            const stillOriginal = await matterRepo.findOne({ uid: matter.uid } as any);
            expect(stillOriginal!.name).toBe("Investigation A");
        });

        it("Rejects changing escrowScopeId via updateProperty (400).", async () => {
            const scope = await createEscrowScope();
            const otherScope = await createEscrowScope({ name: "other" });
            const matter = await createMatter(scope.uid);

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${matter.uid}/escrowScopeId`)
                .set("Authorization", "jwt " + holderAToken)
                .send(otherScope.uid);

            expect(result.status).toBe(400);
        });

        it("Rejects updateProperty on an already-closed matter (400).", async () => {
            const scope = await createEscrowScope();
            const matter = await createMatter(scope.uid, { closedAt: new Date() });

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${matter.uid}/name`)
                .set("Authorization", "jwt " + holderAToken)
                .send("renamed");

            expect(result.status).toBe(400);
        });

        it("Returns 404 for updateProperty on a nonexistent matter.", async () => {
            const result = await request(server.getApplication())
                .put(`${baseUrl}/${uuid.v4()}/name`)
                .set("Authorization", "jwt " + holderAToken)
                .send("renamed");

            expect(result.status).toBe(404);
        });
    });

    describe("DELETE /matters (truncate)", () => {
        it("A holder truncating matters only deletes ones under their own held scope(s), leaving other holders' matters untouched.", async () => {
            const scope = await createEscrowScope();
            const otherScope = await createEscrowScope({ name: "other", holderUserUids: [holderB.uid] });
            const ownMatter = await createMatter(scope.uid);
            const notHeldMatter = await createMatter(otherScope.uid);

            const result = await request(server.getApplication()).delete(baseUrl).set("Authorization", "jwt " + holderAToken);

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            expect(await matterRepo.findOne({ uid: ownMatter.uid } as any)).toBeFalsy();
            expect(await matterRepo.findOne({ uid: notHeldMatter.uid } as any)).toBeTruthy();
        });

        it("A holder of a scope with no matters at all under it succeeds with a no-op, not an error.", async () => {
            await createEscrowScope();

            const result = await request(server.getApplication()).delete(baseUrl).set("Authorization", "jwt " + holderAToken);

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
        });

        it("A trusted admin who is not a holder of any scope truncates nothing - proves separation of duties extends to this endpoint too.", async () => {
            const scope = await createEscrowScope();
            const matter = await createMatter(scope.uid);

            const result = await request(server.getApplication()).delete(baseUrl).set("Authorization", "jwt " + adminToken);

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            expect(await matterRepo.findOne({ uid: matter.uid } as any)).toBeTruthy();
        });

        it("Rejects truncating a matter that still has EscrowAccessRequests referencing it (409), leaving it and any other held matter alone.", async () => {
            const scope = await createEscrowScope();
            const referenced = await createMatter(scope.uid, { name: "Referenced" });
            const unreferenced = await createMatter(scope.uid, { name: "Unreferenced" });
            await escrowAccessRequestRepo.save(
                new EscrowAccessRequestMongo({
                    matterId: referenced.uid,
                    mailboxUid: referenced.custodianMailboxUids[0],
                    requestedByUserUid: holderA.uid,
                    status: "pending",
                }),
            );

            const result = await request(server.getApplication()).delete(baseUrl).set("Authorization", "jwt " + holderAToken);

            expect(result.status).toBe(409);
            expect(await matterRepo.findOne({ uid: referenced.uid } as any)).toBeTruthy();
            expect(await matterRepo.findOne({ uid: unreferenced.uid } as any)).toBeTruthy();
        });
    });
});
