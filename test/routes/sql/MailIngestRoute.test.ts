///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { request } from "@rapidrest/service-core/test";
import { Server, ObjectFactory, ConnectionManager, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { IngestQueueEntrySQL } from "../../../src/models/sql/IngestQueueEntrySQL.js";
import { IngestStatus } from "../../../src/models/types.js";
import { registerTestDoubles } from "../../testDoubles.js";

describe("Route:MailIngestRouteSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/internal/mta";
    let mailboxRepo: Repository<MailboxSQL>;
    let ingestQueueRepo: Repository<IngestQueueEntrySQL>;

    const secret = config.get("mail:transport:ingest:secret");

    const createMailbox = async function (data?: any): Promise<MailboxSQL> {
        const obj: MailboxSQL = new MailboxSQL({
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
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("sql");
        if (isSqlDataSource(conn)) {
            mailboxRepo = conn.getRepository(MailboxSQL);
            ingestQueueRepo = conn.getRepository(IngestQueueEntrySQL);
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await ingestQueueRepo.clear();
        await mailboxRepo.clear();
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

    it("Resolves 404 for an address with no matching mailbox.", async () => {
        const result = await request(server.getApplication())
            .get(`${baseUrl}/resolve?rcpt=nobody@example.com`)
            .set("Authorization", `Bearer ${secret}`);
        expect(result.status).toBe(404);
    });

    it("Treats '%'/'_' in the rcpt address as literal characters, not SQL LIKE wildcards, when matching aliases.", async () => {
        // Alias lookup on SQL is implemented via a substring LIKE match against a serialized JSON column (see
        // `MailIngestRouteSQL.aliasQueryValue()`). Without escaping, a `_` (SQL "match any one character"
        // wildcard) in the rcpt address would let "b_b@example.com" falsely match a stored alias
        // "bob@example.com" - enabling blind alias enumeration and mis-delivery. Confirm the literal
        // (non-matching) interpretation wins instead.
        await createMailbox({ aliasAddresses: ["bob@example.com"] });
        const result = await request(server.getApplication())
            .get(`${baseUrl}/resolve?rcpt=b_b@example.com`)
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

        const entries: IngestQueueEntrySQL[] = await ingestQueueRepo.find({ where: { mailboxUid: mailbox.uid } });
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
