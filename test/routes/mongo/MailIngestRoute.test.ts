///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { request } from "@rapidrest/service-core/test";
import { MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { DistributionListMongo } from "../../../src/models/mongo/DistributionListMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { IngestQueueEntryMongo } from "../../../src/models/mongo/IngestQueueEntryMongo.js";
import { TransportRuleMongo } from "../../../src/models/mongo/TransportRuleMongo.js";
import { IngestStatus, QuarantineReason, TransportRuleActionType } from "../../../src/models/types.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { InMemoryBlobStore, RecordingMailTransport, registerTestDoubles } from "../../testDoubles.js";

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
    let distributionListRepo: MongoRepository<DistributionListMongo>;
    let transportRuleRepo: MongoRepository<TransportRuleMongo>;

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
        return await distributionListRepo.save(obj);
    };

    const createTransportRule = async function (data?: any): Promise<TransportRuleMongo> {
        const obj: TransportRuleMongo = new TransportRuleMongo({
            name: "Test Rule",
            enabled: true,
            sequence: 0,
            stopProcessingRules: false,
            conditions: {},
            actions: [],
            ...data,
        });
        return await transportRuleRepo.save(obj);
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
            distributionListRepo = conn.getMongoRepository("DistributionListMongo");
            transportRuleRepo = conn.getMongoRepository("TransportRuleMongo");
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
        for (const repo of [mailboxRepo, ingestQueueRepo, distributionListRepo, transportRuleRepo]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
        (objectFactory.getInstance<RecordingMailTransport>("MailTransport")!).sent = [];
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

    it("Resolves 200 for a plus-tagged variant of a mailbox's primary SMTP address.", async () => {
        const local = uuid.v4();
        await createMailbox({ primarySmtpAddress: `${local}@example.com` });
        const result = await request(server.getApplication())
            .get(`${baseUrl}/resolve?rcpt=${local}+tag@example.com`)
            .set("Authorization", `Bearer ${secret}`);
        expect(result.status).toBe(200);
    });

    it("Resolves 200 for a plus-tagged variant of a mailbox's alias address.", async () => {
        const local = uuid.v4();
        await createMailbox({ aliasAddresses: [`${local}@example.com`] });
        const result = await request(server.getApplication())
            .get(`${baseUrl}/resolve?rcpt=${local}+tag@example.com`)
            .set("Authorization", `Bearer ${secret}`);
        expect(result.status).toBe(200);
    });

    it("An explicitly-registered address containing a literal plus still matches via the exact-match tier first.", async () => {
        const local = uuid.v4();
        await createMailbox({ primarySmtpAddress: `${local}+special@example.com` });
        const result = await request(server.getApplication())
            .get(`${baseUrl}/resolve?rcpt=${local}+special@example.com`)
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

    it("Delivers a plus-tagged RCPT TO to the base mailbox, preserving the tagged address in the stored message.", async () => {
        const local = uuid.v4();
        const mailbox = await createMailbox({ primarySmtpAddress: `${local}@example.com` });
        const raw = Buffer.from(`From: sender@example.com\r\nTo: ${local}+tag@example.com\r\n\r\nHello\r\n`);

        const result = await request(server.getApplication())
            .post(`${baseUrl}/deliver`)
            .set("Authorization", `Bearer ${secret}`)
            .set("X-Envelope-From", "sender@example.com")
            .set("X-Envelope-To", `${local}+tag@example.com`)
            .set("Content-Type", "message/rfc822")
            .send(raw);

        expect(result.status).toBe(202);
        expect(result.body.results).toEqual([{ rcpt: `${local}+tag@example.com`, queued: true }]);

        const entries: IngestQueueEntryMongo[] = await ingestQueueRepo.find({ mailboxUid: mailbox.uid }).toArray();
        expect(entries.length).toBe(1);
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

    it("Resolves 200 for a distribution list's primary SMTP address.", async () => {
        const list = await createList();
        const result = await request(server.getApplication())
            .get(`${baseUrl}/resolve?rcpt=${list.primarySmtpAddress}`)
            .set("Authorization", `Bearer ${secret}`);
        expect(result.status).toBe(200);
    });

    it("Resolves 200 for a distribution list's alias address.", async () => {
        await createList({ aliasAddresses: ["list-alias@example.com"] });
        const result = await request(server.getApplication())
            .get(`${baseUrl}/resolve?rcpt=list-alias@example.com`)
            .set("Authorization", `Bearer ${secret}`);
        expect(result.status).toBe(200);
    });

    it("Fans out to every internal member mailbox of a distribution list, all sharing one rewritten blob-stored copy.", async () => {
        const m1 = await createMailbox();
        const m2 = await createMailbox();
        const list = await createList({ memberAddresses: [m1.primarySmtpAddress, m2.primarySmtpAddress] });
        const raw = Buffer.from(
            `From: sender@example.com\r\nTo: ${list.primarySmtpAddress}\r\nReply-To: original@example.com\r\n\r\nHello\r\n`,
        );

        const result = await request(server.getApplication())
            .post(`${baseUrl}/deliver`)
            .set("Authorization", `Bearer ${secret}`)
            .set("X-Envelope-From", "sender@example.com")
            .set("X-Envelope-To", list.primarySmtpAddress)
            .set("Content-Type", "message/rfc822")
            .send(raw);

        expect(result.status).toBe(202);
        expect(result.body.results).toEqual([{ rcpt: list.primarySmtpAddress, queued: true }]);

        const entries: IngestQueueEntryMongo[] = await ingestQueueRepo
            .find({ mailboxUid: { $in: [m1.uid, m2.uid] } })
            .toArray();
        expect(entries.length).toBe(2);
        expect(new Set(entries.map((e) => e.mailboxUid))).toEqual(new Set([m1.uid, m2.uid]));
        expect(new Set(entries.map((e) => e.rawBlobKey)).size).toBe(1);

        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const stored: Buffer = await blobStore.get(entries[0].rawBlobKey);
        const storedText = stored.toString();
        expect(storedText).toContain(`Reply-To: ${list.primarySmtpAddress}`);
        expect(storedText).toContain("List-Id:");
        expect(storedText).toContain("List-Unsubscribe:");
        expect(storedText).not.toContain("original@example.com");
        expect(storedText).toContain("Hello");
    });

    it("Relays to a genuinely external (non-mailbox, non-list) member via MailTransport.", async () => {
        const list = await createList({ memberAddresses: ["external@outside.com"] });
        const raw = Buffer.from(`From: sender@example.com\r\nTo: ${list.primarySmtpAddress}\r\n\r\nHello\r\n`);

        const result = await request(server.getApplication())
            .post(`${baseUrl}/deliver`)
            .set("Authorization", `Bearer ${secret}`)
            .set("X-Envelope-From", "sender@example.com")
            .set("X-Envelope-To", list.primarySmtpAddress)
            .set("Content-Type", "message/rfc822")
            .send(raw);

        expect(result.status).toBe(202);
        expect(result.body.results).toEqual([{ rcpt: list.primarySmtpAddress, queued: true }]);

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(1);
        expect(transport.sent[0].envelopeTo).toEqual(["external@outside.com"]);
        expect(transport.sent[0].envelopeFrom).toBe(list.primarySmtpAddress);
        expect(transport.sent[0].raw.toString()).toContain("List-Id:");

        const entries: IngestQueueEntryMongo[] = await ingestQueueRepo.find({}).toArray();
        expect(entries.length).toBe(0);
    });

    it("Expands a nested distribution list transitively, delivering exactly once to a member reachable via two paths.", async () => {
        const m1 = await createMailbox();
        const listB = await createList({ memberAddresses: [m1.primarySmtpAddress] });
        const listA = await createList({ memberAddresses: [listB.primarySmtpAddress, m1.primarySmtpAddress] });
        const raw = Buffer.from(`From: sender@example.com\r\nTo: ${listA.primarySmtpAddress}\r\n\r\nHello\r\n`);

        const result = await request(server.getApplication())
            .post(`${baseUrl}/deliver`)
            .set("Authorization", `Bearer ${secret}`)
            .set("X-Envelope-From", "sender@example.com")
            .set("X-Envelope-To", listA.primarySmtpAddress)
            .set("Content-Type", "message/rfc822")
            .send(raw);

        expect(result.status).toBe(202);
        const entries: IngestQueueEntryMongo[] = await ingestQueueRepo.find({ mailboxUid: m1.uid }).toArray();
        expect(entries.length).toBe(1);
    });

    it("Detects a distribution list cycle without hanging or duplicating delivery, while still delivering to a real member.", async () => {
        const m1 = await createMailbox();
        const listA = await createList();
        const listB = await createList({ memberAddresses: [listA.primarySmtpAddress, m1.primarySmtpAddress] });
        const listAFresh: any = await distributionListRepo.findOne({ uid: listA.uid } as any);
        listAFresh.memberAddresses = [listB.primarySmtpAddress];
        await distributionListRepo.save(listAFresh);
        const raw = Buffer.from(`From: sender@example.com\r\nTo: ${listA.primarySmtpAddress}\r\n\r\nHello\r\n`);

        const result = await request(server.getApplication())
            .post(`${baseUrl}/deliver`)
            .set("Authorization", `Bearer ${secret}`)
            .set("X-Envelope-From", "sender@example.com")
            .set("X-Envelope-To", listA.primarySmtpAddress)
            .set("Content-Type", "message/rfc822")
            .send(raw);

        expect(result.status).toBe(202);
        const entries: IngestQueueEntryMongo[] = await ingestQueueRepo.find({ mailboxUid: m1.uid }).toArray();
        expect(entries.length).toBe(1);
    });

    it("restrictSenders drops delivery to a restricted list from a non-member sender, without fan-out or relay.", async () => {
        const m1 = await createMailbox();
        const list = await createList({ memberAddresses: [m1.primarySmtpAddress], restrictSenders: true });
        const raw = Buffer.from(`From: outsider@example.com\r\nTo: ${list.primarySmtpAddress}\r\n\r\nHello\r\n`);

        const result = await request(server.getApplication())
            .post(`${baseUrl}/deliver`)
            .set("Authorization", `Bearer ${secret}`)
            .set("X-Envelope-From", "outsider@example.com")
            .set("X-Envelope-To", list.primarySmtpAddress)
            .set("Content-Type", "message/rfc822")
            .send(raw);

        expect(result.status).toBe(202);
        expect(result.body.results).toEqual([{ rcpt: list.primarySmtpAddress, queued: false }]);

        const entries: IngestQueueEntryMongo[] = await ingestQueueRepo.find({ mailboxUid: m1.uid }).toArray();
        expect(entries.length).toBe(0);
        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(0);
    });

    it("A current member emailing the list with Subject: unsubscribe is removed from memberAddresses and receives a confirmation, without fan-out.", async () => {
        const member = await createMailbox();
        const list = await createList({ memberAddresses: [member.primarySmtpAddress, "other@example.com"] });
        const raw = Buffer.from(
            `From: ${member.primarySmtpAddress}\r\nTo: ${list.primarySmtpAddress}\r\nSubject: unsubscribe\r\n\r\nBye\r\n`,
        );

        const result = await request(server.getApplication())
            .post(`${baseUrl}/deliver`)
            .set("Authorization", `Bearer ${secret}`)
            .set("X-Envelope-From", member.primarySmtpAddress)
            .set("X-Envelope-To", list.primarySmtpAddress)
            .set("Content-Type", "message/rfc822")
            .send(raw);

        expect(result.status).toBe(202);
        expect(result.body.results).toEqual([{ rcpt: list.primarySmtpAddress, queued: false }]);

        const entries: IngestQueueEntryMongo[] = await ingestQueueRepo.find({ mailboxUid: member.uid }).toArray();
        expect(entries.length).toBe(0);

        const updated = await distributionListRepo.findOne({ uid: list.uid } as any);
        expect(updated?.memberAddresses).toEqual(["other@example.com"]);

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(1);
        expect(transport.sent[0].envelopeTo).toEqual([member.primarySmtpAddress]);
        expect(transport.sent[0].envelopeFrom).toBe(list.primarySmtpAddress);
    });

    it("A matching reject transport rule drops the entire message for every recipient and sends a rejection notice to the sender.", async () => {
        const mailbox = await createMailbox();
        await createTransportRule({
            conditions: { subjectContains: ["blocked"] },
            actions: [{ type: TransportRuleActionType.REJECT }],
        });
        const raw = Buffer.from(`From: sender@example.com\r\nSubject: blocked topic\r\n\r\nHello\r\n`);

        const result = await request(server.getApplication())
            .post(`${baseUrl}/deliver`)
            .set("Authorization", `Bearer ${secret}`)
            .set("X-Envelope-From", "sender@example.com")
            .set("X-Envelope-To", mailbox.primarySmtpAddress)
            .set("Content-Type", "message/rfc822")
            .send(raw);

        expect(result.status).toBe(202);
        expect(result.body.results).toEqual([{ rcpt: mailbox.primarySmtpAddress, queued: false }]);

        const entries: IngestQueueEntryMongo[] = await ingestQueueRepo.find({ mailboxUid: mailbox.uid }).toArray();
        expect(entries.length).toBe(0);

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(1);
        expect(transport.sent[0].envelopeTo).toEqual(["sender@example.com"]);
    });

    it("Logs a warning (without failing the whole delivery) when sending the transport-rule rejection notice fails.", async () => {
        const mailbox = await createMailbox();
        await createTransportRule({
            conditions: { subjectContains: ["blocked"] },
            actions: [{ type: TransportRuleActionType.REJECT }],
        });
        const raw = Buffer.from(`From: sender@example.com\r\nSubject: blocked topic\r\n\r\nHello\r\n`);
        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        vi.spyOn(transport, "send").mockRejectedValueOnce(new Error("simulated transport failure"));

        const result = await request(server.getApplication())
            .post(`${baseUrl}/deliver`)
            .set("Authorization", `Bearer ${secret}`)
            .set("X-Envelope-From", "sender@example.com")
            .set("X-Envelope-To", mailbox.primarySmtpAddress)
            .set("Content-Type", "message/rfc822")
            .send(raw);

        expect(result.status).toBe(202);
        expect(result.body.results).toEqual([{ rcpt: mailbox.primarySmtpAddress, queued: false }]);
    });

    it("A matching add_header transport rule tags the stored copy for a direct mailbox delivery.", async () => {
        const mailbox = await createMailbox();
        await createTransportRule({
            actions: [{ type: TransportRuleActionType.ADD_HEADER, headerName: "X-Policy-Tag", headerValue: "flagged" }],
        });
        const raw = Buffer.from(`From: sender@example.com\r\nTo: ${mailbox.primarySmtpAddress}\r\n\r\nHello\r\n`);

        const result = await request(server.getApplication())
            .post(`${baseUrl}/deliver`)
            .set("Authorization", `Bearer ${secret}`)
            .set("X-Envelope-From", "sender@example.com")
            .set("X-Envelope-To", mailbox.primarySmtpAddress)
            .set("Content-Type", "message/rfc822")
            .send(raw);

        expect(result.status).toBe(202);
        const entries: IngestQueueEntryMongo[] = await ingestQueueRepo.find({ mailboxUid: mailbox.uid }).toArray();
        expect(entries.length).toBe(1);

        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const stored: Buffer = await blobStore.get(entries[0].rawBlobKey);
        expect(stored.toString()).toContain("X-Policy-Tag: flagged");
    });

    it("A matching add_header transport rule tags the stored copy for a distribution-list-expanded delivery.", async () => {
        const m1 = await createMailbox();
        const list = await createList({ memberAddresses: [m1.primarySmtpAddress] });
        await createTransportRule({
            actions: [{ type: TransportRuleActionType.ADD_HEADER, headerName: "X-Policy-Tag", headerValue: "flagged" }],
        });
        const raw = Buffer.from(`From: sender@example.com\r\nTo: ${list.primarySmtpAddress}\r\n\r\nHello\r\n`);

        const result = await request(server.getApplication())
            .post(`${baseUrl}/deliver`)
            .set("Authorization", `Bearer ${secret}`)
            .set("X-Envelope-From", "sender@example.com")
            .set("X-Envelope-To", list.primarySmtpAddress)
            .set("Content-Type", "message/rfc822")
            .send(raw);

        expect(result.status).toBe(202);
        const entries: IngestQueueEntryMongo[] = await ingestQueueRepo.find({ mailboxUid: m1.uid }).toArray();
        expect(entries.length).toBe(1);

        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const stored: Buffer = await blobStore.get(entries[0].rawBlobKey);
        const storedText = stored.toString();
        expect(storedText).toContain("X-Policy-Tag: flagged");
        expect(storedText).toContain("List-Id:");
    });

    it("A matching add_recipient transport rule delivers an additional internal copy, resolved like any other recipient.", async () => {
        const mailbox = await createMailbox();
        const compliance = await createMailbox();
        await createTransportRule({
            actions: [{ type: TransportRuleActionType.ADD_RECIPIENT, recipientAddress: compliance.primarySmtpAddress }],
        });
        const raw = Buffer.from(`From: sender@example.com\r\nTo: ${mailbox.primarySmtpAddress}\r\n\r\nHello\r\n`);

        const result = await request(server.getApplication())
            .post(`${baseUrl}/deliver`)
            .set("Authorization", `Bearer ${secret}`)
            .set("X-Envelope-From", "sender@example.com")
            .set("X-Envelope-To", mailbox.primarySmtpAddress)
            .set("Content-Type", "message/rfc822")
            .send(raw);

        expect(result.status).toBe(202);
        const entries: IngestQueueEntryMongo[] = await ingestQueueRepo
            .find({ mailboxUid: { $in: [mailbox.uid, compliance.uid] } })
            .toArray();
        expect(new Set(entries.map((e) => e.mailboxUid))).toEqual(new Set([mailbox.uid, compliance.uid]));
    });

    it("A matching quarantine transport rule stamps quarantineReason on every created IngestQueueEntry.", async () => {
        const mailbox = await createMailbox();
        await createTransportRule({ actions: [{ type: TransportRuleActionType.QUARANTINE }] });
        const raw = Buffer.from(`From: sender@example.com\r\nTo: ${mailbox.primarySmtpAddress}\r\n\r\nHello\r\n`);

        const result = await request(server.getApplication())
            .post(`${baseUrl}/deliver`)
            .set("Authorization", `Bearer ${secret}`)
            .set("X-Envelope-From", "sender@example.com")
            .set("X-Envelope-To", mailbox.primarySmtpAddress)
            .set("Content-Type", "message/rfc822")
            .send(raw);

        expect(result.status).toBe(202);
        const entries: IngestQueueEntryMongo[] = await ingestQueueRepo.find({ mailboxUid: mailbox.uid }).toArray();
        expect(entries.length).toBe(1);
        expect(entries[0].quarantineReason).toBe(QuarantineReason.TRANSPORT_RULE);
    });
});
