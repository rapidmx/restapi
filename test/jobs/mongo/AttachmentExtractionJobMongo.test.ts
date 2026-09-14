///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for AttachmentExtractionJobMongo: a real in-memory MongoDB connection and a
// real `ObjectFactory` construct the job exactly as production wiring would - its own `@Init` builds real
// `RepoUtils` against the live connection, `@Inject("BlobStore")` resolves to the registered `InMemoryBlobStore`
// test double, and `extractorRegistry` is a genuine `ExtractorRegistry` (real PDF/DOCX/plain-text/HTML
// extractors) since it's a plain instantiated field on the job, never DI-injected. No repo is hand-mocked. See
// ScanQueueJobMongo.test.ts's file header for the full rationale behind bypassing `Server`/`ClassLoader`.
import { MongoMemoryServer } from "mongodb-memory-server";
import { ACLUtils, ConnectionManager, MongoConnection, MongoRepository, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../../config.js";
import { registerTestDoubles } from "../../testDoubles.js";
import { AttachmentExtractionJobMongo } from "../../../src/jobs/mongo/AttachmentExtractionJobMongo.js";
import { AttachmentMongo } from "../../../src/models/mongo/AttachmentMongo.js";
import { MessageMongo } from "../../../src/models/mongo/MessageMongo.js";
import { RecipientType } from "../../../src/models/types.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("AttachmentExtractionJobMongo Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: AttachmentExtractionJobMongo;
    let attachmentRepo: MongoRepository<AttachmentMongo>;
    let messageRepo: MongoRepository<MessageMongo>;

    const mailboxUid = uuid.v4();

    const createAttachment = async (data?: Partial<AttachmentMongo>): Promise<AttachmentMongo> => {
        const obj = new AttachmentMongo({
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

    const createMessage = async (data?: Partial<MessageMongo>): Promise<MessageMongo> => {
        const obj = new MessageMongo({
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

    beforeAll(async () => {
        await mongod.start();
        objectFactory = new ObjectFactory(config, logger);
        registerTestDoubles(objectFactory);
        // Normally registered by `Server`'s own bootstrap - registered explicitly here since this file
        // deliberately bypasses `Server` (see ScanQueueJobMongo.test.ts's header comment).
        objectFactory.register(ACLUtils);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("AttachmentMongo", AttachmentMongo);
        models.set("MessageMongo", MessageMongo);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        attachmentRepo = conn.getMongoRepository("AttachmentMongo");
        messageRepo = conn.getMongoRepository("MessageMongo");

        // Constructed once via real ObjectFactory DI: `@Init` builds its two real `RepoUtils` against the live
        // connection above, and `@Inject("BlobStore")` resolves to the registered `InMemoryBlobStore` double.
        job = await objectFactory.newInstance(AttachmentExtractionJobMongo, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
        await mongod.stop();
    });

    beforeEach(async () => {
        for (const repo of [attachmentRepo, messageRepo]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
    });

    it("Exposes the configured cron schedule.", () => {
        expect(job.schedule).toBe(config.get("mail:jobs:attachment_extraction:schedule"));
    });

    it("start() and stop() are no-ops beyond init().", async () => {
        await expect(job.start()).resolves.toBeUndefined();
        expect(job.stop()).toBeUndefined();
    });

    it("Does nothing when there are no pending attachments.", async () => {
        await expect(job.run()).resolves.toBeUndefined();
    });

    // `attachmentRepo`/`blobStore` are always set by the time `run()` can be called through real DI - `@Init`
    // (which builds `attachmentRepo`) and the `@Inject("BlobStore")` resolution both complete before
    // `objectFactory.newInstance()` ever resolves. These two guards defend against a call to `run()` before
    // construction finishes, which never happens in production (`BackgroundServiceManager` always awaits
    // construction first) - the only way to exercise them is to force the field back to `undefined` on an
    // otherwise fully real job instance, same as the guard clause's own defensive intent.
    it("Does nothing when attachmentRepo is not yet initialized.", async () => {
        const real = (job as any).attachmentRepo;
        (job as any).attachmentRepo = undefined;
        try {
            await expect(job.run()).resolves.toBeUndefined();
        } finally {
            (job as any).attachmentRepo = real;
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

    it("Does not reprocess an attachment that already has extractedTextBlobKey set.", async () => {
        const alreadyExtracted = await createAttachment({ extractedTextBlobKey: "attachment-text/already-done" });

        await job.run();

        const updated = await attachmentRepo.findOne({ uid: alreadyExtracted.uid } as any);
        expect(updated!.extractedTextBlobKey).toBe("attachment-text/already-done");
    });

    it("Stores an empty-content blob and stamps extractedTextBlobKey when the MIME type has no extractor, without touching an already-indexed parent message.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const blobKey = `attachments/${uuid.v4()}`;
        await blobStore.put(blobKey, Buffer.from("binary image bytes"));
        const message = await createMessage({ searchIndexedAt: new Date("2026-01-01T00:00:00Z") });
        const attachment = await createAttachment({ messageUid: message.uid, mimeType: "image/png", blobKey });

        await job.run();

        const updated = await attachmentRepo.findOne({ uid: attachment.uid } as any);
        expect(updated!.extractedTextBlobKey).toContain("attachment-text/");
        const stored: Buffer = await blobStore.get(updated!.extractedTextBlobKey!);
        expect(stored.toString()).toBe("");

        // `text` was falsy (no extractor for image/png), so the parent message lookup/clear never runs - the
        // already-indexed message must be left completely untouched.
        const untouchedMessage = await messageRepo.findOne({ uid: message.uid } as any);
        expect(untouchedMessage!.searchIndexedAt).toEqual(message.searchIndexedAt);
        expect(untouchedMessage!.version).toBe(message.version);
    });

    it("Extracts non-empty text from a supported MIME type, stores it, and clears searchIndexedAt on an already-indexed parent message.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const blobKey = `attachments/${uuid.v4()}`;
        await blobStore.put(blobKey, Buffer.from("hello extracted world"));
        const message = await createMessage({ searchIndexedAt: new Date("2026-01-01T00:00:00Z") });
        const attachment = await createAttachment({ messageUid: message.uid, mimeType: "text/plain", blobKey });

        await job.run();

        const updatedAttachment = await attachmentRepo.findOne({ uid: attachment.uid } as any);
        expect(updatedAttachment!.extractedTextBlobKey).toContain("attachment-text/");
        const stored: Buffer = await blobStore.get(updatedAttachment!.extractedTextBlobKey!);
        expect(stored.toString()).toBe("hello extracted world");

        const updatedMessage = await messageRepo.findOne({ uid: message.uid } as any);
        // Mongo's driver serializes an explicit `undefined` `$set` value as `null` rather than omitting the
        // field entirely.
        expect(updatedMessage!.searchIndexedAt).toBeNull();
    });

    it("Extracts non-empty text but does not touch the parent message when it was never search-indexed.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const blobKey = `attachments/${uuid.v4()}`;
        await blobStore.put(blobKey, Buffer.from("some text content"));
        const message = await createMessage({ searchIndexedAt: undefined });
        const attachment = await createAttachment({ messageUid: message.uid, mimeType: "text/plain", blobKey });

        await job.run();

        const updatedMessage = await messageRepo.findOne({ uid: message.uid } as any);
        expect(updatedMessage!.searchIndexedAt).toBeUndefined();
        // Not updated at all - version is unchanged.
        expect(updatedMessage!.version).toBe(message.version);
    });

    it("Stores an empty-content blob without ever calling the extractor for an attachment on an encrypted message.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const blobKey = `attachments/${uuid.v4()}`;
        await blobStore.put(blobKey, Buffer.from("real extractable text that must never surface"));
        const message = await createMessage({ encrypted: true, searchIndexedAt: new Date("2026-01-01T00:00:00Z") });
        const attachment = await createAttachment({ messageUid: message.uid, mimeType: "text/plain", blobKey });

        await job.run();

        const updated = await attachmentRepo.findOne({ uid: attachment.uid } as any);
        expect(updated!.extractedTextBlobKey).toContain("attachment-text/");
        const stored: Buffer = await blobStore.get(updated!.extractedTextBlobKey!);
        expect(stored.toString()).toBe("");

        // Skipped (falsy text), so the already-indexed encrypted message is left completely untouched too.
        const untouchedMessage = await messageRepo.findOne({ uid: message.uid } as any);
        expect(untouchedMessage!.searchIndexedAt).toEqual(message.searchIndexedAt);
        expect(untouchedMessage!.version).toBe(message.version);
    });

    it("Extracts non-empty text without crashing when the parent message no longer exists.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const blobKey = `attachments/${uuid.v4()}`;
        await blobStore.put(blobKey, Buffer.from("orphaned attachment text"));
        const attachment = await createAttachment({ messageUid: uuid.v4(), mimeType: "text/plain", blobKey });

        await expect(job.run()).resolves.toBeUndefined();

        const updated = await attachmentRepo.findOne({ uid: attachment.uid } as any);
        expect(updated!.extractedTextBlobKey).toContain("attachment-text/");
    });

    it("Logs a warning and continues processing subsequent attachments when one throws (missing blob).", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        // A real, unencrypted parent message for each - `processAttachment()` now fails closed (skips
        // extraction, no `blobStore.get()` call at all) whenever the parent message can't be resolved, so
        // exercising the "blobStore.get() itself throws" path needs a genuine, findable, non-encrypted
        // message behind each attachment.
        const badMessage = await createMessage();
        const goodMessage = await createMessage();
        // No blob was ever put at this key, so `blobStore.get()` rejects with a real "no blob" error.
        const badAttachment = await createAttachment({ messageUid: badMessage.uid, blobKey: `attachments/${uuid.v4()}` });
        const goodBlobKey = `attachments/${uuid.v4()}`;
        await blobStore.put(goodBlobKey, Buffer.from("good content"));
        const goodAttachment = await createAttachment({ messageUid: goodMessage.uid, blobKey: goodBlobKey });

        await expect(job.run()).resolves.toBeUndefined();

        const updatedBad = await attachmentRepo.findOne({ uid: badAttachment.uid } as any);
        expect(updatedBad!.extractedTextBlobKey).toBeUndefined();
        const updatedGood = await attachmentRepo.findOne({ uid: goodAttachment.uid } as any);
        expect(updatedGood!.extractedTextBlobKey).toContain("attachment-text/");
    });

    it("Logs a warning (no throw) when recording an extraction failure itself fails.", async () => {
        const message = await createMessage();
        const attachment = await createAttachment({ messageUid: message.uid, blobKey: `attachments/${uuid.v4()}` });
        const updateSpy = vi.spyOn((job as any).attachmentRepo, "update").mockRejectedValue(new Error("simulated bookkeeping failure"));
        const warnSpy = vi.spyOn((job as any).logger, "warn");

        try {
            await expect(job.run()).resolves.toBeUndefined();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("simulated bookkeeping failure"));
        } finally {
            updateSpy.mockRestore();
            warnSpy.mockRestore();
        }

        const updated = await attachmentRepo.findOne({ uid: attachment.uid } as any);
        expect(updated!.extractionAttempts ?? null).toBeNull();
    });

    describe("retry bookkeeping (stuck-attachment isolation)", () => {
        let savedBatchSize: number;
        let savedMaxAttempts: number;

        beforeEach(() => {
            savedBatchSize = (job as any).batchSize;
            savedMaxAttempts = (job as any).maxAttempts;
        });

        afterEach(() => {
            (job as any).batchSize = savedBatchSize;
            (job as any).maxAttempts = savedMaxAttempts;
        });

        const findAttachment = async (uid: string) => await attachmentRepo.findOne({ uid } as any);
        const setAttachment = async (uid: string, fields: any) => await attachmentRepo.updateOne({ uid } as any, { $set: fields });
        const findMessage = async (uid: string) => await messageRepo.findOne({ uid } as any);

        it("Records extractionAttempts/extractionNextAttemptAt/extractionError on failure, honors the backoff, and clears them once a retry succeeds.", async () => {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const message = await createMessage();
            const blobKey = `attachments/${uuid.v4()}`;
            const attachment = await createAttachment({ messageUid: message.uid, blobKey });

            const before = Date.now();
            await job.run();

            let updated = await findAttachment(attachment.uid);
            expect(updated!.extractedTextBlobKey ?? null).toBeNull();
            expect(updated!.extractionAttempts).toBe(1);
            expect(new Date(updated!.extractionNextAttemptAt!).getTime()).toBeGreaterThan(before);
            expect(updated!.extractionError).toContain("no blob");

            await blobStore.put(blobKey, Buffer.from("now it exists"));
            await job.run();
            updated = await findAttachment(attachment.uid);
            expect(updated!.extractedTextBlobKey ?? null).toBeNull();

            await setAttachment(attachment.uid, { extractionNextAttemptAt: new Date(Date.now() - 1000) });
            await job.run();
            updated = await findAttachment(attachment.uid);
            expect(updated!.extractedTextBlobKey).toContain("attachment-text/");
            expect(updated!.extractionAttempts ?? null).toBeNull();
            expect(updated!.extractionNextAttemptAt ?? null).toBeNull();
            expect(updated!.extractionError ?? null).toBeNull();
        });

        it("Never lets a permanently failing attachment block newer ones (batch size 1), and stops selecting it at max_attempts.", async () => {
            (job as any).batchSize = 1;
            (job as any).maxAttempts = 2;
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const badMessage = await createMessage();
            const goodMessage = await createMessage();
            // Inserted first but dated newer, so dateCreated ordering - not insertion order - decides the head.
            const goodBlobKey = `attachments/${uuid.v4()}`;
            await blobStore.put(goodBlobKey, Buffer.from("good content"));
            const goodAttachment = await createAttachment({ messageUid: goodMessage.uid, blobKey: goodBlobKey });
            const badAttachment = await createAttachment({
                messageUid: badMessage.uid,
                blobKey: `attachments/${uuid.v4()}`,
                dateCreated: new Date(Date.now() - 60_000),
            });

            await job.run();
            expect((await findAttachment(badAttachment.uid))!.extractionAttempts).toBe(1);
            expect((await findAttachment(goodAttachment.uid))!.extractedTextBlobKey ?? null).toBeNull();

            await job.run();
            expect((await findAttachment(goodAttachment.uid))!.extractedTextBlobKey).toContain("attachment-text/");

            await setAttachment(badAttachment.uid, { extractionNextAttemptAt: new Date(Date.now() - 1000) });
            await job.run();
            let bad = await findAttachment(badAttachment.uid);
            expect(bad!.extractionAttempts).toBe(2);
            expect(bad!.extractionNextAttemptAt ?? null).toBeNull();

            await setAttachment(badAttachment.uid, { extractionNextAttemptAt: new Date(Date.now() - 1000) });
            await job.run();
            bad = await findAttachment(badAttachment.uid);
            expect(bad!.extractionAttempts).toBe(2);
            expect(bad!.extractedTextBlobKey ?? null).toBeNull();
        });

        it("Resets the parent message's SearchIndexJob retry bookkeeping along with searchIndexedAt when new text is extracted.", async () => {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const blobKey = `attachments/${uuid.v4()}`;
            await blobStore.put(blobKey, Buffer.from("fresh text"));
            const message = await createMessage({
                searchIndexedAt: new Date("2026-01-01T00:00:00Z"),
                searchIndexAttempts: 3,
                searchIndexNextAttemptAt: new Date("2026-01-02T00:00:00Z"),
                searchIndexError: "old failure",
            });
            await createAttachment({ messageUid: message.uid, mimeType: "text/plain", blobKey });

            await job.run();

            const updated = await findMessage(message.uid);
            expect(updated!.searchIndexedAt ?? null).toBeNull();
            expect(updated!.searchIndexAttempts ?? null).toBeNull();
            expect(updated!.searchIndexNextAttemptAt ?? null).toBeNull();
            expect(updated!.searchIndexError ?? null).toBeNull();
        });
    });
});
