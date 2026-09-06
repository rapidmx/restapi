///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { request } from "@rapidrest/service-core/test";
import { MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles, NoopSearchProvider } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:SearchRouteMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/search";
    let mailboxRepo: MongoRepository<MailboxMongo>;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);

    const createMailbox = async function (ownerUid: string): Promise<MailboxMongo> {
        const obj: MailboxMongo = new MailboxMongo({
            ownerUserUid: ownerUid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Test Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });
        return await mailboxRepo.save(obj);
    };

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("mongo");
        if (conn instanceof MongoConnection) {
            mailboxRepo = conn.getMongoRepository("MailboxMongo");
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
            await mailboxRepo.clear();
        } catch (err: any) {
            if (err.message !== "ns not found") {
                throw err;
            }
        }
        const searchProvider = objectFactory.getInstance<NoopSearchProvider>("SearchProvider");
        searchProvider?.indexed.clear();
    });

    it("Requires authentication.", async () => {
        const result = await request(server.getApplication()).get(`${baseUrl}?q=hello`);
        expect(result.status).toBe(401);
    });

    it("Requires a query string.", async () => {
        await createMailbox(owner.uid);
        const result = await request(server.getApplication())
            .get(baseUrl)
            .set("Authorization", "jwt " + ownerToken);
        expect(result.status).toBe(400);
    });

    it("Returns 404 when the caller owns no mailbox.", async () => {
        const result = await request(server.getApplication())
            .get(`${baseUrl}?q=hello`)
            .set("Authorization", "jwt " + ownerToken);
        expect(result.status).toBe(404);
    });

    it("Searches only the caller's own mailbox and returns matching indexed documents.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const searchProvider = objectFactory.getInstance<NoopSearchProvider>("SearchProvider")!;
        await searchProvider.index({
            entityType: "message",
            entityUid: "msg-1",
            mailboxUid: mailbox.uid,
            subject: "Hello world",
            body: "This is a test message.",
        });
        await searchProvider.index({
            entityType: "message",
            entityUid: "msg-2",
            mailboxUid: "some-other-mailbox",
            subject: "Hello world",
            body: "A message in a different mailbox.",
        });

        const result = await request(server.getApplication())
            .get(`${baseUrl}?q=Hello`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.results.length).toBe(1);
        expect(result.body.results[0].entityUid).toBe("msg-1");
    });

    it("Accepts a numeric limit query parameter.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const searchProvider = objectFactory.getInstance<NoopSearchProvider>("SearchProvider")!;
        for (let i = 0; i < 3; i++) {
            await searchProvider.index({
                entityType: "message",
                entityUid: `msg-${i}`,
                mailboxUid: mailbox.uid,
                subject: "Hello world",
                body: "This is a test message.",
            });
        }

        const result = await request(server.getApplication())
            .get(`${baseUrl}?q=Hello&limit=2`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.results.length).toBe(3);
    });

    it("Filters by entity type when the types query parameter is provided.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const searchProvider = objectFactory.getInstance<NoopSearchProvider>("SearchProvider")!;
        await searchProvider.index({
            entityType: "message",
            entityUid: "msg-1",
            mailboxUid: mailbox.uid,
            subject: "Project update",
        });
        await searchProvider.index({
            entityType: "note",
            entityUid: "note-1",
            mailboxUid: mailbox.uid,
            subject: "Project notes",
        });

        const result = await request(server.getApplication())
            .get(`${baseUrl}?q=Project&types=note`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.results.length).toBe(1);
        expect(result.body.results[0].entityType).toBe("note");
    });
});
