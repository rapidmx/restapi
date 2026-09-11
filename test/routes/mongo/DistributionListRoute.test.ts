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
import { DistributionListMongo } from "../../../src/models/mongo/DistributionListMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { AuditAction } from "../../../src/models/types.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:DistributionListMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/distribution-lists";
    let repo: MongoRepository<DistributionListMongo>;
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let auditLogRepo: MongoRepository<AuditLogEntryMongo>;

    const user: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const userToken = JWTUtils.createTokenSync(config.get("auth"), user);
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

    const createList = async function (data?: any): Promise<DistributionListMongo> {
        const address: string = data?.primarySmtpAddress ?? `${uuid.v4()}@example.com`;
        const obj: DistributionListMongo = new DistributionListMongo({
            uid: address.toLowerCase(),
            primarySmtpAddress: address,
            aliasAddresses: [],
            name: "Test List",
            memberAddresses: [],
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
            repo = conn.getMongoRepository("DistributionListMongo");
            mailboxRepo = conn.getMongoRepository("MailboxMongo");
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
        for (const r of [repo, mailboxRepo, auditLogRepo]) {
            try {
                await r.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
    });

    it("A non-trusted caller cannot create a distribution list (403).", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + userToken)
            .send({ primarySmtpAddress: `${uuid.v4()}@example.com`, name: "Sales", memberAddresses: [] });

        expect(result.status).toBe(403);
    });

    it("Cannot create a distribution list anonymously (no Authorization header).", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .send({ primarySmtpAddress: `${uuid.v4()}@example.com`, name: "Sales", memberAddresses: [] });

        expect(result.status).toBe(403);
    });

    it("A non-trusted caller cannot list distribution lists (403).", async () => {
        await createList();
        const result = await request(server.getApplication()).get(baseUrl).set("Authorization", "jwt " + userToken);
        expect(result.status).toBe(403);
    });

    it("A non-trusted caller cannot count distribution lists (403).", async () => {
        await createList();
        const result = await request(server.getApplication()).head(baseUrl).set("Authorization", "jwt " + userToken);
        expect(result.status).toBe(403);
    });

    it("A non-trusted caller cannot read a distribution list by id (403).", async () => {
        const list = await createList();
        const result = await request(server.getApplication())
            .get(`${baseUrl}/${list.uid}`)
            .set("Authorization", "jwt " + userToken);
        expect(result.status).toBe(403);
    });

    it("A non-trusted caller cannot update a distribution list (403).", async () => {
        const list = await createList();
        const result = await request(server.getApplication())
            .put(`${baseUrl}/${list.uid}`)
            .set("Authorization", "jwt " + userToken)
            .send({ uid: list.uid, version: list.version, name: "Hijacked" });
        expect(result.status).toBe(403);
    });

    it("A non-trusted caller cannot delete a distribution list (403).", async () => {
        const list = await createList();
        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${list.uid}`)
            .set("Authorization", "jwt " + userToken);
        expect(result.status).toBe(403);
    });

    it("A trusted (admin) caller can create a distribution list, and its uid is the normalized primary address.", async () => {
        const address = `Sales.Team@Example.com`;
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ primarySmtpAddress: address, name: "Sales Team", memberAddresses: ["a@example.com"] });

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.uid).toBe(address.toLowerCase());
        expect(result.body.name).toBe("Sales Team");

        const existing = await repo.findOne({ uid: address.toLowerCase() } as any);
        expect(existing).toBeDefined();
    });

    it("A trusted (admin) caller can list, count, read, update, and delete distribution lists.", async () => {
        const list = await createList({ name: "Marketing" });

        const listResult = await request(server.getApplication()).get(baseUrl).set("Authorization", "jwt " + adminToken);
        expect(listResult.status).toBe(200);
        expect(listResult.body.length).toBe(1);

        const countResult = await request(server.getApplication()).head(baseUrl).set("Authorization", "jwt " + adminToken);
        expect(countResult.status).toBeGreaterThanOrEqual(200);
        expect(countResult.status).toBeLessThan(300);
        expect(countResult.headers["content-length"]).toBe("1");

        const readResult = await request(server.getApplication())
            .get(`${baseUrl}/${list.uid}`)
            .set("Authorization", "jwt " + adminToken);
        expect(readResult.status).toBe(200);
        expect(readResult.body.name).toBe("Marketing");

        const updateResult = await request(server.getApplication())
            .put(`${baseUrl}/${list.uid}`)
            .set("Authorization", "jwt " + adminToken)
            .send({ uid: list.uid, version: list.version, name: "Renamed" });
        expect(updateResult.status).toBe(200);
        expect(updateResult.body.name).toBe("Renamed");

        const deleteResult = await request(server.getApplication())
            .delete(`${baseUrl}/${list.uid}`)
            .set("Authorization", "jwt " + adminToken);
        expect(deleteResult.status).toBeGreaterThanOrEqual(200);
        expect(deleteResult.status).toBeLessThan(300);

        const findByIdAfterDelete = await request(server.getApplication())
            .get(`${baseUrl}/${list.uid}`)
            .set("Authorization", "jwt " + adminToken);
        expect(findByIdAfterDelete.status).toBe(404);
    });

    it("Writes an AuditLogEntry for create, update, and delete.", async () => {
        const createResult = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ primarySmtpAddress: `${uuid.v4()}@example.com`, name: "Sales", memberAddresses: [] });
        expect(createResult.status).toBeGreaterThanOrEqual(200);
        expect(createResult.status).toBeLessThan(300);
        const listUid = createResult.body.uid;

        const updateResult = await request(server.getApplication())
            .put(`${baseUrl}/${listUid}`)
            .set("Authorization", "jwt " + adminToken)
            .send({ uid: listUid, version: createResult.body.version, name: "Renamed" });
        expect(updateResult.status).toBe(200);

        const deleteResult = await request(server.getApplication())
            .delete(`${baseUrl}/${listUid}`)
            .set("Authorization", "jwt " + adminToken);
        expect(deleteResult.status).toBeGreaterThanOrEqual(200);
        expect(deleteResult.status).toBeLessThan(300);

        const entries = await auditLogRepo.find({ targetUid: listUid }).toArray();
        const actions = entries.map((e) => e.action).sort();
        expect(actions).toEqual(
            [AuditAction.DISTRIBUTION_LIST_CREATE, AuditAction.DISTRIBUTION_LIST_UPDATE, AuditAction.DISTRIBUTION_LIST_DELETE].sort(),
        );
        for (const entry of entries) {
            expect(entry.targetType).toBe("DistributionList");
            expect(entry.actorUserUid).toBe(admin.uid);
        }
    });

    it("Rejects creating a distribution list whose address is already used by an existing Mailbox (409).", async () => {
        const address = `${uuid.v4()}@example.com`;
        await mailboxRepo.save(
            new MailboxMongo({
                ownerUserUid: uuid.v4(),
                primarySmtpAddress: address,
                aliasAddresses: [],
                displayName: "Existing Mailbox",
                timezone: "UTC",
                quotaBytes: 1_000_000_000,
                usedBytes: 0,
                uid: address,
            }),
        );

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ primarySmtpAddress: address, name: "Collides", memberAddresses: [] });

        expect(result.status).toBe(409);
    });

    it("Rejects updating a distribution list's primarySmtpAddress to an address already used by an existing Mailbox (409) - previously let a trusted admin silently hijack a mailbox's mail flow.", async () => {
        const address = `${uuid.v4()}@example.com`;
        await mailboxRepo.save(
            new MailboxMongo({
                ownerUserUid: uuid.v4(),
                primarySmtpAddress: address,
                aliasAddresses: [],
                displayName: "Existing Mailbox",
                timezone: "UTC",
                quotaBytes: 1_000_000_000,
                usedBytes: 0,
                uid: address,
            }),
        );
        const list = await createList();

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${list.uid}`)
            .set("Authorization", "jwt " + adminToken)
            .send({ uid: list.uid, version: list.version, primarySmtpAddress: address });

        expect(result.status).toBe(409);

        const unchanged = await repo.findOne({ uid: list.uid } as any);
        expect(unchanged?.primarySmtpAddress).toBe(list.primarySmtpAddress);
    });

    it("Allows a PUT that resends the list's own current, unchanged primarySmtpAddress (200) - re-validating only on a genuine change.", async () => {
        const list = await createList();

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${list.uid}`)
            .set("Authorization", "jwt " + adminToken)
            .send({ uid: list.uid, version: list.version, primarySmtpAddress: list.primarySmtpAddress, name: "Renamed" });

        expect(result.status).toBe(200);
        expect(result.body.name).toBe("Renamed");
    });

    it("Rejects creating a distribution list whose address is already used by an existing (including soft-deleted) DistributionList (409).", async () => {
        const list = await createList({ deleted: true } as any);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ primarySmtpAddress: list.primarySmtpAddress, name: "Collides", memberAddresses: [] });

        expect(result.status).toBe(409);
    });

    it("Rejects a create request missing primarySmtpAddress (400).", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ name: "No Address", memberAddresses: [] });

        expect(result.status).toBe(400);
    });

    it("Rejects creating a distribution list with an explicit empty name (400) - proves model validation actually runs on create(), not just the route's own hand-checked primarySmtpAddress.", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ primarySmtpAddress: `${uuid.v4()}@example.com`, name: "", memberAddresses: [] });

        expect(result.status).toBe(400);
    });

    it("Returns 404 updating a distribution list that doesn't exist.", async () => {
        const result = await request(server.getApplication())
            .put(`${baseUrl}/does-not-exist@example.com`)
            .set("Authorization", "jwt " + adminToken)
            .send({ uid: "does-not-exist@example.com", version: 0, name: "Renamed" });

        expect(result.status).toBe(404);
    });

    it("Returns 404 deleting a distribution list that doesn't exist.", async () => {
        const result = await request(server.getApplication())
            .delete(`${baseUrl}/does-not-exist@example.com`)
            .set("Authorization", "jwt " + adminToken);

        expect(result.status).toBe(404);
    });

    it("Rejects a bulk create request with two objects claiming the same address (409).", async () => {
        const address = `${uuid.v4()}@example.com`;
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send([
                { primarySmtpAddress: address, name: "One", memberAddresses: [] },
                { primarySmtpAddress: address, name: "Two", memberAddresses: [] },
            ]);

        expect(result.status).toBe(409);
    });
});
