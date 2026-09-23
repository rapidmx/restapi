///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { request } from "@rapidrest/service-core/test";
import { Server, ObjectFactory, ConnectionManager, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { In, Repository } from "typeorm";
import { DistributionListSQL } from "../../../src/models/sql/DistributionListSQL.js";
import { DomainSQL } from "../../../src/models/sql/DomainSQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { IngestQueueEntrySQL } from "../../../src/models/sql/IngestQueueEntrySQL.js";
import { TransportRuleSQL } from "../../../src/models/sql/TransportRuleSQL.js";
import { IngestStatus, QuarantineReason, TransportRuleActionType } from "../../../src/models/types.js";
import { InMemoryBlobStore, RecordingMailTransport, registerTestDoubles } from "../../testDoubles.js";
import { ingestBounceSuite, ingestDroppedNoticeSuite } from "../ingestDroppedNoticeSuite.js";

describe("Route:MailIngestRouteSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/internal/mta";
    let mailboxRepo: Repository<MailboxSQL>;
    let ingestQueueRepo: Repository<IngestQueueEntrySQL>;
    let distributionListRepo: Repository<DistributionListSQL>;
    let transportRuleRepo: Repository<TransportRuleSQL>;
    let domainRepo: Repository<DomainSQL>;

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

    const createList = async function (data?: any): Promise<DistributionListSQL> {
        const address: string = data?.primarySmtpAddress ?? `${uuid.v4()}@example.com`;
        const obj: DistributionListSQL = new DistributionListSQL({
            uid: address.toLowerCase(),
            primarySmtpAddress: address,
            aliasAddresses: [],
            name: "Test List",
            memberAddresses: [],
            ...data,
        });
        return await distributionListRepo.save(obj);
    };

    const createDomain = async function (data?: any): Promise<DomainSQL> {
        const name: string = data?.name ?? `${uuid.v4()}.example.com`;
        const obj: DomainSQL = new DomainSQL({
            uid: name,
            name,
            enabled: true,
            verified: true,
            verificationToken: uuid.v4(),
            ...data,
        });
        return await domainRepo.save(obj);
    };

    const createTransportRule = async function (data?: any): Promise<TransportRuleSQL> {
        const obj: TransportRuleSQL = new TransportRuleSQL({
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
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("sql");
        if (isSqlDataSource(conn)) {
            mailboxRepo = conn.getRepository(MailboxSQL);
            ingestQueueRepo = conn.getRepository(IngestQueueEntrySQL);
            distributionListRepo = conn.getRepository(DistributionListSQL);
            transportRuleRepo = conn.getRepository(TransportRuleSQL);
            domainRepo = conn.getRepository(DomainSQL);
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
        await distributionListRepo.clear();
        await transportRuleRepo.clear();
        await domainRepo.clear();
        (objectFactory.getInstance<RecordingMailTransport>("MailTransport")!).sent = [];
    });

    it("Rejects a domain request without the internal bearer secret.", async () => {
        const domain = await createDomain();
        const result = await request(server.getApplication()).get(`${baseUrl}/domain?name=${domain.name}`);
        expect(result.status).toBe(403);
    });

    it("Rejects a domain request with no name query parameter.", async () => {
        const result = await request(server.getApplication())
            .get(`${baseUrl}/domain`)
            .set("Authorization", `Bearer ${secret}`);
        expect(result.status).toBe(400);
    });

    it("Resolves 200 for an enabled, verified domain.", async () => {
        const domain = await createDomain();
        const result = await request(server.getApplication())
            .get(`${baseUrl}/domain?name=${domain.name}`)
            .set("Authorization", `Bearer ${secret}`);
        expect(result.status).toBe(200);
    });

    it("Resolves 404 for a domain that isn't verified yet.", async () => {
        const domain = await createDomain({ verified: false });
        const result = await request(server.getApplication())
            .get(`${baseUrl}/domain?name=${domain.name}`)
            .set("Authorization", `Bearer ${secret}`);
        expect(result.status).toBe(404);
    });

    it("Resolves 404 for a domain with no matching Domain record.", async () => {
        const result = await request(server.getApplication())
            .get(`${baseUrl}/domain?name=nobody.example.com`)
            .set("Authorization", `Bearer ${secret}`);
        expect(result.status).toBe(404);
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

    it("Decodes percent-encoded X-Envelope-From/X-Envelope-To addresses (the ingest client's own encoding), so a comma inside an address isn't mistaken for the recipient-list separator and a non-ASCII local part survives intact.", async () => {
        const mailbox = await createMailbox();
        const weirdSender = "josé,doe@example.com"; // comma AND non-ASCII in one address, deliberately.
        const weirdRecipient = "weird,recipient@example.com"; // unresolvable, but must arrive as ONE recipient.
        const raw = Buffer.from("From: sender@example.com\r\nTo: " + mailbox.primarySmtpAddress + "\r\n\r\nHello\r\n");

        const result = await request(server.getApplication())
            .post(`${baseUrl}/deliver`)
            .set("Authorization", `Bearer ${secret}`)
            .set("X-Envelope-From", encodeURIComponent(weirdSender))
            .set("X-Envelope-To", [encodeURIComponent(mailbox.primarySmtpAddress), encodeURIComponent(weirdRecipient)].join(","))
            .set("Content-Type", "message/rfc822")
            .send(raw);

        expect(result.status).toBe(202);
        // Exactly two recipients - the embedded comma in the second, percent-encoded address must not have
        // been mistaken for the list separator and split it into a bogus third (garbled) entry.
        expect(result.body.results).toEqual([
            { rcpt: mailbox.primarySmtpAddress, queued: true },
            { rcpt: weirdRecipient, queued: false },
        ]);

        const entries: IngestQueueEntrySQL[] = await ingestQueueRepo.find({ where: { mailboxUid: mailbox.uid } });
        expect(entries.length).toBe(1);
        // The decoded sender - comma and non-ASCII character intact - not the raw percent-encoded header value.
        expect(entries[0].envelopeFrom).toBe(weirdSender);
    });

    describe("domain alias", () => {
        it("Accepts the /domain relay check for a pure alias domain, same as any other verified domain.", async () => {
            await createDomain({ name: "powerlevel.gg" });
            await createDomain({ name: "plc.gg", aliasOf: "powerlevel.gg" });

            const result = await request(server.getApplication())
                .get(`${baseUrl}/domain?name=plc.gg`)
                .set("Authorization", `Bearer ${secret}`);
            expect(result.status).toBe(200);
        });

        it("Resolves a recipient addressed at the alias domain to the mailbox provisioned on the primary domain.", async () => {
            await createDomain({ name: "powerlevel.gg" });
            await createDomain({ name: "plc.gg", aliasOf: "powerlevel.gg" });
            await createMailbox({ primarySmtpAddress: "jean-philippe@powerlevel.gg" });

            const result = await request(server.getApplication())
                .get(`${baseUrl}/resolve?rcpt=jean-philippe@plc.gg`)
                .set("Authorization", `Bearer ${secret}`);

            expect(result.status).toBe(200);
        });

        it("Delivers a message addressed at the alias domain into the primary domain's mailbox.", async () => {
            await createDomain({ name: "powerlevel.gg" });
            await createDomain({ name: "plc.gg", aliasOf: "powerlevel.gg" });
            const mailbox = await createMailbox({ primarySmtpAddress: "jean-philippe@powerlevel.gg" });
            const raw = Buffer.from("From: sender@example.com\r\nTo: jean-philippe@plc.gg\r\n\r\nHello\r\n");

            const result = await request(server.getApplication())
                .post(`${baseUrl}/deliver`)
                .set("Authorization", `Bearer ${secret}`)
                .set("X-Envelope-From", "sender@example.com")
                .set("X-Envelope-To", "jean-philippe@plc.gg")
                .set("Content-Type", "message/rfc822")
                .send(raw);

            expect(result.status).toBe(202);
            expect(result.body.results).toEqual([{ rcpt: "jean-philippe@plc.gg", queued: true }]);

            const entries: IngestQueueEntrySQL[] = await ingestQueueRepo.find({ where: { mailboxUid: mailbox.uid } });
            expect(entries.length).toBe(1);
        });

        it("Delivers a message addressed at the alias domain into a DistributionList provisioned on the primary domain.", async () => {
            await createDomain({ name: "powerlevel.gg" });
            await createDomain({ name: "plc.gg", aliasOf: "powerlevel.gg" });
            const member = await createMailbox({ primarySmtpAddress: "member@powerlevel.gg" });
            await createList({ primarySmtpAddress: "sales@powerlevel.gg", memberAddresses: [member.primarySmtpAddress] });
            const raw = Buffer.from("From: sender@example.com\r\nTo: sales@plc.gg\r\n\r\nHello\r\n");

            const result = await request(server.getApplication())
                .post(`${baseUrl}/deliver`)
                .set("Authorization", `Bearer ${secret}`)
                .set("X-Envelope-From", "sender@example.com")
                .set("X-Envelope-To", "sales@plc.gg")
                .set("Content-Type", "message/rfc822")
                .send(raw);

            expect(result.status).toBe(202);

            const entries: IngestQueueEntrySQL[] = await ingestQueueRepo.find({ where: { mailboxUid: member.uid } });
            expect(entries.length).toBe(1);
        });

        it("Reports a recipient at an alias domain as unresolvable when no matching mailbox exists on the primary domain.", async () => {
            await createDomain({ name: "powerlevel.gg" });
            await createDomain({ name: "plc.gg", aliasOf: "powerlevel.gg" });

            const result = await request(server.getApplication())
                .get(`${baseUrl}/resolve?rcpt=nobody@plc.gg`)
                .set("Authorization", `Bearer ${secret}`);

            expect(result.status).toBe(404);
        });

        it("Does not rewrite a recipient whose domain is disabled as an alias (falls through, unresolvable).", async () => {
            await createDomain({ name: "powerlevel.gg" });
            await createDomain({ name: "plc.gg", aliasOf: "powerlevel.gg", enabled: false });
            await createMailbox({ primarySmtpAddress: "jean-philippe@powerlevel.gg" });

            const result = await request(server.getApplication())
                .get(`${baseUrl}/resolve?rcpt=jean-philippe@plc.gg`)
                .set("Authorization", `Bearer ${secret}`);

            expect(result.status).toBe(404);
        });
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

        const entries: IngestQueueEntrySQL[] = await ingestQueueRepo.find({ where: { mailboxUid: mailbox.uid } });
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

    ingestBounceSuite({
        app: () => server.getApplication(),
        baseUrl,
        secret,
        blobStore: () => objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!,
        createMailbox,
        entries: () => ingestQueueRepo.find({}),
    });

    ingestDroppedNoticeSuite({
        app: () => server.getApplication(),
        baseUrl,
        secret,
        blobStore: () => objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!,
        createMailbox,
        entries: () => ingestQueueRepo.find({}),
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

        const entries: IngestQueueEntrySQL[] = await ingestQueueRepo.find({
            where: { mailboxUid: In([m1.uid, m2.uid]) },
        });
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

    it("Multiple direct-mailbox recipients in the same envelope all share one blob-stored copy of the raw message - previously wrote a full duplicate per recipient.", async () => {
        const m1 = await createMailbox();
        const m2 = await createMailbox();
        const raw = Buffer.from(
            `From: sender@example.com\r\nTo: ${m1.primarySmtpAddress}, ${m2.primarySmtpAddress}\r\n\r\nHello\r\n`,
        );

        const result = await request(server.getApplication())
            .post(`${baseUrl}/deliver`)
            .set("Authorization", `Bearer ${secret}`)
            .set("X-Envelope-From", "sender@example.com")
            .set("X-Envelope-To", `${m1.primarySmtpAddress},${m2.primarySmtpAddress}`)
            .set("Content-Type", "message/rfc822")
            .send(raw);

        expect(result.status).toBe(202);
        expect(result.body.results).toEqual([
            { rcpt: m1.primarySmtpAddress, queued: true },
            { rcpt: m2.primarySmtpAddress, queued: true },
        ]);

        const entries: IngestQueueEntrySQL[] = await ingestQueueRepo.find({
            where: { mailboxUid: In([m1.uid, m2.uid]) },
        });
        expect(entries.length).toBe(2);
        expect(new Set(entries.map((e) => e.rawBlobKey)).size).toBe(1);

        const blobStore = objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
        const stored: Buffer = await blobStore.get(entries[0].rawBlobKey);
        expect(stored.toString()).toContain("Hello");
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

        const entries: IngestQueueEntrySQL[] = await ingestQueueRepo.find({});
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
        const entries: IngestQueueEntrySQL[] = await ingestQueueRepo.find({ where: { mailboxUid: m1.uid } });
        expect(entries.length).toBe(1);
    });

    it("Detects a distribution list cycle without hanging or duplicating delivery, while still delivering to a real member.", async () => {
        const m1 = await createMailbox();
        const listA = await createList();
        const listB = await createList({ memberAddresses: [listA.primarySmtpAddress, m1.primarySmtpAddress] });
        const listAFresh: any = await distributionListRepo.findOne({ where: { uid: listA.uid } });
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
        const entries: IngestQueueEntrySQL[] = await ingestQueueRepo.find({ where: { mailboxUid: m1.uid } });
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

        const entries: IngestQueueEntrySQL[] = await ingestQueueRepo.find({ where: { mailboxUid: m1.uid } });
        expect(entries.length).toBe(0);
        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(0);
    });

    it("An unsubscribe without aligned passing DKIM from the trusted MTA (a forgeable envelope sender) is ignored and not fanned out.", async () => {
        const member = await createMailbox();
        const list = await createList({ memberAddresses: [member.primarySmtpAddress, "other@example.com"] });
        const forgeries: string[] = [
            `From: ${member.primarySmtpAddress}\r\nSubject: unsubscribe\r\n\r\nBye\r\n`,
            `Authentication-Results: attacker.example; dkim=pass header.d=example.com\r\nFrom: ${member.primarySmtpAddress}\r\nSubject: unsubscribe\r\n\r\nBye\r\n`,
            `Authentication-Results: mx.example.com; dkim=pass header.d=elsewhere.test\r\nFrom: ${member.primarySmtpAddress}\r\nSubject: unsubscribe\r\n\r\nBye\r\n`,
            `Authentication-Results: mx.example.com; dkim=pass header.d=example.com\r\nFrom: someone-else@example.com\r\nSubject: unsubscribe\r\n\r\nBye\r\n`,
            `Authentication-Results: mx.example.com; dkim=pass header.d=example.com\r\nFrom: ${member.primarySmtpAddress}\r\nFrom: ${member.primarySmtpAddress}\r\nSubject: unsubscribe\r\n\r\nBye\r\n`,
        ];
        for (const raw of forgeries) {
            const result = await request(server.getApplication())
                .post(`${baseUrl}/deliver`)
                .set("Authorization", `Bearer ${secret}`)
                .set("X-Envelope-From", member.primarySmtpAddress)
                .set("X-Envelope-To", list.primarySmtpAddress)
                .set("Content-Type", "message/rfc822")
                .send(Buffer.from(raw));
            expect(result.status).toBe(202);
            expect(result.body.results).toEqual([{ rcpt: list.primarySmtpAddress, queued: false }]);
        }
        const updated = await distributionListRepo.findOne({ where: { uid: list.uid } });
        expect(updated?.memberAddresses).toEqual([member.primarySmtpAddress, "other@example.com"]);
        expect(objectFactory.getInstance<RecordingMailTransport>("MailTransport")!.sent.length).toBe(0);
        expect((await ingestQueueRepo.find({ where: { mailboxUid: member.uid } })).length).toBe(0);
    });

    it("A current member emailing the list with Subject: unsubscribe is removed from memberAddresses and receives a confirmation, without fan-out.", async () => {
        const member = await createMailbox();
        const list = await createList({ memberAddresses: [member.primarySmtpAddress, "other@example.com"] });
        const raw = Buffer.from(
            `Authentication-Results: mx.example.com; dkim=pass header.d=example.com\r\nFrom: ${member.primarySmtpAddress}\r\nTo: ${list.primarySmtpAddress}\r\nSubject: unsubscribe\r\n\r\nBye\r\n`,
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

        const entries: IngestQueueEntrySQL[] = await ingestQueueRepo.find({ where: { mailboxUid: member.uid } });
        expect(entries.length).toBe(0);

        const updated = await distributionListRepo.findOne({ where: { uid: list.uid } });
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

        const entries: IngestQueueEntrySQL[] = await ingestQueueRepo.find({ where: { mailboxUid: mailbox.uid } });
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
        const entries: IngestQueueEntrySQL[] = await ingestQueueRepo.find({ where: { mailboxUid: mailbox.uid } });
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
        const entries: IngestQueueEntrySQL[] = await ingestQueueRepo.find({ where: { mailboxUid: m1.uid } });
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
        const entries: IngestQueueEntrySQL[] = await ingestQueueRepo.find({
            where: { mailboxUid: In([mailbox.uid, compliance.uid]) },
        });
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
        const entries: IngestQueueEntrySQL[] = await ingestQueueRepo.find({ where: { mailboxUid: mailbox.uid } });
        expect(entries.length).toBe(1);
        expect(entries[0].quarantineReason).toBe(QuarantineReason.TRANSPORT_RULE);
    });

    describe("Round 5: distribution-list relay can't launder spoofed mail", () => {
        const deliver = (from: string, to: string, raw: string) =>
            request(server.getApplication())
                .post(`${baseUrl}/deliver`)
                .set("Authorization", `Bearer ${secret}`)
                .set("X-Envelope-From", from)
                .set("X-Envelope-To", to)
                .set("Content-Type", "message/rfc822")
                .send(Buffer.from(raw));
        const entriesFor = async (mailboxUid: string): Promise<any[]> => await ingestQueueRepo.find({ where: { mailboxUid } });
        const transport = (): RecordingMailTransport => objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        const headerBlock = (raw: Buffer): string => {
            const text: string = raw.toString("binary");
            return text.slice(0, text.indexOf("\r\n\r\n"));
        };

        it("restrictSenders needs a DKIM-verified From naming a member - a forged envelope sender or From is dropped.", async () => {
            const member = await createMailbox();
            const list = await createList({ memberAddresses: [member.primarySmtpAddress], restrictSenders: true });
            const forged = await deliver(member.primarySmtpAddress, list.primarySmtpAddress, `From: ${member.primarySmtpAddress}\r\nSubject: hi\r\n\r\nHello\r\n`);
            expect(forged.body.results).toEqual([{ rcpt: list.primarySmtpAddress, queued: false }]);
            expect(await entriesFor(member.uid)).toHaveLength(0);

            const verified = await deliver(
                "bounces@somewhere.example",
                list.primarySmtpAddress,
                `Authentication-Results: mx.example.com; dkim=pass header.d=example.com\r\nFrom: ${member.primarySmtpAddress}\r\nSubject: hi\r\n\r\nHello\r\n`,
            );
            expect(verified.body.results).toEqual([{ rcpt: list.primarySmtpAddress, queued: true }]);
            expect(await entriesFor(member.uid)).toHaveLength(1);
        });

        it("An unauthenticated From is rewritten to the list for external members, and trust-bearing headers are stripped.", async () => {
            const internal = await createMailbox();
            const list = await createList({ memberAddresses: [internal.primarySmtpAddress, "external@outside.com"] });
            const raw = [
                "Authentication-Results: mx.example.com; dkim=fail header.d=example.com",
                "From: CEO <ceo@example.com>",
                "RapidMX-Key: addr=ceo@example.com; keydata=AAAA",
                "X-RapidMX-Recall-Of: <victim@example.com>",
                "Disposition-Notification-To: ceo@example.com",
                `To: ${list.primarySmtpAddress}`,
                "Subject: urgent",
                "",
                "Pay this invoice.",
                "",
            ].join("\r\n");

            const result = await deliver("attacker@evil.example", list.primarySmtpAddress, raw);

            expect(result.body.results).toEqual([{ rcpt: list.primarySmtpAddress, queued: true }]);
            expect(transport().sent).toHaveLength(1);
            const relayed: string = headerBlock(transport().sent[0].raw);
            expect(relayed).toMatch(/^From: "Test List" <[^>]+>$/m);
            expect(relayed).toContain(`<${list.primarySmtpAddress}>`);
            expect(relayed).toContain("X-Original-From: CEO <ceo@example.com>");
            expect(relayed).not.toMatch(/^(authentication-results|rapidmx-key|x-rapidmx-recall-of|disposition-notification-to)\s*:/im);
            expect(transport().sent[0].raw.toString()).toContain("Pay this invoice.");

            // The internal member's copy keeps the original headers for ScanQueueJob to judge.
            const entries = await entriesFor(internal.uid);
            expect(entries).toHaveLength(1);
            const stored: string = (await objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!.get(entries[0].rawBlobKey)).toString();
            expect(stored).toContain("From: CEO <ceo@example.com>");
        });

        it("An authenticated From is relayed unchanged (Authentication-Results still stripped).", async () => {
            const list = await createList({ memberAddresses: ["external@outside.com"] });
            const raw = `Authentication-Results: mx.example.com; dkim=pass header.d=partner.example\r\nFrom: Bob <bob@partner.example>\r\nSubject: hi\r\n\r\nHello\r\n`;

            await deliver("bob@partner.example", list.primarySmtpAddress, raw);

            expect(transport().sent).toHaveLength(1);
            const relayed: string = headerBlock(transport().sent[0].raw);
            expect(relayed).toContain("From: Bob <bob@partner.example>");
            expect(relayed).not.toContain("X-Original-From");
            expect(relayed).not.toMatch(/^authentication-results\s*:/im);
        });

        it("Unauthenticated calendar content isn't relayed to external members; internal members still get it.", async () => {
            const internal = await createMailbox();
            const list = await createList({ memberAddresses: [internal.primarySmtpAddress, "external@outside.com"] });
            const raw = [
                "From: ceo@example.com",
                "Subject: Cancelled",
                'Content-Type: text/calendar; method=CANCEL; charset="utf-8"',
                "",
                "BEGIN:VCALENDAR",
                "METHOD:CANCEL",
                "END:VCALENDAR",
                "",
            ].join("\r\n");

            const result = await deliver("attacker@evil.example", list.primarySmtpAddress, raw);

            expect(result.body.results).toEqual([{ rcpt: list.primarySmtpAddress, queued: true }]);
            expect(transport().sent).toHaveLength(0);
            expect(await entriesFor(internal.uid)).toHaveLength(1);

            const externalOnly = await createList({ memberAddresses: ["external@outside.com"] });
            const skipped = await deliver("attacker@evil.example", externalOnly.primarySmtpAddress, raw);
            expect(skipped.body.results).toEqual([{ rcpt: externalOnly.primarySmtpAddress, queued: false }]);
            expect(transport().sent).toHaveLength(0);
        });
    });
});
