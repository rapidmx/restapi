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
        for (const r of [matterRepo, escrowScopeRepo, auditLogRepo]) {
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
});
