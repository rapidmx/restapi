///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for SearchIndexJobSQL: a real SQLite (better-sqlite3) connection and a real
// `ObjectFactory` construct the job exactly as production wiring would - see SearchIndexJobMongo.test.ts's file
// header for the full rationale (also applies here verbatim). Uses `config.sql.ts`, whose `acl` datastore is
// ALSO SQL-backed (`AccessControlListSQL`, auto-selected by `ACLUtils` from the connection's runtime type) - so
// this file has no MongoDB dependency at all.
import { ACLUtils, AccessControlListSQL, ConnectionManager, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import config from "../../config.sql.js";
import { registerTestDoubles, NoopSearchProvider } from "../../testDoubles.js";
import { SearchIndexJobSQL } from "../../../src/jobs/sql/SearchIndexJobSQL.js";
import { AttachmentSQL } from "../../../src/models/sql/AttachmentSQL.js";
import { MessageSQL } from "../../../src/models/sql/MessageSQL.js";
import { RecipientType } from "../../../src/models/types.js";

describe("SearchIndexJobSQL Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: SearchIndexJobSQL;
    let messageRepo: Repository<MessageSQL>;
    let attachmentRepo: Repository<AttachmentSQL>;

    const mailboxUid = uuid.v4();

    const createMessage = async (data?: Partial<MessageSQL>): Promise<MessageSQL> => {
        const obj = new MessageSQL({
            folderUid: uuid.v4(),
            mailboxUid,
            messageId: `<${uuid.v4()}@example.com>`,
            subject: "Hello",
            from: { address: "sender@example.com", type: RecipientType.TO },
            recipients: [{ address: "recipient@example.com", type: RecipientType.TO }],
            bodyBlobKey: `body/${uuid.v4()}`,
            ...data,
        });
        return await messageRepo.save(obj);
    };

    const createAttachment = async (data?: Partial<AttachmentSQL>): Promise<AttachmentSQL> => {
        const obj = new AttachmentSQL({
            messageUid: uuid.v4(),
            folderUid: uuid.v4(),
            mailboxUid,
            filename: "file.txt",
            mimeType: "text/plain",
            sizeBytes: 0,
            blobKey: `attachments/${uuid.v4()}`,
            isInline: false,
            ...data,
        });
        return await attachmentRepo.save(obj);
    };

    beforeAll(async () => {
        objectFactory = new ObjectFactory(config, logger);
        registerTestDoubles(objectFactory);
        // Normally registered by `Server`'s own bootstrap - registered explicitly here since this file
        // deliberately bypasses `Server` (see SearchIndexJobMongo.test.ts's header comment).
        objectFactory.register(ACLUtils);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        // Not auto-discovered here the way `Server`'s `ClassLoader` scan would - a bare TypeORM `DataSource`
        // throws "No metadata found" from `getRepository()` for any entity not explicitly in this map.
        models.set("AccessControlListSQL", AccessControlListSQL);
        models.set("MessageSQL", MessageSQL);
        models.set("AttachmentSQL", AttachmentSQL);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        messageRepo = conn.getRepository(MessageSQL);
        attachmentRepo = conn.getRepository(AttachmentSQL);

        // Constructed once via real ObjectFactory DI: `@Init` builds its two real `RepoUtils` against the live
        // connection above, and `@Inject("BlobStore")`/`@Inject("SearchProvider")` resolve to the registered
        // test doubles.
        job = await objectFactory.newInstance(SearchIndexJobSQL, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        for (const repo of [messageRepo, attachmentRepo]) {
            await repo.clear();
        }
        objectFactory.getInstance<NoopSearchProvider>("SearchProvider")!.indexed.clear();
    });

    it("Exposes the configured cron schedule.", () => {
        expect(job.schedule).toBe(config.get("mail:jobs:search_index:schedule"));
    });

    it("start() and stop() are no-ops beyond init().", async () => {
        await expect(job.start()).resolves.toBeUndefined();
        expect(job.stop()).toBeUndefined();
    });

    it("Does nothing when there are no pending messages.", async () => {
        await expect(job.run()).resolves.toBeUndefined();
        const searchProvider = objectFactory.getInstance<NoopSearchProvider>("SearchProvider")!;
        expect(searchProvider.indexed.size).toBe(0);
    });

    // `messageRepo`/`searchProvider`/`blobStore` are always set by the time `run()` can be called through real
    // DI - `@Init` (which builds `messageRepo`) and both `@Inject(...)` resolutions complete before
    // `objectFactory.newInstance()` ever resolves. These guards defend against a call to `run()` before
    // construction finishes, which never happens in production (`BackgroundServiceManager` always awaits
    // construction first) - the only way to exercise them is to force the field back to `undefined` on an
    // otherwise fully real job instance, same as the guard clause's own defensive intent.
    it("Does nothing when messageRepo is not yet initialized.", async () => {
        const real = (job as any).messageRepo;
        (job as any).messageRepo = undefined;
        try {
            await expect(job.run()).resolves.toBeUndefined();
        } finally {
            (job as any).messageRepo = real;
        }
    });

    it("Does nothing when searchProvider is not yet initialized.", async () => {
        const real = (job as any).searchProvider;
        (job as any).searchProvider = undefined;
        try {
            await expect(job.run()).resolves.toBeUndefined();
        } finally {
            (job as any).searchProvider = real;
        }
    });

    it("Does nothing when blobStore is not yet initialized.", async () => {
        const real = (job as any).blobStore;
        (job as any).blobStore = undefined;
        try {
            await expect(job.run()).resolves.toBeUndefined();
        } finally {
            (job as any).blobStore = real;
        }
    });

    it("Does not reprocess a message that is already searchIndexedAt-stamped.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const blobKey = `body/${uuid.v4()}`;
        await blobStore.put(blobKey, Buffer.from("Subject: Hello\r\n\r\nBody text."));
        await createMessage({ bodyBlobKey: blobKey, searchIndexedAt: new Date("2026-01-01T00:00:00Z") });

        await job.run();

        const searchProvider = objectFactory.getInstance<NoopSearchProvider>("SearchProvider")!;
        expect(searchProvider.indexed.size).toBe(0);
    });

    it("Builds a search document from a message with no attachments, bulk-indexes it, and stamps searchIndexedAt.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const blobKey = `body/${uuid.v4()}`;
        await blobStore.put(blobKey, Buffer.from("Subject: Hello\r\n\r\nBody text."));
        const message = await createMessage({ bodyBlobKey: blobKey });

        await job.run();

        const searchProvider = objectFactory.getInstance<NoopSearchProvider>("SearchProvider")!;
        const doc = searchProvider.indexed.get(`message:${message.uid}`);
        expect(doc).toBeDefined();
        expect(doc).toEqual(
            expect.objectContaining({
                entityType: "message",
                entityUid: message.uid,
                mailboxUid: message.mailboxUid,
                subject: message.subject,
                body: "Body text.",
                attachmentText: [],
                participants: ["sender@example.com", "recipient@example.com"],
            }),
        );
        expect(new Date(doc!.dateForSort as any).getTime()).toBe(message.sentDate.getTime());

        const updated = await messageRepo.findOne({ where: { uid: message.uid } });
        expect(updated!.searchIndexedAt).toBeInstanceOf(Date);
    });

    it("Splits recipients into to/cc, and populates folderUid/flags/hasAttachments/metadataOnly for an unencrypted message.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const blobKey = `body/${uuid.v4()}`;
        await blobStore.put(blobKey, Buffer.from("Subject: Hello\r\n\r\nBody text."));
        const message = await createMessage({
            bodyBlobKey: blobKey,
            recipients: [
                { address: "to1@example.com", type: RecipientType.TO },
                { address: "to2@example.com", type: RecipientType.TO },
                { address: "cc1@example.com", type: RecipientType.CC },
            ],
            hasAttachments: false,
            flags: { read: true, flagged: true, answered: true, forwarded: true },
        });

        await job.run();

        const searchProvider = objectFactory.getInstance<NoopSearchProvider>("SearchProvider")!;
        const doc = searchProvider.indexed.get(`message:${message.uid}`);
        expect(doc).toEqual(
            expect.objectContaining({
                from: "sender@example.com",
                to: ["to1@example.com", "to2@example.com"],
                cc: ["cc1@example.com"],
                folderUid: message.folderUid,
                flags: ["read", "flagged", "answered", "forwarded"],
                hasAttachments: false,
                metadataOnly: false,
            }),
        );
    });

    it("Falls back to the HTML body when the parsed message has no plain-text body.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const blobKey = `body/${uuid.v4()}`;
        await blobStore.put(blobKey, Buffer.from("Content-Type: text/html\r\n\r\n<p>Hi there</p>"));
        const message = await createMessage({ bodyBlobKey: blobKey });

        await job.run();

        const searchProvider = objectFactory.getInstance<NoopSearchProvider>("SearchProvider")!;
        const doc = searchProvider.indexed.get(`message:${message.uid}`);
        expect(doc!.body).toContain("Hi there");
    });

    it("Falls back to an empty body when the parsed message has neither plain-text nor HTML content.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const blobKey = `body/${uuid.v4()}`;
        // A message with only headers and no body at all: mailparser reports `text: undefined` and `html: false`
        // in this case.
        await blobStore.put(blobKey, Buffer.from("Subject: Hello\r\nContent-Type: text/plain\r\n\r\n"));
        const message = await createMessage({ bodyBlobKey: blobKey });

        await job.run();

        const searchProvider = objectFactory.getInstance<NoopSearchProvider>("SearchProvider")!;
        const doc = searchProvider.indexed.get(`message:${message.uid}`);
        expect(doc!.body).toBe("");
    });

    it("Indexes an empty body and no attachment text for an S/MIME-encrypted message, even when it's flagged as having attachments (the encrypted blob itself, not a real one).", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const blobKey = `body/${uuid.v4()}`;
        await blobStore.put(
            blobKey,
            Buffer.from(
                'Subject: Encrypted\r\nContent-Type: application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"\r\n' +
                    "Content-Transfer-Encoding: base64\r\n\r\n" +
                    Buffer.from("fake CMS EnvelopedData DER bytes").toString("base64"),
            ),
        );
        const message = await createMessage({ bodyBlobKey: blobKey, hasAttachments: true });
        const extractedBlobKey = `attachment-text/${uuid.v4()}`;
        await blobStore.put(extractedBlobKey, Buffer.from("should never surface for an encrypted message"));
        await createAttachment({ messageUid: message.uid, extractedTextBlobKey: extractedBlobKey });

        await job.run();

        const searchProvider = objectFactory.getInstance<NoopSearchProvider>("SearchProvider")!;
        const doc = searchProvider.indexed.get(`message:${message.uid}`);
        expect(doc!.body).toBe("");
        expect(doc!.attachmentText).toEqual([]);
        expect(doc!.subject).toBe(message.subject);
        expect(doc!.metadataOnly).toBe(true);
    });

    it("Includes extracted attachment text for a message that has attachments, skipping ones with no extracted text yet.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const bodyBlobKey = `body/${uuid.v4()}`;
        await blobStore.put(bodyBlobKey, Buffer.from("Subject: Hello\r\n\r\nBody text."));
        const message = await createMessage({ bodyBlobKey, hasAttachments: true });

        const extractedBlobKey = `attachment-text/${uuid.v4()}`;
        await blobStore.put(extractedBlobKey, Buffer.from("extracted attachment text"));
        await createAttachment({ messageUid: message.uid, extractedTextBlobKey: extractedBlobKey });
        await createAttachment({ messageUid: message.uid, extractedTextBlobKey: undefined });

        await job.run();

        const searchProvider = objectFactory.getInstance<NoopSearchProvider>("SearchProvider")!;
        const doc = searchProvider.indexed.get(`message:${message.uid}`);
        expect(doc!.attachmentText).toEqual(["extracted attachment text"]);
    });

    it("Does not stamp searchIndexedAt on a message that failed to build a search document, so it's retried next run, while a good message alongside it is still indexed.", async () => {
        // No blob was ever put at this key, so `blobStore.get()` rejects with a real "no blob" error.
        const badMessage = await createMessage({ bodyBlobKey: `body/${uuid.v4()}` });
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const goodBlobKey = `body/${uuid.v4()}`;
        await blobStore.put(goodBlobKey, Buffer.from("Subject: Hello\r\n\r\nGood body."));
        const goodMessage = await createMessage({ bodyBlobKey: goodBlobKey });

        await expect(job.run()).resolves.toBeUndefined();

        const searchProvider = objectFactory.getInstance<NoopSearchProvider>("SearchProvider")!;
        expect(searchProvider.indexed.has(`message:${badMessage.uid}`)).toBe(false);
        expect(searchProvider.indexed.has(`message:${goodMessage.uid}`)).toBe(true);

        const updatedBad = await messageRepo.findOne({ where: { uid: badMessage.uid } });
        expect(updatedBad!.searchIndexedAt).toBeFalsy();
        const updatedGood = await messageRepo.findOne({ where: { uid: goodMessage.uid } });
        expect(updatedGood!.searchIndexedAt).toBeInstanceOf(Date);
    });

    describe("retry bookkeeping (stuck-message isolation)", () => {
        const realBatchSize = () => (job as any).batchSize;
        let savedBatchSize: number;
        let savedMaxAttempts: number;

        beforeEach(() => {
            savedBatchSize = realBatchSize();
            savedMaxAttempts = (job as any).maxAttempts;
        });

        afterEach(() => {
            (job as any).batchSize = savedBatchSize;
            (job as any).maxAttempts = savedMaxAttempts;
            vi.restoreAllMocks();
        });

        const findMessage = async (uid: string) => await messageRepo.findOne({ where: { uid } });
        const setMessage = async (uid: string, fields: any) => await messageRepo.update({ uid }, fields);

        it("Records searchIndexAttempts/searchIndexNextAttemptAt/searchIndexError on failure, honors the backoff, and clears them once a retry succeeds.", async () => {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const blobKey = `body/${uuid.v4()}`;
            const message = await createMessage({ bodyBlobKey: blobKey });

            const before = Date.now();
            await job.run();

            let updated = await findMessage(message.uid);
            expect(updated!.searchIndexedAt).toBeFalsy();
            expect(updated!.searchIndexAttempts).toBe(1);
            expect(new Date(updated!.searchIndexNextAttemptAt!).getTime()).toBeGreaterThan(before);
            expect(updated!.searchIndexError).toContain("no blob");

            // The underlying problem is fixed, but the backoff hasn't elapsed - not retried yet.
            await blobStore.put(blobKey, Buffer.from("Subject: Hello\r\n\r\nBody text."));
            await job.run();
            updated = await findMessage(message.uid);
            expect(updated!.searchIndexedAt).toBeFalsy();
            expect(updated!.searchIndexAttempts).toBe(1);

            // Backoff elapsed - retried, indexed, and the failure bookkeeping cleared.
            await setMessage(message.uid, { searchIndexNextAttemptAt: new Date(Date.now() - 1000) });
            await job.run();
            updated = await findMessage(message.uid);
            expect(updated!.searchIndexedAt).toBeInstanceOf(Date);
            expect(updated!.searchIndexAttempts ?? null).toBeNull();
            expect(updated!.searchIndexNextAttemptAt ?? null).toBeNull();
            expect(updated!.searchIndexError ?? null).toBeNull();
        });

        it("Never lets a permanently failing message block newer ones (batch size 1), and stops selecting it at max_attempts.", async () => {
            (job as any).batchSize = 1;
            (job as any).maxAttempts = 2;
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            // Created (inserted) first but dated newer, so the job's dateCreated ordering - not insertion order -
            // is what puts the bad message at the head of the queue.
            const goodBlobKey = `body/${uuid.v4()}`;
            await blobStore.put(goodBlobKey, Buffer.from("Subject: Hello\r\n\r\nGood body."));
            const goodMessage = await createMessage({ bodyBlobKey: goodBlobKey });
            const badMessage = await createMessage({
                bodyBlobKey: `body/${uuid.v4()}`,
                dateCreated: new Date(Date.now() - 60_000),
            });
            const searchProvider = objectFactory.getInstance<NoopSearchProvider>("SearchProvider")!;

            // Oldest first: the bad message is selected and fails.
            await job.run();
            expect((await findMessage(badMessage.uid))!.searchIndexAttempts).toBe(1);
            expect(searchProvider.indexed.has(`message:${goodMessage.uid}`)).toBe(false);

            // Bad message is backing off - the good one gets its turn.
            await job.run();
            expect(searchProvider.indexed.has(`message:${goodMessage.uid}`)).toBe(true);

            // Second (final) attempt exhausts it: no next attempt is scheduled.
            await setMessage(badMessage.uid, { searchIndexNextAttemptAt: new Date(Date.now() - 1000) });
            await job.run();
            let bad = await findMessage(badMessage.uid);
            expect(bad!.searchIndexAttempts).toBe(2);
            expect(bad!.searchIndexNextAttemptAt ?? null).toBeNull();
            expect(bad!.searchIndexError).toContain("no blob");

            // Even with an elapsed next-attempt time, a message at max_attempts is no longer selected.
            await setMessage(badMessage.uid, { searchIndexNextAttemptAt: new Date(Date.now() - 1000) });
            await job.run();
            bad = await findMessage(badMessage.uid);
            expect(bad!.searchIndexAttempts).toBe(2);
            expect(bad!.searchIndexedAt).toBeFalsy();
        });

        it("Does not stamp searchIndexedAt on a document the provider did not report as indexed, recording a failure instead.", async () => {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const keyA = `body/${uuid.v4()}`;
            const keyB = `body/${uuid.v4()}`;
            await blobStore.put(keyA, Buffer.from("Subject: A\r\n\r\nA body."));
            await blobStore.put(keyB, Buffer.from("Subject: B\r\n\r\nB body."));
            const messageA = await createMessage({ bodyBlobKey: keyA });
            const messageB = await createMessage({ bodyBlobKey: keyB });
            const searchProvider = objectFactory.getInstance<NoopSearchProvider>("SearchProvider")!;
            vi.spyOn(searchProvider, "bulkIndex").mockResolvedValueOnce([messageA.uid]);

            await job.run();

            const updatedA = await findMessage(messageA.uid);
            expect(updatedA!.searchIndexedAt).toBeInstanceOf(Date);
            const updatedB = await findMessage(messageB.uid);
            expect(updatedB!.searchIndexedAt).toBeFalsy();
            expect(updatedB!.searchIndexAttempts).toBe(1);
            expect(updatedB!.searchIndexError).toContain("did not index");
        });

        it("Records a failure on every built message when bulkIndex() rejects for the whole batch.", async () => {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const blobKey = `body/${uuid.v4()}`;
            await blobStore.put(blobKey, Buffer.from("Subject: A\r\n\r\nA body."));
            const message = await createMessage({ bodyBlobKey: blobKey });
            const searchProvider = objectFactory.getInstance<NoopSearchProvider>("SearchProvider")!;
            vi.spyOn(searchProvider, "bulkIndex").mockRejectedValueOnce(new Error("provider unreachable"));

            await expect(job.run()).resolves.toBeUndefined();

            const updated = await findMessage(message.uid);
            expect(updated!.searchIndexedAt).toBeFalsy();
            expect(updated!.searchIndexAttempts).toBe(1);
            expect(updated!.searchIndexError).toContain("provider unreachable");
        });
    });
});
