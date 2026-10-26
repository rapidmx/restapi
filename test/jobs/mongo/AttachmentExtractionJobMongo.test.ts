///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for AttachmentExtractionJobMongo: a real in-memory MongoDB connection and a
// real `ObjectFactory` construct the job exactly as production wiring would - its own `@Init` builds real
// `RepoUtils` against the live connection, `@Inject("BlobStore")` resolves to the registered `InMemoryBlobStore`
// test double, and `extractorRegistry` is a genuine `ExtractorRegistry` (real PDF/DOCX/plain-text/HTML
// extractors) since the job injects it through the ObjectFactory. No repo is hand-mocked. See
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

    it("Matches the MIME type by its bare, lower-cased type/subtype, so a Content-Type with parameters or odd casing is still extracted.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const blobKey = `attachments/${uuid.v4()}`;
        await blobStore.put(blobKey, Buffer.from("parameterised text"));
        const message = await createMessage();
        const attachment = await createAttachment({ messageUid: message.uid, mimeType: "Text/Plain; charset=utf-8; name=a.txt", blobKey });

        await job.run();

        const updated = await attachmentRepo.findOne({ uid: attachment.uid } as any);
        expect((await blobStore.get(updated!.extractedTextBlobKey!)).toString()).toBe("parameterised text");
    });

    it("Does not download an attachment whose declared size is above the extraction ceiling, stamping it with an empty text blob.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const message = await createMessage();
        const attachment = await createAttachment({ messageUid: message.uid, mimeType: "text/plain", sizeBytes: (job as any).maxExtractBytes + 1 });
        const getSpy = vi.spyOn(blobStore, "get");

        await job.run();

        expect(getSpy).not.toHaveBeenCalledWith(attachment.blobKey);
        const updated = await attachmentRepo.findOne({ uid: attachment.uid } as any);
        expect((await blobStore.get(updated!.extractedTextBlobKey!)).toString()).toBe("");

        // An image is never downloaded either.
        const image = await createAttachment({ messageUid: message.uid, mimeType: "Image/PNG", sizeBytes: 10 });
        await job.run();
        expect(getSpy).not.toHaveBeenCalledWith(image.blobKey);
        expect((await attachmentRepo.findOne({ uid: image.uid } as any))!.extractedTextBlobKey).toContain("attachment-text/");

        // A type the registry has no extractor for (not just media) is never downloaded either.
        const archive = await createAttachment({ messageUid: message.uid, mimeType: "application/zip", sizeBytes: 10 });
        await job.run();
        expect(getSpy).not.toHaveBeenCalledWith(archive.blobKey);
        getSpy.mockRestore();
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

    it("Never extracts the text of an attachment of a message stored zero-access sealed (a sealed draft's upload), nor stamps it, and extracts it once the message is readable.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const blobKey = `attachments/${uuid.v4()}`;
        await blobStore.put(blobKey, Buffer.from("CANARY draft attachment text"));
        const message = await createMessage({
            subject: "[...]",
            zeroAccess: { keyFingerprint: "fp", sealedSummary: "s" },
            searchIndexedAt: new Date("2026-01-01T00:00:00Z"),
        });
        const attachment = await createAttachment({ messageUid: message.uid, mimeType: "text/plain", blobKey });
        const putSpy = vi.spyOn(blobStore, "put");

        await job.run();

        // Put off, not stamped: no text blob, and not selected again until the deferral passes.
        const deferred: any = await attachmentRepo.findOne({ uid: attachment.uid } as any);
        expect(deferred.extractedTextBlobKey ?? null).toBeNull();
        expect(deferred.extractionAttempts).toBe(0);
        expect(deferred.extractionError ?? null).toBeNull();
        expect(new Date(deferred.extractionNextAttemptAt).getTime()).toBeGreaterThan(Date.now() + 500_000);
        expect(putSpy.mock.calls.filter((call: any[]) => String(call[0]).startsWith("attachment-text/"))).toHaveLength(0);
        putSpy.mockRestore();
        const untouchedMessage: any = await messageRepo.findOne({ uid: message.uid } as any);
        expect(untouchedMessage!.searchIndexedAt).toEqual(message.searchIndexedAt);
        expect(untouchedMessage!.version).toBe(message.version);
        await job.run();
        expect(((await attachmentRepo.findOne({ uid: attachment.uid } as any)) as any).extractedTextBlobKey ?? null).toBeNull();

        // Zero-access turned off: the draft is saved readable, with the same rows. Once the deferral has passed it is extracted and the
        // message re-indexed with its text.
        await messageRepo.updateOne({ uid: message.uid } as any, { $set: { zeroAccess: null, subject: "Plain draft" } } as any);
        await attachmentRepo.updateOne({ uid: attachment.uid } as any, { $set: { extractionNextAttemptAt: new Date(Date.now() - 1000) } } as any);

        await job.run();

        const extracted: any = await attachmentRepo.findOne({ uid: attachment.uid } as any);
        expect((await blobStore.get(extracted.extractedTextBlobKey)).toString()).toBe("CANARY draft attachment text");
        expect(extracted.extractionAttempts ?? null).toBeNull();
        expect(extracted.extractionNextAttemptAt ?? null).toBeNull();
        expect(((await messageRepo.findOne({ uid: message.uid } as any)) as any).searchIndexedAt ?? null).toBeNull();
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

        it("Serves an attachment never looked at before any put off while sealed, however many of those are due and older.", async () => {
            (job as any).batchSize = 2;
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const sealed = await createMessage({ subject: "[...]", zeroAccess: { keyFingerprint: "fp", sealedSummary: "s" } });
            const deferred: string[] = [];
            for (let i = 0; i < 3; i++) {
                const row = await createAttachment({
                    messageUid: sealed.uid,
                    dateCreated: new Date(Date.now() - (i + 1) * 60_000),
                    extractionAttempts: 0,
                    extractionNextAttemptAt: new Date(Date.now() - 1000),
                });
                deferred.push(row.uid);
            }
            const fresh = await createMessage();
            const freshBlobKey = `attachments/${uuid.v4()}`;
            await blobStore.put(freshBlobKey, Buffer.from("new mail's attachment"));
            const newer = await createAttachment({ messageUid: fresh.uid, blobKey: freshBlobKey });

            await job.run();

            expect((await findAttachment(newer.uid))!.extractedTextBlobKey).toContain("attachment-text/");
            // The one slot left went to the oldest sealed row, put off again; the others wait their turn.
            const after = await Promise.all(deferred.map(async (uid) => await findAttachment(uid)));
            expect(after.map((row: any) => new Date(row.extractionNextAttemptAt).getTime() > Date.now())).toEqual([false, false, true]);
            expect(after.every((row: any) => (row.extractedTextBlobKey ?? null) === null)).toBe(true);
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
        it("Clears searchIndexedAt when SearchIndexJob stamped the message after this job's initial read but before the attachment was stamped (re-reads the message).", async () => {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const blobKey = `attachments/${uuid.v4()}`;
            await blobStore.put(blobKey, Buffer.from("late text"));
            const message = await createMessage({ searchIndexedAt: undefined });
            await createAttachment({ messageUid: message.uid, mimeType: "text/plain", blobKey });
            const attachmentRepoUtils = (job as any).attachmentRepo;
            const realUpdate = attachmentRepoUtils.update.bind(attachmentRepoUtils);
            const spy = vi.spyOn(attachmentRepoUtils, "update").mockImplementationOnce(async (...args: any[]) => {
                const result = await realUpdate(...args);
                await messageRepo.updateOne({ uid: message.uid } as any, { $inc: { version: 1 }, $set: { searchIndexedAt: new Date("2026-01-01T00:00:00Z") } });
                return result;
            });
            try {
                await job.run();
            } finally {
                spy.mockRestore();
            }

            const updated = await findMessage(message.uid);
            expect(updated!.searchIndexedAt ?? null).toBeNull();
        });

        it("Retries the re-index invalidation against a fresh read when it hits a version conflict, rather than dropping it.", async () => {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const blobKey = `attachments/${uuid.v4()}`;
            await blobStore.put(blobKey, Buffer.from("fresh text"));
            const message = await createMessage({ searchIndexedAt: new Date("2026-01-01T00:00:00Z") });
            await createAttachment({ messageUid: message.uid, mimeType: "text/plain", blobKey });
            const messageRepoUtils = (job as any).messageRepo;
            const realUpdate = messageRepoUtils.update.bind(messageRepoUtils);
            const spy = vi.spyOn(messageRepoUtils, "update").mockImplementationOnce(async (...args: any[]) => {
                // A concurrent edit lands first; this stale write must conflict (not clobber it) and be retried.
                await messageRepo.updateOne({ uid: message.uid } as any, { $inc: { version: 1 }, $set: { subject: "Edited concurrently" } });
                return await realUpdate(...args);
            });
            try {
                await job.run();
                expect(spy).toHaveBeenCalledTimes(2);
            } finally {
                spy.mockRestore();
            }

            const updated = await findMessage(message.uid);
            expect(updated!.subject).toBe("Edited concurrently");
            expect(updated!.searchIndexedAt ?? null).toBeNull();
        });

        it("Only one of two overlapping runs holding the same stale attachment row stamps it; the loser deletes its own text blob.", async () => {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const blobKey = `attachments/${uuid.v4()}`;
            await blobStore.put(blobKey, Buffer.from("some text"));
            const message = await createMessage();
            const attachment = await createAttachment({ messageUid: message.uid, mimeType: "text/plain", blobKey });
            const attachmentRepoUtils = (job as any).attachmentRepo;
            const [stale] = await attachmentRepoUtils.find({ uid: attachment.uid, limit: 1 } as any, { ignoreACL: true, limit: 1 });
            const deleteSpy = vi.spyOn(blobStore, "delete");
            try {
                await (job as any).processAttachment(stale);
                await expect((job as any).processAttachment(stale)).rejects.toThrow();
                expect(deleteSpy).toHaveBeenCalledTimes(1);
            } finally {
                deleteSpy.mockRestore();
            }

            const updated = await findAttachment(attachment.uid);
            expect(await blobStore.exists(updated!.extractedTextBlobKey!)).toBe(true);
        });
        it("Logs a warning (no throw) when re-reading the message for re-indexing fails.", async () => {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const blobKey = `attachments/${uuid.v4()}`;
            await blobStore.put(blobKey, Buffer.from("fresh text"));
            const message = await createMessage({ searchIndexedAt: new Date("2026-01-01T00:00:00Z") });
            const attachment = await createAttachment({ messageUid: message.uid, mimeType: "text/plain", blobKey });
            const messageRepoUtils = (job as any).messageRepo;
            const realFindOne = messageRepoUtils.findOne.bind(messageRepoUtils);
            const findSpy = vi
                .spyOn(messageRepoUtils, "findOne")
                // The first read, and the re-read after extraction (still not sealed).
                .mockImplementationOnce(async (...args: any[]) => await realFindOne(...args))
                .mockImplementationOnce(async (...args: any[]) => await realFindOne(...args))
                .mockRejectedValueOnce(new Error("simulated re-read failure"));
            const warnSpy = vi.spyOn((job as any).logger, "warn");
            try {
                await expect(job.run()).resolves.toBeUndefined();
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("simulated re-read failure"));
            } finally {
                findSpy.mockRestore();
                warnSpy.mockRestore();
            }
            expect((await findAttachment(attachment.uid))!.extractedTextBlobKey).toContain("attachment-text/");
        });

        it("Logs a warning (no throw) once every re-index invalidation attempt conflicts.", async () => {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const blobKey = `attachments/${uuid.v4()}`;
            await blobStore.put(blobKey, Buffer.from("fresh text"));
            const message = await createMessage({ searchIndexedAt: new Date("2026-01-01T00:00:00Z") });
            await createAttachment({ messageUid: message.uid, mimeType: "text/plain", blobKey });
            const updateSpy = vi.spyOn((job as any).messageRepo, "update").mockRejectedValue(new Error("simulated persistent conflict"));
            const warnSpy = vi.spyOn((job as any).logger, "warn");
            try {
                await expect(job.run()).resolves.toBeUndefined();
                expect(updateSpy).toHaveBeenCalledTimes(3);
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("simulated persistent conflict"));
            } finally {
                updateSpy.mockRestore();
                warnSpy.mockRestore();
            }
            expect((await findMessage(message.uid))!.searchIndexedAt).toBeInstanceOf(Date);
        });

        it("Still records the failure when deleting the losing run's text blob itself fails.", async () => {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const blobKey = `attachments/${uuid.v4()}`;
            await blobStore.put(blobKey, Buffer.from("some text"));
            const message = await createMessage();
            const attachment = await createAttachment({ messageUid: message.uid, mimeType: "text/plain", blobKey });
            const updateSpy = vi.spyOn((job as any).attachmentRepo, "update").mockRejectedValueOnce(new Error("simulated stamp conflict"));
            const deleteSpy = vi.spyOn(blobStore, "delete").mockRejectedValueOnce(new Error("simulated delete failure"));
            try {
                await expect(job.run()).resolves.toBeUndefined();
                expect(deleteSpy).toHaveBeenCalledTimes(1);
            } finally {
                updateSpy.mockRestore();
                deleteSpy.mockRestore();
            }
            const updated = await findAttachment(attachment.uid);
            expect(updated!.extractionAttempts).toBe(1);
            expect(updated!.extractionError).toContain("simulated stamp conflict");
        });

        it("Takes attachments never attempted ahead of any number of sealed drafts' uploads due again, which only fill what is left (round 6, #602, #608).", async () => {
            (job as any).batchSize = 2;
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const sealed = await createMessage({ subject: "[...]", zeroAccess: { keyFingerprint: "fp", sealedSummary: "s" } });
            const monthAgo = Date.now() - 30 * 86_400_000;
            const deferred: any[] = [];
            for (let i = 0; i < 3; i++) {
                deferred.push(
                    await createAttachment({
                        messageUid: sealed.uid,
                        dateCreated: new Date(monthAgo + i * 1000),
                        extractionAttempts: 0,
                        extractionNextAttemptAt: new Date(Date.now() - 60_000 + i * 1000),
                    }),
                );
            }
            const blobKey = `attachments/${uuid.v4()}`;
            await blobStore.put(blobKey, Buffer.from("fresh mail text"));
            const fresh = await createAttachment({ messageUid: (await createMessage()).uid, blobKey });

            await job.run();

            expect((await findAttachment(fresh.uid))!.extractedTextBlobKey).toContain("attachment-text/");
            // The one slot left went to the upload due soonest: put off again, for a day as it is a month old.
            const [first, ...rest] = await Promise.all(deferred.map(async (row) => await findAttachment(row.uid)));
            const nextAttempt = new Date(first!.extractionNextAttemptAt!).getTime();
            expect(nextAttempt).toBeGreaterThan(Date.now() + 86_000_000);
            expect(nextAttempt).toBeLessThanOrEqual(Date.now() + 86_400_000);
            for (const row of rest) {
                expect(new Date(row!.extractionNextAttemptAt!).getTime()).toBeLessThan(Date.now());
            }
        });

        it("Puts a sealed draft's upload off for about as long as it is old (round 6, #602, #608).", async () => {
            const sealed = await createMessage({ subject: "[...]", zeroAccess: { keyFingerprint: "fp", sealedSummary: "s" } });
            const attachment = await createAttachment({ messageUid: sealed.uid, dateCreated: new Date(Date.now() - 2 * 3_600_000) });

            await job.run();

            const nextAttempt = new Date((await findAttachment(attachment.uid))!.extractionNextAttemptAt!).getTime();
            expect(nextAttempt).toBeGreaterThan(Date.now() + 7_000_000);
            expect(nextAttempt).toBeLessThan(Date.now() + 7_400_000);
        });

        it("Doesn't store the text of an attachment whose message is sealed while it is extracted, and puts it off instead (round 6, #605).", async () => {
            const blobStore = objectFactory.getInstance<any>("BlobStore")!;
            const blobKey = `attachments/${uuid.v4()}`;
            await blobStore.put(blobKey, Buffer.from("CANARY text extracted as the draft is sealed"));
            const message = await createMessage();
            const attachment = await createAttachment({ messageUid: message.uid, mimeType: "text/plain", blobKey });
            const registry: any = (job as any).extractorRegistry;
            const extract = registry.extract.bind(registry);
            const extractSpy = vi.spyOn(registry, "extract").mockImplementation(async (...args: any[]) => {
                const text = await extract(...args);
                // The backfill seals the draft while its attachment is extracted.
                await messageRepo.updateOne({ uid: message.uid } as any, { $set: { zeroAccess: { keyFingerprint: "fp", sealedSummary: "s" } } } as any);
                return text;
            });
            const putSpy = vi.spyOn(blobStore, "put");
            try {
                await job.run();
                expect(putSpy.mock.calls.filter((call: any[]) => String(call[0]).startsWith("attachment-text/"))).toHaveLength(0);
            } finally {
                extractSpy.mockRestore();
                putSpy.mockRestore();
            }

            const row = await findAttachment(attachment.uid);
            expect(row!.extractedTextBlobKey ?? null).toBeNull();
            expect(row!.extractionAttempts).toBe(0);
        });
    });
});
