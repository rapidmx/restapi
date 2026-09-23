///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated from DistributionListRoute.test.ts because this needs verified `Domain` rows seeded - kept in
// its own file so that file's own unrestricted-domain assertions (asserted against a mailbox/list repo
// with zero `Domain` rows) can't be affected by this file's seeded data.
import config from "../../config.js";
import { request } from "@rapidrest/service-core/test";
import { MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { DomainMongo } from "../../../src/models/mongo/DomainMongo.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:DistributionListMongo domain-restriction Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/distribution-lists";
    let domainRepo: MongoRepository<DomainMongo>;

    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("mongo");
        if (conn instanceof MongoConnection) {
            domainRepo = conn.getMongoRepository("DomainMongo");
        } else {
            throw new Error("Could not find mongo connection");
        }

        for (const name of ["example.com", "example.org"]) {
            await domainRepo.save(new DomainMongo({ name, enabled: true, verified: true, verificationToken: uuid.v4(), uid: name }));
        }
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    it("Rejects an address on a domain that isn't one of this server's verified domains.", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ primarySmtpAddress: "sales@not-allowed.com", name: "Sales", memberAddresses: [] });

        expect(result.status).toBe(400);
    });

    it("Accepts an address on one of this server's verified domains.", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ primarySmtpAddress: `${uuid.v4()}@example.com`, name: "Sales", memberAddresses: [] });

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
    });

    it("Rejects an address on a pure alias domain (400) - a DistributionList has no address of its own there, same as a Mailbox.", async () => {
        const primary = "aliased-primary.com";
        await domainRepo.save(new DomainMongo({ name: primary, enabled: true, verified: true, verificationToken: uuid.v4(), uid: primary }));
        await domainRepo.save(
            new DomainMongo({ name: "alias.com", enabled: true, verified: true, verificationToken: uuid.v4(), uid: "alias.com", aliasOf: primary }),
        );

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ primarySmtpAddress: "sales@alias.com", name: "Sales", memberAddresses: [] });

        expect(result.status).toBe(400);
    });

    describe("aliasAddresses (previously unvalidated entirely)", () => {
        const seedAlias = async (): Promise<void> => {
            await domainRepo.deleteMany({ uid: { $in: ["powerlevel.gg", "plc.gg"] } } as any).catch(() => undefined);
            await domainRepo.save(new DomainMongo({ name: "powerlevel.gg", enabled: true, verified: true, uid: "powerlevel.gg" }));
            await domainRepo.save(
                new DomainMongo({ uid: "plc.gg", name: "plc.gg", enabled: true, verified: true, aliasOf: "powerlevel.gg" }),
            );
        };

        it("Rejects creating a distribution list whose aliasAddresses includes an address on a domain that isn't verified (400).", async () => {
            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ primarySmtpAddress: `${uuid.v4()}@example.com`, name: "Sales", memberAddresses: [], aliasAddresses: ["sales@not-allowed.com"] });

            expect(result.status).toBe(400);
        });

        it("Rejects creating a distribution list whose aliasAddresses includes an address on a pure alias domain (400), even though the primary address is on the domain it aliases.", async () => {
            await seedAlias();

            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({
                    primarySmtpAddress: `${uuid.v4()}@powerlevel.gg`,
                    name: "Sales",
                    memberAddresses: [],
                    aliasAddresses: ["boss@plc.gg"],
                });

            expect(result.status).toBe(400);
        });

        it("Accepts creating a distribution list whose aliasAddresses are all on verified, non-alias domains.", async () => {
            const primaryAddress = `${uuid.v4()}@example.com`;
            const aliasAddress = `${uuid.v4()}@example.org`;
            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ primarySmtpAddress: primaryAddress, name: "Sales", memberAddresses: [], aliasAddresses: [aliasAddress] });

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            expect(result.body.aliasAddresses).toEqual([aliasAddress.toLowerCase()]);
        });

        it("Rejects adding an alias-domain address to an existing list's aliasAddresses via PUT (400).", async () => {
            await seedAlias();
            const created = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ primarySmtpAddress: `${uuid.v4()}@powerlevel.gg`, name: "Sales", memberAddresses: [], aliasAddresses: [] });
            expect(created.status).toBeGreaterThanOrEqual(200);
            expect(created.status).toBeLessThan(300);

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${created.body.uid}`)
                .set("Authorization", "jwt " + adminToken)
                .send({ uid: created.body.uid, version: created.body.version, aliasAddresses: ["boss@plc.gg"] });

            expect(result.status).toBe(400);
        });

        it("Rejects creating a distribution list whose aliasAddresses collides with an existing Mailbox's address (409).", async () => {
            // No mailbox fixture is set up in this file - collision-checked against a fresh, guaranteed-real
            // address instead: the list's own primarySmtpAddress from a list already created above, re-used as
            // an alias on a second list, which must collide against the first list's primary address.
            const first = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ primarySmtpAddress: `${uuid.v4()}@example.com`, name: "First", memberAddresses: [] });
            expect(first.status).toBeGreaterThanOrEqual(200);
            expect(first.status).toBeLessThan(300);

            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({
                    primarySmtpAddress: `${uuid.v4()}@example.com`,
                    name: "Second",
                    memberAddresses: [],
                    aliasAddresses: [first.body.primarySmtpAddress],
                });

            expect(result.status).toBe(409);
        });

        it("Rejects creating a distribution list whose aliasAddresses contains a malformed entry (not a list, or an entry with no '@') - 400.", async () => {
            const malformedArray = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ primarySmtpAddress: `${uuid.v4()}@example.com`, name: "Sales", memberAddresses: [], aliasAddresses: "not-an-array" });
            expect(malformedArray.status).toBe(400);

            const malformedEntry = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ primarySmtpAddress: `${uuid.v4()}@example.com`, name: "Sales", memberAddresses: [], aliasAddresses: ["not-an-email"] });
            expect(malformedEntry.status).toBe(400);
        });

        it("Rejects a PUT that sets aliasAddresses to something other than a list (400).", async () => {
            const created = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ primarySmtpAddress: `${uuid.v4()}@example.com`, name: "Sales", memberAddresses: [], aliasAddresses: [] });
            expect(created.status).toBeGreaterThanOrEqual(200);
            expect(created.status).toBeLessThan(300);

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${created.body.uid}`)
                .set("Authorization", "jwt " + adminToken)
                .send({ uid: created.body.uid, version: created.body.version, aliasAddresses: "not-an-array" });

            expect(result.status).toBe(400);
        });

        it("Accepts a PUT that resubmits aliasAddresses unchanged - no newly-added alias means nothing to re-validate.", async () => {
            const aliasAddress = `${uuid.v4()}@example.org`;
            const created = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ primarySmtpAddress: `${uuid.v4()}@example.com`, name: "Sales", memberAddresses: [], aliasAddresses: [aliasAddress] });
            expect(created.status).toBeGreaterThanOrEqual(200);
            expect(created.status).toBeLessThan(300);

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${created.body.uid}`)
                .set("Authorization", "jwt " + adminToken)
                .send({ uid: created.body.uid, version: created.body.version, aliasAddresses: [aliasAddress] });

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            expect(result.body.aliasAddresses).toEqual([aliasAddress.toLowerCase()]);
        });
    });
});
