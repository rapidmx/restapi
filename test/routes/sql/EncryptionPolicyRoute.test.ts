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
import { EncryptionPolicySQL } from "../../../src/models/sql/EncryptionPolicySQL.js";
import { AuditAction } from "../../../src/models/types.js";
import { registerTestDoubles } from "../../testDoubles.js";

describe("Route:EncryptionPolicySQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/encryption-policy";
    let policyRepo: Repository<EncryptionPolicySQL>;
    let auditLogRepo: Repository<AuditLogEntrySQL>;

    const user: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const userToken = JWTUtils.createTokenSync(config.get("auth"), user);
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("sql");
        if (isSqlDataSource(conn)) {
            policyRepo = conn.getRepository(EncryptionPolicySQL);
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
        await policyRepo.clear();
        await auditLogRepo.clear();
    });

    describe("GET /encryption-policy (authenticated, any user)", () => {
        it("Returns all-'optional' defaults, never a 404, before anything has been configured.", async () => {
            const result = await request(server.getApplication())
                .get(baseUrl)
                .set("Authorization", "jwt " + userToken);

            expect(result.status).toBe(200);
            expect(result.body).toEqual({ encryptSameOrg: "optional", encryptFederated: "optional", encryptExternal: "optional", allowZeroAccess: true, allowOpenPgp: true });
        });

        it("Answers 200 with the defaults for any signed-in user - a token with no roles and no elevation, an ordinary one, an administrator - and creates no row for any of them.", async () => {
            const bare = JWTUtils.createTokenSync(config.get("auth"), { uid: uuid.v4(), roles: [] } as any);

            for (const token of [bare, userToken, adminToken]) {
                const result = await request(server.getApplication())
                    .get(baseUrl)
                    .set("Authorization", "jwt " + token);

                expect(result.status).toBe(200);
                expect(result.body).toEqual({ encryptSameOrg: "optional", encryptFederated: "optional", encryptExternal: "optional", allowZeroAccess: true, allowOpenPgp: true });
            }
            expect(await policyRepo.find()).toEqual([]);
        });

        it("Returns the configured policy once an admin has set it, for an ordinary (non-trusted) authenticated user.", async () => {
            await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ encryptSameOrg: "automatic" });

            const result = await request(server.getApplication())
                .get(baseUrl)
                .set("Authorization", "jwt " + userToken);

            expect(result.status).toBe(200);
            expect(result.body.encryptSameOrg).toBe("automatic");
        });

        it("Rejects an unauthenticated caller (403) - unlike Branding, this is not public information.", async () => {
            const result = await request(server.getApplication()).get(baseUrl);
            expect(result.status).toBe(403);
        });
    });

    describe("PUT /encryption-policy (trusted role only)", () => {
        it("Rejects a non-trusted caller (403).", async () => {
            const result = await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + userToken)
                .send({ encryptSameOrg: "automatic" });

            expect(result.status).toBe(403);
        });

        it("Rejects an unauthenticated caller.", async () => {
            const result = await request(server.getApplication()).put(baseUrl).send({ encryptSameOrg: "automatic" });
            expect(result.status).toBeGreaterThanOrEqual(400);
        });

        it("A trusted caller creates the singleton row on first write.", async () => {
            const result = await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ encryptSameOrg: "automatic" });

            expect(result.status).toBe(200);
            expect(result.body).toEqual({ encryptSameOrg: "automatic", encryptFederated: "optional", encryptExternal: "optional", allowZeroAccess: true, allowOpenPgp: true });

            const rows = await policyRepo.find();
            expect(rows).toHaveLength(1);
            expect(rows[0].uid).toBe("encryption-policy");
        });

        it("Is a genuine partial patch - a later PUT touching only one field leaves the rest alone.", async () => {
            await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ encryptSameOrg: "automatic", encryptFederated: "prohibited" });

            const result = await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ encryptExternal: "prohibited" });

            expect(result.status).toBe(200);
            expect(result.body).toEqual({ encryptSameOrg: "automatic", encryptFederated: "prohibited", encryptExternal: "prohibited", allowZeroAccess: true, allowOpenPgp: true });
        });

        it("Rejects an invalid policy state value (400).", async () => {
            const result = await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ encryptSameOrg: "sometimes" });

            expect(result.status).toBe(400);
            const rows = await policyRepo.find();
            expect(rows).toHaveLength(0);
        });

        it("Records an audit log entry.", async () => {
            await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ encryptSameOrg: "automatic" });

            const entries = await auditLogRepo.find({ where: { action: AuditAction.ENCRYPTION_POLICY_UPDATE } });
            expect(entries).toHaveLength(1);
        });
    });

    describe("allowZeroAccess", () => {
        it("Defaults to true (mail:zero_access:allowed) before anything is saved.", async () => {
            const result = await request(server.getApplication())
                .get(baseUrl)
                .set("Authorization", "jwt " + userToken);

            expect(result.status).toBe(200);
            expect(result.body.allowZeroAccess).toBe(true);
        });

        it("A trusted caller turns it off, any signed-in user reads it back, and the other fields are untouched.", async () => {
            const put = await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ allowZeroAccess: false, allowOpenPgp: true });

            expect(put.status).toBe(200);
            expect(put.body).toEqual({ encryptSameOrg: "optional", encryptFederated: "optional", encryptExternal: "optional", allowZeroAccess: false, allowOpenPgp: true });

            const result = await request(server.getApplication())
                .get(baseUrl)
                .set("Authorization", "jwt " + userToken);
            expect(result.body.allowZeroAccess).toBe(false);
            expect((await policyRepo.find())[0].allowZeroAccess).toBe(false);
        });

        it("Keeps a saved value across a PUT of the other fields.", async () => {
            await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ allowZeroAccess: false, allowOpenPgp: true });

            const result = await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ encryptSameOrg: "automatic" });

            expect(result.body.allowZeroAccess).toBe(false);
        });

        it("Rejects a non-boolean value (400) without creating the row.", async () => {
            const result = await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ allowZeroAccess: "no" });

            expect(result.status).toBe(400);
            expect(await policyRepo.find()).toHaveLength(0);
        });

        it("Rejects a non-trusted caller (403).", async () => {
            const result = await request(server.getApplication())
                .put(baseUrl)
                .set("Authorization", "jwt " + userToken)
                .send({ allowZeroAccess: false, allowOpenPgp: true });

            expect(result.status).toBe(403);
        });
    });

    describe("allowOpenPgp", () => {
        it("Defaults to true (mail:encryption:openpgp_allowed), and a trusted caller turns it off without touching the other fields.", async () => {
            const before = await request(server.getApplication()).get(baseUrl).set("Authorization", "jwt " + userToken);
            expect(before.body.allowOpenPgp).toBe(true);

            const put = await request(server.getApplication()).put(baseUrl).set("Authorization", "jwt " + adminToken).send({ allowOpenPgp: false });
            expect(put.status).toBe(200);
            expect(put.body).toEqual({ encryptSameOrg: "optional", encryptFederated: "optional", encryptExternal: "optional", allowZeroAccess: true, allowOpenPgp: false });
            expect((await policyRepo.find())[0].allowOpenPgp).toBe(false);

            const kept = await request(server.getApplication()).put(baseUrl).set("Authorization", "jwt " + adminToken).send({ encryptSameOrg: "automatic" });
            expect(kept.body.allowOpenPgp).toBe(false);
        });

        it("Rejects a non-boolean value (400).", async () => {
            const result = await request(server.getApplication()).put(baseUrl).set("Authorization", "jwt " + adminToken).send({ allowOpenPgp: "no" });
            expect(result.status).toBe(400);
        });
    });
});
