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
import { RetentionPolicyMongo } from "../../../src/models/mongo/RetentionPolicyMongo.js";
import { AuditAction, MIN_AUDIT_LOG_RETENTION_DAYS } from "../../../src/models/types.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("Route:RetentionPolicyMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/retention-policy";
    let policyRepo: MongoRepository<RetentionPolicyMongo>;
    let auditLogRepo: MongoRepository<AuditLogEntryMongo>;

    const user: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const userToken = JWTUtils.createTokenSync(config.get("auth"), user);
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("mongo");
        if (conn instanceof MongoConnection) {
            policyRepo = conn.getMongoRepository("RetentionPolicyMongo");
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
        await policyRepo.clear();
        await auditLogRepo.clear();
    });

    describe("GET /retention-policy (authenticated, any user)", () => {
        it("Returns all-unset defaults (no automatic purge configured), never a 404, before anything has been configured.", async () => {
            const result = await request(server.getApplication())
                .get(baseUrl)
                .set("Authorization", "jwt " + userToken);

            expect(result.status).toBe(200);
            expect(result.body).toEqual({});
        });

        it("Returns the configured policy once an admin has set it, for an ordinary (non-trusted) authenticated user.", async () => {
            await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ messageRetentionDays: 365 });

            const result = await request(server.getApplication())
                .get(baseUrl)
                .set("Authorization", "jwt " + userToken);

            expect(result.status).toBe(200);
            expect(result.body.messageRetentionDays).toBe(365);
        });

        it("Rejects an unauthenticated caller (403).", async () => {
            const result = await request(server.getApplication()).get(baseUrl);
            expect(result.status).toBe(403);
        });
    });

    describe("PUT /retention-policy (trusted role only)", () => {
        it("Rejects a non-trusted caller (403).", async () => {
            const result = await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + userToken)
                .send({ messageRetentionDays: 365 });

            expect(result.status).toBe(403);
        });

        it("A trusted caller creates the singleton row on first write.", async () => {
            const result = await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ messageRetentionDays: 365 });

            expect(result.status).toBe(200);
            expect(result.body).toEqual({ messageRetentionDays: 365 });

            const rows = await policyRepo.find().toArray();
            expect(rows).toHaveLength(1);
            expect(rows[0].uid).toBe("retention-policy");
        });

        it("Is a genuine partial patch - a later PUT touching only one field leaves the rest alone.", async () => {
            await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ messageRetentionDays: 365, auditLogRetentionDays: MIN_AUDIT_LOG_RETENTION_DAYS });

            const result = await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ messageRetentionDays: 730 });

            expect(result.status).toBe(200);
            expect(result.body).toEqual({ messageRetentionDays: 730, auditLogRetentionDays: MIN_AUDIT_LOG_RETENTION_DAYS });
        });

        it("Rejects a non-positive-integer value (400).", async () => {
            const result = await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ messageRetentionDays: -1 });

            expect(result.status).toBe(400);
            const rows = await policyRepo.find().toArray();
            expect(rows).toHaveLength(0);
        });

        it("Rejects an auditLogRetentionDays value below the compliance floor (400).", async () => {
            const result = await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ auditLogRetentionDays: MIN_AUDIT_LOG_RETENTION_DAYS - 1 });

            expect(result.status).toBe(400);
            const rows = await policyRepo.find().toArray();
            expect(rows).toHaveLength(0);
        });

        it("Accepts an auditLogRetentionDays value exactly at the compliance floor.", async () => {
            const result = await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ auditLogRetentionDays: MIN_AUDIT_LOG_RETENTION_DAYS });

            expect(result.status).toBe(200);
            expect(result.body.auditLogRetentionDays).toBe(MIN_AUDIT_LOG_RETENTION_DAYS);
        });

        it("Records an audit log entry.", async () => {
            await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ messageRetentionDays: 365 });

            const entries = await auditLogRepo.find({ action: AuditAction.RETENTION_POLICY_UPDATE }).toArray();
            expect(entries).toHaveLength(1);
        });
    });
});
