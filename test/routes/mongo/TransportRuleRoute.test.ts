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
import { TransportRuleMongo } from "../../../src/models/mongo/TransportRuleMongo.js";
import { AuditAction, TransportRuleActionType } from "../../../src/models/types.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:TransportRuleMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/transport-rules";
    let repo: MongoRepository<TransportRuleMongo>;
    let auditLogRepo: MongoRepository<AuditLogEntryMongo>;

    const user: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const userToken = JWTUtils.createTokenSync(config.get("auth"), user);
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

    const createRule = async function (data?: any): Promise<TransportRuleMongo> {
        const obj: TransportRuleMongo = new TransportRuleMongo({
            name: "Test Rule",
            enabled: true,
            sequence: 0,
            stopProcessingRules: false,
            conditions: {},
            actions: [],
            ...data,
        });
        return await repo.save(obj);
    };

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("mongo");
        if (conn instanceof MongoConnection) {
            repo = conn.getMongoRepository("TransportRuleMongo");
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
        for (const r of [repo, auditLogRepo]) {
            try {
                await r.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
    });

    it("A non-trusted caller cannot create a transport rule (403).", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + userToken)
            .send({ name: "Reject spam", enabled: true, sequence: 0, stopProcessingRules: false, conditions: {}, actions: [] });

        expect(result.status).toBe(403);
    });

    it("Cannot create a transport rule anonymously (no Authorization header).", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .send({ name: "Reject spam", enabled: true, sequence: 0, stopProcessingRules: false, conditions: {}, actions: [] });

        expect(result.status).toBe(403);
    });

    it("A non-trusted caller cannot list transport rules (403).", async () => {
        await createRule();
        const result = await request(server.getApplication()).get(baseUrl).set("Authorization", "jwt " + userToken);
        expect(result.status).toBe(403);
    });

    it("A non-trusted caller cannot count transport rules (403).", async () => {
        await createRule();
        const result = await request(server.getApplication()).head(baseUrl).set("Authorization", "jwt " + userToken);
        expect(result.status).toBe(403);
    });

    it("A non-trusted caller cannot read a transport rule by id (403).", async () => {
        const rule = await createRule();
        const result = await request(server.getApplication())
            .get(`${baseUrl}/${rule.uid}`)
            .set("Authorization", "jwt " + userToken);
        expect(result.status).toBe(403);
    });

    it("A non-trusted caller cannot update a transport rule (403).", async () => {
        const rule = await createRule();
        const result = await request(server.getApplication())
            .put(`${baseUrl}/${rule.uid}`)
            .set("Authorization", "jwt " + userToken)
            .send({ uid: rule.uid, version: rule.version, name: "Hijacked" });
        expect(result.status).toBe(403);
    });

    it("A non-trusted caller cannot delete a transport rule (403).", async () => {
        const rule = await createRule();
        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${rule.uid}`)
            .set("Authorization", "jwt " + userToken);
        expect(result.status).toBe(403);
    });

    it("A trusted (admin) caller can create a transport rule.", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({
                name: "Reject spam",
                enabled: true,
                sequence: 0,
                stopProcessingRules: false,
                conditions: { subjectContains: ["viagra"] },
                actions: [{ type: TransportRuleActionType.REJECT }],
            });

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.name).toBe("Reject spam");
        expect(result.body.actions).toEqual([{ type: TransportRuleActionType.REJECT }]);
    });

    it("A trusted (admin) caller can list, count, read, update, and delete transport rules.", async () => {
        const rule = await createRule({ name: "Marketing" });

        const listResult = await request(server.getApplication()).get(baseUrl).set("Authorization", "jwt " + adminToken);
        expect(listResult.status).toBe(200);
        expect(listResult.body.length).toBe(1);

        const countResult = await request(server.getApplication()).head(baseUrl).set("Authorization", "jwt " + adminToken);
        expect(countResult.status).toBeGreaterThanOrEqual(200);
        expect(countResult.status).toBeLessThan(300);
        expect(countResult.headers["content-length"]).toBe("1");

        const readResult = await request(server.getApplication())
            .get(`${baseUrl}/${rule.uid}`)
            .set("Authorization", "jwt " + adminToken);
        expect(readResult.status).toBe(200);
        expect(readResult.body.name).toBe("Marketing");

        const updateResult = await request(server.getApplication())
            .put(`${baseUrl}/${rule.uid}`)
            .set("Authorization", "jwt " + adminToken)
            .send({ uid: rule.uid, version: rule.version, name: "Renamed" });
        expect(updateResult.status).toBe(200);
        expect(updateResult.body.name).toBe("Renamed");

        const deleteResult = await request(server.getApplication())
            .delete(`${baseUrl}/${rule.uid}`)
            .set("Authorization", "jwt " + adminToken);
        expect(deleteResult.status).toBeGreaterThanOrEqual(200);
        expect(deleteResult.status).toBeLessThan(300);

        const findByIdAfterDelete = await request(server.getApplication())
            .get(`${baseUrl}/${rule.uid}`)
            .set("Authorization", "jwt " + adminToken);
        expect(findByIdAfterDelete.status).toBe(404);
    });

    it("Writes an AuditLogEntry for create, update, and delete.", async () => {
        const createResult = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ name: "Reject spam", enabled: true, sequence: 0, stopProcessingRules: false, conditions: {}, actions: [] });
        expect(createResult.status).toBeGreaterThanOrEqual(200);
        expect(createResult.status).toBeLessThan(300);
        const ruleUid = createResult.body.uid;

        const updateResult = await request(server.getApplication())
            .put(`${baseUrl}/${ruleUid}`)
            .set("Authorization", "jwt " + adminToken)
            .send({ uid: ruleUid, version: createResult.body.version, name: "Renamed" });
        expect(updateResult.status).toBe(200);

        const deleteResult = await request(server.getApplication())
            .delete(`${baseUrl}/${ruleUid}`)
            .set("Authorization", "jwt " + adminToken);
        expect(deleteResult.status).toBeGreaterThanOrEqual(200);
        expect(deleteResult.status).toBeLessThan(300);

        const entries = await auditLogRepo.find({ targetUid: ruleUid }).toArray();
        const actions = entries.map((e) => e.action).sort();
        expect(actions).toEqual(
            [AuditAction.TRANSPORT_RULE_CREATE, AuditAction.TRANSPORT_RULE_UPDATE, AuditAction.TRANSPORT_RULE_DELETE].sort(),
        );
        for (const entry of entries) {
            expect(entry.targetType).toBe("TransportRule");
            expect(entry.actorUserUid).toBe(admin.uid);
        }
    });

    it("Returns 404 updating a transport rule that doesn't exist.", async () => {
        const result = await request(server.getApplication())
            .put(`${baseUrl}/${uuid.v4()}`)
            .set("Authorization", "jwt " + adminToken)
            .send({ uid: uuid.v4(), version: 0, name: "Renamed" });

        expect(result.status).toBe(404);
    });

    it("Returns 404 deleting a transport rule that doesn't exist.", async () => {
        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${uuid.v4()}`)
            .set("Authorization", "jwt " + adminToken);

        expect(result.status).toBe(404);
    });

    it("Can create multiple transport rules in a single bulk (array-body) request.", async () => {
        const objs = [
            { name: "Rule One", enabled: true, sequence: 0, stopProcessingRules: false, conditions: {}, actions: [] },
            { name: "Rule Two", enabled: true, sequence: 1, stopProcessingRules: false, conditions: {}, actions: [] },
        ];

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send(objs);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(Array.isArray(result.body)).toBe(true);
        expect(result.body.length).toBe(2);
    });
});
