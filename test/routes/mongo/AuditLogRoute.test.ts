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
import { AuditAction } from "../../../src/models/types.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:AuditLogEntryMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/audit-logs";
    let repo: MongoRepository<AuditLogEntryMongo>;

    const user: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const userToken = JWTUtils.createTokenSync(config.get("auth"), user);
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

    const createEntry = async function (data?: any): Promise<AuditLogEntryMongo> {
        const obj: AuditLogEntryMongo = new AuditLogEntryMongo({
            action: AuditAction.MAILBOX_CREATE,
            targetType: "Mailbox",
            targetUid: uuid.v4(),
            actorUserUid: admin.uid,
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
            repo = conn.getMongoRepository("AuditLogEntryMongo");
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
        try {
            await repo.clear();
        } catch (err: any) {
            if (err.message !== "ns not found") {
                throw err;
            }
        }
    });

    it("A non-trusted caller cannot list audit log entries (403).", async () => {
        await createEntry();
        const result = await request(server.getApplication()).get(baseUrl).set("Authorization", "jwt " + userToken);
        expect(result.status).toBe(403);
    });

    it("A non-trusted caller cannot count audit log entries (403).", async () => {
        await createEntry();
        const result = await request(server.getApplication()).head(baseUrl).set("Authorization", "jwt " + userToken);
        expect(result.status).toBe(403);
    });

    it("A non-trusted caller cannot read an audit log entry by id (403).", async () => {
        const entry = await createEntry();
        const result = await request(server.getApplication())
            .get(`${baseUrl}/${entry.uid}`)
            .set("Authorization", "jwt " + userToken);
        expect(result.status).toBe(403);
    });

    it("A trusted (admin) caller can list, count, and read audit log entries.", async () => {
        const entry = await createEntry({ targetType: "DistributionList", action: AuditAction.DISTRIBUTION_LIST_CREATE });

        const listResult = await request(server.getApplication()).get(baseUrl).set("Authorization", "jwt " + adminToken);
        expect(listResult.status).toBe(200);
        expect(listResult.body.length).toBe(1);
        expect(listResult.body[0].action).toBe(AuditAction.DISTRIBUTION_LIST_CREATE);

        const countResult = await request(server.getApplication()).head(baseUrl).set("Authorization", "jwt " + adminToken);
        expect(countResult.status).toBeGreaterThanOrEqual(200);
        expect(countResult.status).toBeLessThan(300);
        expect(countResult.headers["content-length"]).toBe("1");

        const readResult = await request(server.getApplication())
            .get(`${baseUrl}/${entry.uid}`)
            .set("Authorization", "jwt " + adminToken);
        expect(readResult.status).toBe(200);
        expect(readResult.body.targetType).toBe("DistributionList");
    });

    it("A trusted (admin) caller can filter by field, e.g. action.", async () => {
        await createEntry({ action: AuditAction.MAILBOX_CREATE });
        await createEntry({ action: AuditAction.MESSAGE_DELETE });

        const result = await request(server.getApplication())
            .get(`${baseUrl}?action=${AuditAction.MESSAGE_DELETE}`)
            .set("Authorization", "jwt " + adminToken);

        expect(result.status).toBe(200);
        expect(result.body.length).toBe(1);
        expect(result.body[0].action).toBe(AuditAction.MESSAGE_DELETE);
    });

    it("Cannot create an audit log entry via the API - even a trusted (admin) caller (403).", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ action: AuditAction.MAILBOX_CREATE, targetType: "Mailbox", targetUid: uuid.v4() });

        expect(result.status).toBe(403);
    });

    it("Cannot update an audit log entry via the API - even a trusted (admin) caller (403).", async () => {
        const entry = await createEntry();
        const result = await request(server.getApplication())
            .put(`${baseUrl}/${entry.uid}`)
            .set("Authorization", "jwt " + adminToken)
            .send({ uid: entry.uid, version: entry.version, targetType: "Tampered" });

        expect(result.status).toBe(403);
    });

    it("Cannot delete an audit log entry via the API - even a trusted (admin) caller (403).", async () => {
        const entry = await createEntry();
        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${entry.uid}`)
            .set("Authorization", "jwt " + adminToken);

        expect(result.status).toBe(403);
    });

    it("Cannot truncate audit log entries via the API - even a trusted (admin) caller (403).", async () => {
        await createEntry();
        const result = await request(server.getApplication()).delete(baseUrl).set("Authorization", "jwt " + adminToken);

        expect(result.status).toBe(403);
    });

    it("A trusted (admin) caller reading a nonexistent audit log entry by id gets 404.", async () => {
        const result = await request(server.getApplication())
            .get(`${baseUrl}/${uuid.v4()}`)
            .set("Authorization", "jwt " + adminToken);

        expect(result.status).toBe(404);
    });
});
