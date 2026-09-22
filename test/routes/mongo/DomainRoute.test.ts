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
import { DomainMongo } from "../../../src/models/mongo/DomainMongo.js";
import { AuditAction } from "../../../src/models/types.js";
import { PluginRegistry } from "../../../src/plugins/PluginRegistry.js";
import { buildVerificationTxtValue } from "../../../src/util/DomainVerificationUtils.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles, StaticDnsResolver } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:DomainMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/domains";
    let repo: MongoRepository<DomainMongo>;
    let auditLogRepo: MongoRepository<AuditLogEntryMongo>;

    const user: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const userToken = JWTUtils.createTokenSync(config.get("auth"), user);
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

    const createDomain = async function (data?: any): Promise<DomainMongo> {
        const name: string = data?.name ?? `${uuid.v4()}.example.com`;
        const obj: DomainMongo = new DomainMongo({
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
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("mongo");
        if (conn instanceof MongoConnection) {
            repo = conn.getMongoRepository("DomainMongo");
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

    it("A domain under a reserved TLD like .local skips DNS validation and starts already verified.", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ name: "mail.local" });

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.verified).toBe(true);
        expect(result.body.verifiedAt).toBeTruthy();
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

            const entries = await auditLogRepo.find({ targetUid: domain.uid, action: AuditAction.DOMAIN_VERIFIED }).toArray();
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

            const entries = await auditLogRepo.find({ targetUid: domain.uid, action: AuditAction.DOMAIN_VERIFIED }).toArray();
            expect(entries.length).toBe(0);
        });

        it("Is a no-op on an already-verified domain.", async () => {
            const domain = await createDomain({ name: "already-verified.com", verified: true, verifiedAt: new Date() });

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${domain.uid}/verify`)
                .set("Authorization", "jwt " + adminToken);

            expect(result.status).toBe(200);
            expect(result.body.verified).toBe(true);

            const entries = await auditLogRepo.find({ targetUid: domain.uid }).toArray();
            expect(entries.length).toBe(0);
        });

        it("Returns 404 verifying a domain that doesn't exist.", async () => {
            const result = await request(server.getApplication())
                .post(`${baseUrl}/does-not-exist.com/verify`)
                .set("Authorization", "jwt " + adminToken);

            expect(result.status).toBe(404);
        });
    });

    describe("dns-setup()", () => {
        it("A non-trusted caller cannot fetch DNS setup status (403).", async () => {
            const domain = await createDomain();

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${domain.uid}/dns-setup`)
                .set("Authorization", "jwt " + userToken);

            expect(result.status).toBe(403);
        });

        it("A trusted caller gets all 5 record checks, reflecting live DNS state and per-domain DKIM/DMARC config.", async () => {
            const domain = await createDomain({
                name: "setup-me.com",
                dkimSelector: "default",
                dkimPublicKey: "MIGfMA0GCSq",
                dmarcPolicy: "quarantine",
            });
            const resolver = objectFactory.getInstance<StaticDnsResolver>("DnsResolver")!;
            resolver.records.set("setup-me.com", [
                [buildVerificationTxtValue(domain.verificationToken)],
                ["v=spf1 mx ~all"],
            ]);
            resolver.mxRecords.set("setup-me.com", [{ priority: 10, exchange: "mail.rapidmx-test.example.com" }]);
            resolver.records.set("default._domainkey.setup-me.com", [["v=DKIM1; k=rsa; p=MIGfMA0GCSq"]]);
            resolver.records.set("_dmarc.setup-me.com", [["v=DMARC1; p=quarantine;"]]);

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${domain.uid}/dns-setup`)
                .set("Authorization", "jwt " + adminToken);

            expect(result.status).toBe(200);
            const byType = Object.fromEntries(result.body.map((c: any) => [c.type, c]));
            expect(byType.ownership.matches).toBe(true);
            expect(byType.mx.configured).toBe(true);
            expect(byType.mx.matches).toBe(true);
            expect(byType.spf.matches).toBe(true);
            expect(byType.dkim.matches).toBe(true);
            expect(byType.dmarc.matches).toBe(true);
        });

        it("Reports dkim as not configured until the domain has a selector and public key.", async () => {
            const domain = await createDomain({ name: "no-dkim.com" });

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${domain.uid}/dns-setup`)
                .set("Authorization", "jwt " + adminToken);

            expect(result.status).toBe(200);
            const dkim = result.body.find((c: any) => c.type === "dkim");
            expect(dkim.configured).toBe(false);
        });

        // `mail:autodiscover:public_url` is read via `@Config` at route construction (like `mxHostname`
        // above it), not live - so the "public_url actually set" happy path needs its own dedicated server
        // with that value set before `server.start()`, the same pattern `KeyVaultRoute.
        // SignEnrollmentProgress.test.ts` uses for `mail:pki:rfc8823:store_dir`. See
        // `DomainRouteAutodiscoverConfigured.test.ts`. Only `PluginRegistry.isActive()` (checked live on
        // every request) can vary per test in this shared server, which is what these two cover.
        describe("autodiscover", () => {
            afterEach(() => {
                PluginRegistry.setLoaded([]);
            });

            it("Leaves out the autodiscover checklist entries entirely while the plugin isn't active.", async () => {
                const domain = await createDomain({ name: "no-autodiscover-plugin.com" });

                const result = await request(server.getApplication())
                    .get(`${baseUrl}/${domain.uid}/dns-setup`)
                    .set("Authorization", "jwt " + adminToken);

                expect(result.status).toBe(200);
                expect(result.body.find((c: any) => c.type === "autodiscover_cname")).toBeUndefined();
                expect(result.body.find((c: any) => c.type === "autodiscover_srv")).toBeUndefined();
            });

            it("Reports the autodiscover entries as not configured once the plugin is active but public_url is unset.", async () => {
                PluginRegistry.setLoaded([{ name: "@rapidmx/autodiscover-plugin", version: "1.0.0" }]);
                const domain = await createDomain({ name: "autodiscover-unconfigured.com" });

                const result = await request(server.getApplication())
                    .get(`${baseUrl}/${domain.uid}/dns-setup`)
                    .set("Authorization", "jwt " + adminToken);

                expect(result.status).toBe(200);
                const cname = result.body.find((c: any) => c.type === "autodiscover_cname");
                const srv = result.body.find((c: any) => c.type === "autodiscover_srv");
                expect(cname.configured).toBe(false);
                expect(srv.configured).toBe(false);
            });
        });

        it("Returns 404 for a domain that doesn't exist.", async () => {
            const result = await request(server.getApplication())
                .get(`${baseUrl}/does-not-exist.com/dns-setup`)
                .set("Authorization", "jwt " + adminToken);

            expect(result.status).toBe(404);
        });
    });

    describe("aliasOf", () => {
        it("Creates a domain aliasing an existing primary domain.", async () => {
            await createDomain({ name: "powerlevel.gg" });

            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ name: "plc.gg", aliasOf: "powerlevel.gg" });

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            expect(result.body.aliasOf).toBe("powerlevel.gg");
        });

        it("Is case-insensitive on the referenced domain's name.", async () => {
            await createDomain({ name: "powerlevel.gg" });

            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ name: "plc.gg", aliasOf: "POWERLEVEL.GG" });

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            expect(result.body.aliasOf).toBe("powerlevel.gg");
        });

        it("Rejects aliasOf naming a domain that doesn't exist (400).", async () => {
            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ name: "plc.gg", aliasOf: "no-such-domain.gg" });

            expect(result.status).toBe(400);
        });

        it("Rejects a domain aliasing itself (400).", async () => {
            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ name: "self-alias.gg", aliasOf: "self-alias.gg" });

            expect(result.status).toBe(400);
        });

        it("Rejects a domain aliasing another alias (no chains) (400).", async () => {
            await createDomain({ name: "powerlevel.gg" });
            await createDomain({ name: "plc.gg", aliasOf: "powerlevel.gg" });

            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ name: "third.gg", aliasOf: "plc.gg" });

            expect(result.status).toBe(400);
        });

        it("Allows updating a domain to set aliasOf against a valid primary domain.", async () => {
            await createDomain({ name: "powerlevel.gg" });
            const domain = await createDomain({ name: "plc.gg" });

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${domain.uid}`)
                .set("Authorization", "jwt " + adminToken)
                .send({ uid: domain.uid, version: domain.version, aliasOf: "powerlevel.gg" });

            expect(result.status).toBe(200);
            expect(result.body.aliasOf).toBe("powerlevel.gg");
        });

        it("Rejects updating aliasOf to a domain that doesn't exist (400).", async () => {
            const domain = await createDomain({ name: "plc.gg" });

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${domain.uid}`)
                .set("Authorization", "jwt " + adminToken)
                .send({ uid: domain.uid, version: domain.version, aliasOf: "no-such-domain.gg" });

            expect(result.status).toBe(400);
        });

        it("Rejects updating a domain to alias itself (400).", async () => {
            const domain = await createDomain({ name: "self-alias-update.gg" });

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${domain.uid}`)
                .set("Authorization", "jwt " + adminToken)
                .send({ uid: domain.uid, version: domain.version, aliasOf: domain.uid });

            expect(result.status).toBe(400);
        });

        it("Rejects updating a domain that other domains already alias INTO an alias itself (409).", async () => {
            const primary = await createDomain({ name: "primary-with-dependents.gg" });
            await createDomain({ name: "dependent.gg", aliasOf: primary.uid });
            const other = await createDomain({ name: "other-primary.gg" });

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${primary.uid}`)
                .set("Authorization", "jwt " + adminToken)
                .send({ uid: primary.uid, version: primary.version, aliasOf: other.uid });

            expect(result.status).toBe(409);
        });

        it("Is a no-op round-tripping the same already-set aliasOf value (no re-validation, no error).", async () => {
            await createDomain({ name: "powerlevel-roundtrip.gg" });
            const domain = await createDomain({ name: "plc-roundtrip.gg", aliasOf: "powerlevel-roundtrip.gg" });

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${domain.uid}`)
                .set("Authorization", "jwt " + adminToken)
                .send({ uid: domain.uid, version: domain.version, aliasOf: "powerlevel-roundtrip.gg", enabled: false });

            expect(result.status).toBe(200);
            expect(result.body.aliasOf).toBe("powerlevel-roundtrip.gg");
            expect(result.body.enabled).toBe(false);
        });

        it("Rejects deleting a primary domain while another domain still aliases it (409).", async () => {
            const primary = await createDomain({ name: "still-aliased.gg" });
            await createDomain({ name: "alias-of-it.gg", aliasOf: primary.uid });

            const result = await request(server.getApplication())
                .delete(`${baseUrl}/${primary.uid}`)
                .set("Authorization", "jwt " + adminToken);

            expect(result.status).toBe(409);
        });

        it("Allows deleting an alias domain itself (it has no dependents).", async () => {
            const primary = await createDomain({ name: "primary-ok-to-keep.gg" });
            const alias = await createDomain({ name: "alias-ok-to-delete.gg", aliasOf: primary.uid });

            const result = await request(server.getApplication())
                .delete(`${baseUrl}/${alias.uid}`)
                .set("Authorization", "jwt " + adminToken);

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
        });
    });

    it("Rejects an invalid dmarcPolicy on create (400).", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ name: "bad-dmarc.com", dmarcPolicy: "not-a-real-policy" });

        expect(result.status).toBe(400);
    });

    it("Rejects an invalid dmarcPolicy on update (400).", async () => {
        const domain = await createDomain();

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${domain.uid}`)
            .set("Authorization", "jwt " + adminToken)
            .send({ uid: domain.uid, version: domain.version, dmarcPolicy: "not-a-real-policy" });

        expect(result.status).toBe(400);
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

        const entries = await auditLogRepo.find({ targetUid: domainUid }).toArray();
        const actions = entries.map((e) => e.action).sort();
        expect(actions).toEqual([AuditAction.DOMAIN_CREATE, AuditAction.DOMAIN_UPDATE, AuditAction.DOMAIN_DELETE].sort());
        for (const entry of entries) {
            expect(entry.targetType).toBe("Domain");
            expect(entry.actorUserUid).toBe(admin.uid);
        }
    });
});
