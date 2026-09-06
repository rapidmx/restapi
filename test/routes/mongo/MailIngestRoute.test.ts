///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { request } from "@rapidrest/service-core/test";
import { MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { IngestQueueEntryMongo } from "../../../src/models/mongo/IngestQueueEntryMongo.js";
import { IngestStatus } from "../../../src/models/types.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:MailIngestRouteMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/internal/mta";
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let ingestQueueRepo: MongoRepository<IngestQueueEntryMongo>;

    const secret = config.get("mail:transport:ingest:secret");

    const createMailbox = async function (data?: any): Promise<MailboxMongo> {
        const obj: MailboxMongo = new MailboxMongo({
            ownerUserUid: uuid.v4(),
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Test Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
            ...data,
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
            ingestQueueRepo = conn.getMongoRepository("IngestQueueEntryMongo");
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
        for (const repo of [mailboxRepo, ingestQueueRepo]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
    });

    it("Rejects a resolve request without the internal bearer secret.", async () => {
        const mailbox = await createMailbox();
        const result = await request(server.getApplication()).get(
            `${baseUrl}/resolve?rcpt=${mailbox.primarySmtpAddress}`,
        );
        expect(result.status).toBe(403);
    });

    it("Rejects a resolve request with the wrong bearer secret.", async () => {
        const mailbox = await createMailbox();
        const result = await request(server.getApplication())
            .get(`${baseUrl}/resolve?rcpt=${mailbox.primarySmtpAddress}`)
            .set("Authorization", "Bearer wrong-secret");
        expect(result.status).toBe(403);
    });

    it("Resolves 200 for a mailbox's primary SMTP address.", async () => {
        const mailbox = await createMailbox();
        const result = await request(server.getApplication())
            .get(`${baseUrl}/resolve?rcpt=${mailbox.primarySmtpAddress}`)
            .set("Authorization", `Bearer ${secret}`);
        expect(result.status).toBe(200);
    });

    it("Resolves 200 for a mailbox's alias address.", async () => {
        const mailbox = await createMailbox({ aliasAddresses: ["alias@example.com"] });
        const result = await request(server.getApplication())
            .get(`${baseUrl}/resolve?rcpt=alias@example.com`)
            .set("Authorization", `Bearer ${secret}`);
        expect(result.status).toBe(200);
    });

    it("Rejects a resolve request with no rcpt query parameter.", async () => {
        const result = await request(server.getApplication())
            .get(`${baseUrl}/resolve`)
            .set("Authorization", `Bearer ${secret}`);
        expect(result.status).toBe(400);
    });

    it("Resolves 404 for an address with no matching mailbox.", async () => {
        const result = await request(server.getApplication())
            .get(`${baseUrl}/resolve?rcpt=nobody@example.com`)
            .set("Authorization", `Bearer ${secret}`);
        expect(result.status).toBe(404);
    });

    it("Rejects a deliver request without the internal bearer secret.", async () => {
        const result = await request(server.getApplication())
            .post(`${baseUrl}/deliver`)
            .set("Content-Type", "message/rfc822")
            .send(Buffer.from("From: a@example.com\r\n\r\nHi\r\n"));
        expect(result.status).toBe(403);
    });

    it("Stages an IngestQueueEntry for each resolvable recipient of an accepted message.", async () => {
        const mailbox = await createMailbox();
        const raw = Buffer.from("From: sender@example.com\r\nTo: " + mailbox.primarySmtpAddress + "\r\n\r\nHello\r\n");

        const result = await request(server.getApplication())
            .post(`${baseUrl}/deliver`)
            .set("Authorization", `Bearer ${secret}`)
            .set("X-Envelope-From", "sender@example.com")
            .set("X-Envelope-To", mailbox.primarySmtpAddress)
            .set("Content-Type", "message/rfc822")
            .send(raw);

        expect(result.status).toBe(202);
        expect(result.body.results).toEqual([{ rcpt: mailbox.primarySmtpAddress, queued: true }]);

        const entries: IngestQueueEntryMongo[] = await ingestQueueRepo.find({ mailboxUid: mailbox.uid }).toArray();
        expect(entries.length).toBe(1);
        expect(entries[0].status).toBe(IngestStatus.PENDING);
        expect(entries[0].envelopeFrom).toBe("sender@example.com");
    });

    it("Reports an unresolvable recipient as not queued, without failing the whole request.", async () => {
        const raw = Buffer.from("From: sender@example.com\r\nTo: nobody@example.com\r\n\r\nHello\r\n");

        const result = await request(server.getApplication())
            .post(`${baseUrl}/deliver`)
            .set("Authorization", `Bearer ${secret}`)
            .set("X-Envelope-From", "sender@example.com")
            .set("X-Envelope-To", "nobody@example.com")
            .set("Content-Type", "message/rfc822")
            .send(raw);

        expect(result.status).toBe(202);
        expect(result.body.results).toEqual([{ rcpt: "nobody@example.com", queued: false }]);
    });

    it("Rejects a deliver request with both envelope headers entirely absent.", async () => {
        const raw = Buffer.from("From: sender@example.com\r\nTo: nobody@example.com\r\n\r\nHello\r\n");

        const result = await request(server.getApplication())
            .post(`${baseUrl}/deliver`)
            .set("Authorization", `Bearer ${secret}`)
            .set("Content-Type", "message/rfc822")
            .send(raw);

        expect(result.status).toBe(400);
    });

    it("Rejects a deliver request with an empty body.", async () => {
        const mailbox = await createMailbox();
        const result = await request(server.getApplication())
            .post(`${baseUrl}/deliver`)
            .set("Authorization", `Bearer ${secret}`)
            .set("X-Envelope-From", "sender@example.com")
            .set("X-Envelope-To", mailbox.primarySmtpAddress)
            .set("Content-Type", "message/rfc822")
            .send(Buffer.alloc(0));

        expect(result.status).toBe(400);
    });
});
