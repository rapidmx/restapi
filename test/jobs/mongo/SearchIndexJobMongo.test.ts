///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for SearchIndexJobMongo: a real in-memory MongoDB connection and a real
// `ObjectFactory` construct the job exactly as production wiring would - its own `@Init` builds real
// `RepoUtils` against the live connection, `@Inject("BlobStore")` resolves to the registered `InMemoryBlobStore`
// test double, and `@Inject("SearchProvider")` resolves to the registered `NoopSearchProvider` test double (real
// substring-matching index logic, standing in for the actual external-service boundary - a real search engine -
// per `registerTestDoubles()`'s own doc comment). `buildDocument()`'s own MIME parsing goes through the real
// `mailparser` module, never mocked. See ScanQueueJobMongo.test.ts's file header for the full rationale behind
// bypassing `Server`/`ClassLoader`.
import { MongoMemoryServer } from "mongodb-memory-server";
import { ACLUtils, ConnectionManager, MongoConnection, MongoRepository, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../../config.js";
import { registerTestDoubles, NoopSearchProvider } from "../../testDoubles.js";
import { SearchIndexJobMongo } from "../../../src/jobs/mongo/SearchIndexJobMongo.js";
import { AttachmentMongo } from "../../../src/models/mongo/AttachmentMongo.js";
import { MessageMongo } from "../../../src/models/mongo/MessageMongo.js";
import { RecipientType } from "../../../src/models/types.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("SearchIndexJobMongo Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: SearchIndexJobMongo;
    let messageRepo: MongoRepository<MessageMongo>;
    let attachmentRepo: MongoRepository<AttachmentMongo>;

    const mailboxUid = uuid.v4();

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

    beforeAll(async () => {
        await mongod.start();
        objectFactory = new ObjectFactory(config, logger);
        registerTestDoubles(objectFactory);
        // Normally registered by `Server`'s own bootstrap - registered explicitly here since this file
        // deliberately bypasses `Server` (see ScanQueueJobMongo.test.ts's header comment).
        objectFactory.register(ACLUtils);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("MessageMongo", MessageMongo);
        models.set("AttachmentMongo", AttachmentMongo);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        messageRepo = conn.getMongoRepository("MessageMongo");
        attachmentRepo = conn.getMongoRepository("AttachmentMongo");

        // Constructed once via real ObjectFactory DI: `@Init` builds its two real `RepoUtils` against the live
        // connection above, and `@Inject("BlobStore")`/`@Inject("SearchProvider")` resolve to the registered
        // test doubles.
        job = await objectFactory.newInstance(SearchIndexJobMongo, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
        await mongod.stop();
    });

    beforeEach(async () => {
        for (const repo of [messageRepo, attachmentRepo]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
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
                dateForSort: message.sentDate,
            }),
        );

        const updated = await messageRepo.findOne({ uid: message.uid } as any);
        expect(updated!.searchIndexedAt).toBeInstanceOf(Date);
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

        const updatedBad = await messageRepo.findOne({ uid: badMessage.uid } as any);
        expect(updatedBad!.searchIndexedAt).toBeFalsy();
        const updatedGood = await messageRepo.findOne({ uid: goodMessage.uid } as any);
        expect(updatedGood!.searchIndexedAt).toBeInstanceOf(Date);
    });
});
