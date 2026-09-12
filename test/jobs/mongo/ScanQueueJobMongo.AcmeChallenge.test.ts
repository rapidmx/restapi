///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// See test/jobs/sql/ScanQueueJobSQL.AcmeChallenge.test.ts's identical file header - kept as its own file
// for the same reason.
import "reflect-metadata";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as x509 from "@peculiar/x509";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ACLUtils, ConnectionManager, MongoConnection, MongoRepository, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../../config.js";
import { registerTestDoubles, RecordingMailTransport } from "../../testDoubles.js";
import { ScanQueueJobMongo } from "../../../src/jobs/mongo/ScanQueueJobMongo.js";
import { IngestQueueEntryMongo } from "../../../src/models/mongo/IngestQueueEntryMongo.js";
import { FolderMongo } from "../../../src/models/mongo/FolderMongo.js";
import { MessageMongo } from "../../../src/models/mongo/MessageMongo.js";
import { AttachmentMongo } from "../../../src/models/mongo/AttachmentMongo.js";
import { QuarantineEntryMongo } from "../../../src/models/mongo/QuarantineEntryMongo.js";
import { ScanResultMongo } from "../../../src/models/mongo/ScanResultMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { MailFilterRuleMongo } from "../../../src/models/mongo/MailFilterRuleMongo.js";
import { CalendarEventMongo } from "../../../src/models/mongo/CalendarEventMongo.js";
import { ContactMongo } from "../../../src/models/mongo/ContactMongo.js";
import { DomainMongo } from "../../../src/models/mongo/DomainMongo.js";
import { FocusedInboxOverrideMongo } from "../../../src/models/mongo/FocusedInboxOverrideMongo.js";
import { OofReplySuppressionMongo } from "../../../src/models/mongo/OofReplySuppressionMongo.js";
import { IngestStatus } from "../../../src/models/types.js";
import { Rfc8823AcmeSigningCertificateEnrollment } from "../../../src/pki/Rfc8823AcmeSigningCertificateEnrollment.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

x509.cryptoProvider.set(crypto);

async function generateCsr(identity: string): Promise<string> {
    const keys: CryptoKeyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
    ]);
    const csr = await x509.Pkcs10CertificateRequestGenerator.create({
        name: `CN=${identity}`,
        keys,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    });
    return csr.toString("pem");
}

/** Enough of `acme-client`'s `Client` for `startEnrollment()` to seed a real pending enrollment with no
 * network call - see test/pki/Rfc8823AcmeSigningCertificateEnrollment.test.ts's identical fake. */
class FakeAcmeClient {
    constructor(public opts: any) {}
    public getAccountUrl(): string {
        return "https://acme.test/acct/1";
    }
    public async createAccount(): Promise<any> {
        return { status: "valid", orders: "https://acme.test/acct/1/orders" };
    }
    public async createOrder(data: any): Promise<any> {
        return {
            url: "https://acme.test/order/1",
            status: "pending",
            identifiers: data.identifiers,
            authorizations: ["https://acme.test/authz/1"],
            finalize: "https://acme.test/order/1/finalize",
        };
    }
    public async getAuthorizations(): Promise<any[]> {
        return [
            {
                url: "https://acme.test/authz/1",
                status: "pending",
                identifier: { type: "email", value: "recipient@example.com" },
                challenges: [
                    {
                        type: "email-reply-00",
                        url: "https://acme.test/chall/1",
                        status: "pending",
                        from: "acme-challenge+abc123@acme.test",
                        token: "token-part-2-value",
                    },
                ],
            },
        ];
    }
    public async getChallengeKeyAuthorization(challenge: any): Promise<string> {
        return `${challenge.token}.test-account-thumbprint`;
    }
}

class TestEnrollment extends Rfc8823AcmeSigningCertificateEnrollment {
    protected createClient(opts: any): any {
        return new FakeAcmeClient(opts);
    }
}

function makeAcmeChallengeRaw(tokenPart1: string, opts: { from?: string; replyTo?: string } = {}): Buffer {
    const from = opts.from ?? "acme-challenge+abc123@acme.test";
    const raw = [
        `From: ${from}`,
        "To: recipient@example.com",
        ...(opts.replyTo ? [`Reply-To: ${opts.replyTo}`] : []),
        `Subject: ACME: ${tokenPart1}`,
        "Auto-Submitted: auto-generated; type=acme",
        "Message-ID: <challenge-1@acme.test>",
        "",
        "This is an automated message from the certificate authority.",
        "",
    ].join("\r\n");
    return Buffer.from(raw);
}

describe("ScanQueueJobMongo Tests - RFC 8823 challenge-email correlation", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: ScanQueueJobMongo;
    let ingestQueueRepo: MongoRepository<IngestQueueEntryMongo>;
    let folderRepo: MongoRepository<FolderMongo>;
    let messageRepo: MongoRepository<MessageMongo>;
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let enrollment: TestEnrollment;
    let tmpDir: string;

    const mailboxUid = uuid.v4();

    const createIngestEntry = async (rawBlobKey: string, envelopeFrom = "acme-challenge+abc123@acme.test"): Promise<IngestQueueEntryMongo> => {
        const obj = new IngestQueueEntryMongo({
            mailboxUid,
            envelopeFrom,
            envelopeTo: ["recipient@example.com"],
            rawBlobKey,
            status: IngestStatus.PENDING,
        });
        return await ingestQueueRepo.save(obj);
    };

    beforeAll(async () => {
        await mongod.start();
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "scanqueue-acme-test-"));
        objectFactory = new ObjectFactory(config, logger);
        registerTestDoubles(objectFactory);
        objectFactory.register(ACLUtils);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("IngestQueueEntryMongo", IngestQueueEntryMongo);
        models.set("FolderMongo", FolderMongo);
        models.set("MessageMongo", MessageMongo);
        models.set("AttachmentMongo", AttachmentMongo);
        models.set("QuarantineEntryMongo", QuarantineEntryMongo);
        models.set("ScanResultMongo", ScanResultMongo);
        models.set("MailboxMongo", MailboxMongo);
        models.set("MailFilterRuleMongo", MailFilterRuleMongo);
        models.set("CalendarEventMongo", CalendarEventMongo);
        models.set("OofReplySuppressionMongo", OofReplySuppressionMongo);
        models.set("FocusedInboxOverrideMongo", FocusedInboxOverrideMongo);
        models.set("ContactMongo", ContactMongo);
        models.set("DomainMongo", DomainMongo);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        ingestQueueRepo = conn.getMongoRepository("IngestQueueEntryMongo");
        folderRepo = conn.getMongoRepository("FolderMongo");
        messageRepo = conn.getMongoRepository("MessageMongo");
        mailboxRepo = conn.getMongoRepository("MailboxMongo");

        job = await objectFactory.newInstance(ScanQueueJobMongo, { name: "default" });
        enrollment = new TestEnrollment();
        (enrollment as any).storeDir = tmpDir;
        (job as any).signingCertificateEnrollment = enrollment;
    });

    afterAll(async () => {
        await objectFactory.destroy();
        await mongod.stop();
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
        for (const repo of [ingestQueueRepo, folderRepo, messageRepo, mailboxRepo]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
        (objectFactory.getInstance<RecordingMailTransport>("MailTransport")!).sent = [];
        await fs.rm(tmpDir, { recursive: true, force: true });
        await fs.mkdir(tmpDir, { recursive: true });
        await mailboxRepo.save(
            new MailboxMongo({
                uid: mailboxUid,
                primarySmtpAddress: "recipient@example.com",
                aliasAddresses: [],
                displayName: "Recipient Mailbox",
                timezone: "UTC",
                quotaBytes: 1_000_000_000,
                usedBytes: 0,
            }),
        );
    });

    it("Correlates a genuine RFC 8823 challenge email to a pending enrollment and never files it to the Inbox.", async () => {
        await enrollment.startEnrollment("recipient@example.com", await generateCsr("recipient@example.com"));

        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makeAcmeChallengeRaw("token-part-1-value"));
        await createIngestEntry(rawBlobKey);

        await job.run();

        const messages = await messageRepo.find({ mailboxUid }).toArray();
        expect(messages).toHaveLength(0);
        const entries = await ingestQueueRepo.find({ mailboxUid }).toArray();
        expect(entries[0].status).toBe(IngestStatus.DELIVERED);
    });

    it("Never correlates (and never throws) when the entry's own mailbox no longer exists.", async () => {
        const orphanMailboxUid = uuid.v4();
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makeAcmeChallengeRaw("token-part-1-value"));
        await ingestQueueRepo.save(
            new IngestQueueEntryMongo({
                mailboxUid: orphanMailboxUid,
                envelopeFrom: "acme-challenge+abc123@acme.test",
                envelopeTo: ["ghost@example.com"],
                rawBlobKey,
                status: IngestStatus.PENDING,
            }),
        );

        await expect(job.run()).resolves.toBeUndefined();

        const entries = await ingestQueueRepo.find({ mailboxUid: orphanMailboxUid }).toArray();
        expect(entries[0].status).not.toBe(IngestStatus.PENDING);
    });

    it("Delivers a message with the exact ACME header shape normally when it doesn't correlate to any pending enrollment.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makeAcmeChallengeRaw("no-such-enrollment"));
        await createIngestEntry(rawBlobKey);

        await job.run();

        const messages = await messageRepo.find({ mailboxUid }).toArray();
        expect(messages).toHaveLength(1);
    });

    it("Delivers an ordinary message (no Auto-Submitted header at all) normally, without ever consulting the enrollment service.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(
            rawBlobKey,
            Buffer.from("From: sender@example.com\r\nTo: recipient@example.com\r\nSubject: Hello\r\n\r\nHi there.\r\n"),
        );
        await createIngestEntry(rawBlobKey, "sender@example.com");

        await job.run();

        const messages = await messageRepo.find({ mailboxUid }).toArray();
        expect(messages).toHaveLength(1);
    });

    it("Delivers an Auto-Submitted: type=acme message with no Subject header at all normally.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(
            rawBlobKey,
            Buffer.from(
                [
                    "From: acme-challenge+abc123@acme.test",
                    "To: recipient@example.com",
                    "Auto-Submitted: auto-generated; type=acme",
                    "",
                    "Body.",
                    "",
                ].join("\r\n"),
            ),
        );
        await createIngestEntry(rawBlobKey);

        await job.run();

        const messages = await messageRepo.find({ mailboxUid }).toArray();
        expect(messages).toHaveLength(1);
    });

    it("Delivers an Auto-Submitted: type=acme message with a non-matching Subject shape normally.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(
            rawBlobKey,
            Buffer.from(
                [
                    "From: acme-challenge+abc123@acme.test",
                    "To: recipient@example.com",
                    "Subject: Not an ACME challenge",
                    "Auto-Submitted: auto-generated; type=acme",
                    "",
                    "Body.",
                    "",
                ].join("\r\n"),
            ),
        );
        await createIngestEntry(rawBlobKey);

        await job.run();

        const messages = await messageRepo.find({ mailboxUid }).toArray();
        expect(messages).toHaveLength(1);
    });

    it("Falls through to normal delivery when no SigningCertificateEnrollment is registered at all.", async () => {
        (job as any).signingCertificateEnrollment = undefined;
        try {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const rawBlobKey = `raw/${uuid.v4()}`;
            await blobStore.put(rawBlobKey, makeAcmeChallengeRaw("token-part-1-value"));
            await createIngestEntry(rawBlobKey);

            await job.run();

            const messages = await messageRepo.find({ mailboxUid }).toArray();
            expect(messages).toHaveLength(1);
        } finally {
            (job as any).signingCertificateEnrollment = enrollment;
        }
    });

    it("Records replyToAddress from the challenge email's Reply-To header, falling back to From otherwise.", async () => {
        const { enrollmentId } = await enrollment.startEnrollment("recipient@example.com", await generateCsr("recipient@example.com"));

        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const rawBlobKey = `raw/${uuid.v4()}`;
        await blobStore.put(rawBlobKey, makeAcmeChallengeRaw("token-part-1-value", { replyTo: "custom-reply@acme.test" }));
        await createIngestEntry(rawBlobKey);

        await job.run();

        const storePath = path.join(tmpDir, "enrollments.json");
        const store = JSON.parse(await fs.readFile(storePath, "utf-8"));
        expect(store[enrollmentId].replyTo).toBe("custom-reply@acme.test");
        expect(store[enrollmentId].tokenPart1).toBe("token-part-1-value");
    });
});
