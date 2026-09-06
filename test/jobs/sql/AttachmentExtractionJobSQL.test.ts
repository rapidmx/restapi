///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for AttachmentExtractionJobSQL: a real SQLite (better-sqlite3) connection
// and a real `ObjectFactory` construct the job exactly as production wiring would - see
// AttachmentExtractionJobMongo.test.ts's file header for the full rationale (also applies here verbatim). Uses
// `config.sql.ts`, whose `acl` datastore is ALSO SQL-backed (`AccessControlListSQL`, auto-selected by `ACLUtils`
// from the connection's runtime type) - so this file has no MongoDB dependency at all.
import { ACLUtils, AccessControlListSQL, ConnectionManager, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import config from "../../config.sql.js";
import { registerTestDoubles } from "../../testDoubles.js";
import { AttachmentExtractionJobSQL } from "../../../src/jobs/sql/AttachmentExtractionJobSQL.js";
import { AttachmentSQL } from "../../../src/models/sql/AttachmentSQL.js";
import { MessageSQL } from "../../../src/models/sql/MessageSQL.js";
import { RecipientType } from "../../../src/models/types.js";

describe("AttachmentExtractionJobSQL Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: AttachmentExtractionJobSQL;
    let attachmentRepo: Repository<AttachmentSQL>;
    let messageRepo: Repository<MessageSQL>;

    const mailboxUid = uuid.v4();

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

    beforeAll(async () => {
        objectFactory = new ObjectFactory(config, logger);
        registerTestDoubles(objectFactory);
        // Normally registered by `Server`'s own bootstrap - registered explicitly here since this file
        // deliberately bypasses `Server` (see AttachmentExtractionJobMongo.test.ts's header comment).
        objectFactory.register(ACLUtils);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        // Not auto-discovered here the way `Server`'s `ClassLoader` scan would - a bare TypeORM `DataSource`
        // throws "No metadata found" from `getRepository()` for any entity not explicitly in this map.
        models.set("AccessControlListSQL", AccessControlListSQL);
        models.set("AttachmentSQL", AttachmentSQL);
        models.set("MessageSQL", MessageSQL);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        attachmentRepo = conn.getRepository(AttachmentSQL);
        messageRepo = conn.getRepository(MessageSQL);

        // Constructed once via real ObjectFactory DI: `@Init` builds its two real `RepoUtils` against the live
        // connection above, and `@Inject("BlobStore")` resolves to the registered `InMemoryBlobStore` double.
        job = await objectFactory.newInstance(AttachmentExtractionJobSQL, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        for (const repo of [attachmentRepo, messageRepo]) {
            await repo.clear();
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

        const updated = await attachmentRepo.findOne({ where: { uid: alreadyExtracted.uid } });
        expect(updated!.extractedTextBlobKey).toBe("attachment-text/already-done");
    });

    it("Stores an empty-content blob and stamps extractedTextBlobKey when the MIME type has no extractor, without touching an already-indexed parent message.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const blobKey = `attachments/${uuid.v4()}`;
        await blobStore.put(blobKey, Buffer.from("binary image bytes"));
        const message = await createMessage({ searchIndexedAt: new Date("2026-01-01T00:00:00Z") });
        const attachment = await createAttachment({ messageUid: message.uid, mimeType: "image/png", blobKey });

        await job.run();

        const updated = await attachmentRepo.findOne({ where: { uid: attachment.uid } });
        expect(updated!.extractedTextBlobKey).toContain("attachment-text/");
        const stored: Buffer = await blobStore.get(updated!.extractedTextBlobKey!);
        expect(stored.toString()).toBe("");

        // `text` was falsy (no extractor for image/png), so the parent message lookup/clear never runs - the
        // already-indexed message must be left completely untouched.
        const untouchedMessage = await messageRepo.findOne({ where: { uid: message.uid } });
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

        const updatedAttachment = await attachmentRepo.findOne({ where: { uid: attachment.uid } });
        expect(updatedAttachment!.extractedTextBlobKey).toContain("attachment-text/");
        const stored: Buffer = await blobStore.get(updatedAttachment!.extractedTextBlobKey!);
        expect(stored.toString()).toBe("hello extracted world");

        const updatedMessage = await messageRepo.findOne({ where: { uid: message.uid } });
        expect(updatedMessage!.searchIndexedAt).toBeNull();
    });

    it("Extracts non-empty text but does not touch the parent message when it was never search-indexed.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const blobKey = `attachments/${uuid.v4()}`;
        await blobStore.put(blobKey, Buffer.from("some text content"));
        const message = await createMessage({ searchIndexedAt: undefined });
        const attachment = await createAttachment({ messageUid: message.uid, mimeType: "text/plain", blobKey });

        await job.run();

        const updatedMessage = await messageRepo.findOne({ where: { uid: message.uid } });
        expect(updatedMessage!.searchIndexedAt).toBeNull();
        // Not updated at all - version is unchanged.
        expect(updatedMessage!.version).toBe(message.version);
    });

    it("Extracts non-empty text without crashing when the parent message no longer exists.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const blobKey = `attachments/${uuid.v4()}`;
        await blobStore.put(blobKey, Buffer.from("orphaned attachment text"));
        const attachment = await createAttachment({ messageUid: uuid.v4(), mimeType: "text/plain", blobKey });

        await expect(job.run()).resolves.toBeUndefined();

        const updated = await attachmentRepo.findOne({ where: { uid: attachment.uid } });
        expect(updated!.extractedTextBlobKey).toContain("attachment-text/");
    });

    it("Logs a warning and continues processing subsequent attachments when one throws (missing blob).", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        // No blob was ever put at this key, so `blobStore.get()` rejects with a real "no blob" error.
        const badAttachment = await createAttachment({ blobKey: `attachments/${uuid.v4()}` });
        const goodBlobKey = `attachments/${uuid.v4()}`;
        await blobStore.put(goodBlobKey, Buffer.from("good content"));
        const goodAttachment = await createAttachment({ blobKey: goodBlobKey });

        await expect(job.run()).resolves.toBeUndefined();

        const updatedBad = await attachmentRepo.findOne({ where: { uid: badAttachment.uid } });
        expect(updatedBad!.extractedTextBlobKey).toBeNull();
        const updatedGood = await attachmentRepo.findOne({ where: { uid: goodAttachment.uid } });
        expect(updatedGood!.extractedTextBlobKey).toContain("attachment-text/");
    });
});
