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
import { DomainSQL } from "../../../src/models/sql/DomainSQL.js";
import { AuditAction } from "../../../src/models/types.js";
import { buildVerificationTxtValue } from "../../../src/util/DomainVerificationUtils.js";
import { registerTestDoubles, StaticDnsResolver } from "../../testDoubles.js";

describe("Route:DomainSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/domains";
    let repo: Repository<DomainSQL>;
    let auditLogRepo: Repository<AuditLogEntrySQL>;

    const user: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const userToken = JWTUtils.createTokenSync(config.get("auth"), user);
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

    const createDomain = async function (data?: any): Promise<DomainSQL> {
        const name: string = data?.name ?? `${uuid.v4()}.example.com`;
        const obj: DomainSQL = new DomainSQL({
            uid: name,
            name,
            enabled: true,
            verified: false,
            verificationToken: uuid.v4(),
            ...data,
        });
        return await repo.save(obj);
    };

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("sql");
        if (isSqlDataSource(conn)) {
            repo = conn.getRepository(DomainSQL);
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
        await repo.clear();
        await auditLogRepo.clear();
        const resolver = objectFactory.getInstance<StaticDnsResolver>("DnsResolver");
        resolver?.records.clear();
    });

    it("A non-trusted caller cannot create a domain (403).", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + userToken)
            .send({ name: "example.com" });

        expect(result.status).toBe(403);
    });

    it("A non-trusted caller cannot list/count/read/update/delete/verify domains (403).", async () => {
        const domain = await createDomain();

        const listResult = await request(server.getApplication()).get(baseUrl).set("Authorization", "jwt " + userToken);
        expect(listResult.status).toBe(403);

        const countResult = await request(server.getApplication()).head(baseUrl).set("Authorization", "jwt " + userToken);
        expect(countResult.status).toBe(403);

        const readResult = await request(server.getApplication())
            .get(`${baseUrl}/${domain.uid}`)
            .set("Authorization", "jwt " + userToken);
        expect(readResult.status).toBe(403);

        const updateResult = await request(server.getApplication())
            .put(`${baseUrl}/${domain.uid}`)
            .set("Authorization", "jwt " + userToken)
            .send({ uid: domain.uid, version: domain.version, enabled: false });
        expect(updateResult.status).toBe(403);

        const deleteResult = await request(server.getApplication())
            .delete(`${baseUrl}/${domain.uid}`)
            .set("Authorization", "jwt " + userToken);
        expect(deleteResult.status).toBe(403);

        const verifyResult = await request(server.getApplication())
            .post(`${baseUrl}/${domain.uid}/verify`)
            .set("Authorization", "jwt " + userToken);
        expect(verifyResult.status).toBe(403);
    });

    it("A trusted (admin) caller can create a domain, starting unverified with a generated token.", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ name: "Example.com" });

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.uid).toBe("example.com");
        expect(result.body.verified).toBe(false);
        expect(typeof result.body.verificationToken).toBe("string");
        expect(result.body.verificationToken.length).toBeGreaterThan(0);
    });

    it("A trusted (admin) caller can list, count, read, update, and delete domains.", async () => {
        const domain = await createDomain({ name: "marketing.example.com" });

        const listResult = await request(server.getApplication()).get(baseUrl).set("Authorization", "jwt " + adminToken);
        expect(listResult.status).toBe(200);
        expect(listResult.body.length).toBe(1);

        const countResult = await request(server.getApplication()).head(baseUrl).set("Authorization", "jwt " + adminToken);
        expect(countResult.status).toBeGreaterThanOrEqual(200);
        expect(countResult.status).toBeLessThan(300);
        expect(countResult.headers["content-length"]).toBe("1");

        const readResult = await request(server.getApplication())
            .get(`${baseUrl}/${domain.uid}`)
            .set("Authorization", "jwt " + adminToken);
        expect(readResult.status).toBe(200);
        expect(readResult.body.name).toBe("marketing.example.com");

        const updateResult = await request(server.getApplication())
            .put(`${baseUrl}/${domain.uid}`)
            .set("Authorization", "jwt " + adminToken)
            .send({ uid: domain.uid, version: domain.version, enabled: false });
        expect(updateResult.status).toBe(200);
        expect(updateResult.body.enabled).toBe(false);

        const deleteResult = await request(server.getApplication())
            .delete(`${baseUrl}/${domain.uid}`)
            .set("Authorization", "jwt " + adminToken);
        expect(deleteResult.status).toBeGreaterThanOrEqual(200);
        expect(deleteResult.status).toBeLessThan(300);

        const findByIdAfterDelete = await request(server.getApplication())
            .get(`${baseUrl}/${domain.uid}`)
            .set("Authorization", "jwt " + adminToken);
        expect(findByIdAfterDelete.status).toBe(404);
    });

    it("Rejects creating a domain whose (case-insensitive) name is already in use (409).", async () => {
        await createDomain({ name: "example.com" });

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ name: "EXAMPLE.com" });

        expect(result.status).toBe(409);
    });

    it("Rejects a create request missing name (400).", async () => {
        const result = await request(server.getApplication()).post(baseUrl).set("Authorization", "jwt " + adminToken).send({});

        expect(result.status).toBe(400);
    });

    it("Rejects a bulk create request with two domains claiming the same name (409).", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send([{ name: "dup.example.com" }, { name: "DUP.example.com" }]);

        expect(result.status).toBe(409);
    });

    it("A raw PUT cannot set verified/verificationToken/verifiedAt directly.", async () => {
        const domain = await createDomain();

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${domain.uid}`)
            .set("Authorization", "jwt " + adminToken)
            .send({ uid: domain.uid, version: domain.version, verified: true, verificationToken: "hijacked" });

        expect(result.status).toBe(200);
        expect(result.body.verified).toBe(false);
        expect(result.body.verificationToken).toBe(domain.verificationToken);
    });

    it("Rejects a PUT that attempts to change a domain's name (400).", async () => {
        const domain = await createDomain({ name: "example.com" });

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${domain.uid}`)
            .set("Authorization", "jwt " + adminToken)
            .send({ uid: domain.uid, version: domain.version, name: "renamed.com" });

        expect(result.status).toBe(400);
    });

    it("Returns 404 updating a domain that doesn't exist.", async () => {
        const result = await request(server.getApplication())
            .put(`${baseUrl}/does-not-exist.com`)
            .set("Authorization", "jwt " + adminToken)
            .send({ uid: "does-not-exist.com", version: 0, enabled: false });

        expect(result.status).toBe(404);
    });

    it("Returns 404 deleting a domain that doesn't exist.", async () => {
        const result = await request(server.getApplication())
            .delete(`${baseUrl}/does-not-exist.com`)
            .set("Authorization", "jwt " + adminToken);

        expect(result.status).toBe(404);
    });

    describe("verify()", () => {
        it("Flips an unverified domain to verified when the DNS TXT record matches.", async () => {
            const domain = await createDomain({ name: "verify-me.com" });
            const resolver = objectFactory.getInstance<StaticDnsResolver>("DnsResolver")!;
            resolver.records.set("verify-me.com", [[buildVerificationTxtValue(domain.verificationToken)]]);

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${domain.uid}/verify`)
                .set("Authorization", "jwt " + adminToken);

            expect(result.status).toBe(200);
            expect(result.body.verified).toBe(true);
            expect(result.body.verifiedAt).toBeTruthy();
            expect(result.body.lastCheckedAt).toBeTruthy();

            const entries = await auditLogRepo.find({ where: { targetUid: domain.uid, action: AuditAction.DOMAIN_VERIFIED } });
            expect(entries.length).toBe(1);
        });

        it("Leaves a domain unverified (but stamps lastCheckedAt) when the DNS TXT record doesn't match.", async () => {
            const domain = await createDomain({ name: "not-yet.com" });
            const resolver = objectFactory.getInstance<StaticDnsResolver>("DnsResolver")!;
            resolver.records.set("not-yet.com", [["some-other-value"]]);

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${domain.uid}/verify`)
                .set("Authorization", "jwt " + adminToken);

            expect(result.status).toBe(200);
            expect(result.body.verified).toBe(false);
            expect(result.body.lastCheckedAt).toBeTruthy();

            const entries = await auditLogRepo.find({ where: { targetUid: domain.uid, action: AuditAction.DOMAIN_VERIFIED } });
            expect(entries.length).toBe(0);
        });

        it("Is a no-op on an already-verified domain.", async () => {
            const domain = await createDomain({ name: "already-verified.com", verified: true, verifiedAt: new Date() });

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${domain.uid}/verify`)
                .set("Authorization", "jwt " + adminToken);

            expect(result.status).toBe(200);
            expect(result.body.verified).toBe(true);

            const entries = await auditLogRepo.find({ where: { targetUid: domain.uid } });
            expect(entries.length).toBe(0);
        });

        it("Returns 404 verifying a domain that doesn't exist.", async () => {
            const result = await request(server.getApplication())
                .post(`${baseUrl}/does-not-exist.com/verify`)
                .set("Authorization", "jwt " + adminToken);

            expect(result.status).toBe(404);
        });
    });

    it("Writes an AuditLogEntry for create, update, and delete.", async () => {
        const createResult = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ name: "audited.com" });
        expect(createResult.status).toBeGreaterThanOrEqual(200);
        expect(createResult.status).toBeLessThan(300);
        const domainUid = createResult.body.uid;

        const updateResult = await request(server.getApplication())
            .put(`${baseUrl}/${domainUid}`)
            .set("Authorization", "jwt " + adminToken)
            .send({ uid: domainUid, version: createResult.body.version, enabled: false });
        expect(updateResult.status).toBe(200);

        const deleteResult = await request(server.getApplication())
            .delete(`${baseUrl}/${domainUid}`)
            .set("Authorization", "jwt " + adminToken);
        expect(deleteResult.status).toBeGreaterThanOrEqual(200);
        expect(deleteResult.status).toBeLessThan(300);

        const entries = await auditLogRepo.find({ where: { targetUid: domainUid } });
        const actions = entries.map((e) => e.action).sort();
        expect(actions).toEqual([AuditAction.DOMAIN_CREATE, AuditAction.DOMAIN_UPDATE, AuditAction.DOMAIN_DELETE].sort());
        for (const entry of entries) {
            expect(entry.targetType).toBe("Domain");
            expect(entry.actorUserUid).toBe(admin.uid);
        }
    });
});
