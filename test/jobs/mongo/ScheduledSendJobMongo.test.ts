///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for ScheduledSendJobMongo - see ScanQueueJobMongo.test.ts's file header for
// the full rationale behind bypassing `Server`/`ClassLoader` and doubling only the real external boundaries
// (BlobStore/scan providers/MailTransport), keeping everything else (repos, ScanPipeline) real.
import { MongoMemoryServer } from "mongodb-memory-server";
import { ACLUtils, ConnectionManager, MongoConnection, MongoRepository, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../../config.js";
import { registerTestDoubles, RecordingMailTransport } from "../../testDoubles.js";
import { ScheduledSendJobMongo } from "../../../src/jobs/mongo/ScheduledSendJobMongo.js";
import { FolderMongo } from "../../../src/models/mongo/FolderMongo.js";
import { MessageMongo } from "../../../src/models/mongo/MessageMongo.js";
import { FolderType, MessageImportance, RecipientType } from "../../../src/models/types.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("ScheduledSendJobMongo Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: ScheduledSendJobMongo;
    let folderRepo: MongoRepository<FolderMongo>;
    let messageRepo: MongoRepository<MessageMongo>;

    const mailboxUid = uuid.v4();

    const createMessage = async (data?: Partial<MessageMongo>): Promise<MessageMongo> => {
        const obj = new MessageMongo({
            mailboxUid,
            folderUid: uuid.v4(),
            messageId: `${uuid.v4()}@example.com`,
            subject: "Scheduled message",
            from: { address: "owner@example.com", type: RecipientType.TO },
            recipients: [{ address: "recipient@example.com", type: RecipientType.TO }],
            sentDate: new Date(),
            receivedDate: new Date(),
            bodyBlobKey: `bodies/${uuid.v4()}`,
            bodyPreview: "Hello",
            flags: { read: false, flagged: false, answered: false, forwarded: false },
            importance: MessageImportance.NORMAL,
            references: [],
            hasAttachments: false,
            ...data,
        });
        return await messageRepo.save(obj);
    };

    beforeAll(async () => {
        await mongod.start();
        objectFactory = new ObjectFactory(config, logger);
        registerTestDoubles(objectFactory);
        objectFactory.register(ACLUtils);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("FolderMongo", FolderMongo);
        models.set("MessageMongo", MessageMongo);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        folderRepo = conn.getMongoRepository("FolderMongo");
        messageRepo = conn.getMongoRepository("MessageMongo");

        job = await objectFactory.newInstance(ScheduledSendJobMongo, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
        await mongod.stop();
    });

    beforeEach(async () => {
        for (const repo of [folderRepo, messageRepo]) {
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

    it("Exposes the configured cron schedule.", () => {
        expect(job.schedule).toBe(config.get("mail:jobs:scheduled_send:schedule"));
    });

    it("start() and stop() are no-ops beyond init().", async () => {
        await expect(job.start()).resolves.toBeUndefined();
        expect(job.stop()).toBeUndefined();
    });

    it("Does nothing when there are no due messages.", async () => {
        await expect(job.run()).resolves.toBeUndefined();
        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(0);
    });

    it("Does nothing when messageRepo is not yet initialized.", async () => {
        const original = (job as any).messageRepo;
        (job as any).messageRepo = undefined;
        try {
            await expect(job.run()).resolves.toBeUndefined();
        } finally {
            (job as any).messageRepo = original;
        }
    });

    it("Relays a due scheduled message, moves it to Sent Items, and clears scheduledSendTime.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const bodyBlobKey = `bodies/${uuid.v4()}`;
        await blobStore.put(
            bodyBlobKey,
            Buffer.from("From: owner@example.com\r\nTo: recipient@example.com\r\nSubject: Hi\r\n\r\nHello there.\r\n"),
        );
        const message = await createMessage({ bodyBlobKey, scheduledSendTime: new Date(Date.now() - 60 * 1000) });

        await job.run();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(1);
        expect(transport.sent[0].envelopeFrom).toBe("owner@example.com");

        const sentFolder = await folderRepo.findOne({ mailboxUid, type: FolderType.SENT_ITEMS } as any);
        expect(sentFolder).toBeDefined();

        const updated = await messageRepo.findOne({ uid: message.uid } as any);
        expect(updated!.folderUid).toBe(sentFolder!.uid);
        // An unset nullable Date column round-trips as `null`, not `undefined`, on Mongo - `toBeFalsy()` covers
        // both rather than asserting the exact in-memory representation.
        expect(updated!.scheduledSendTime).toBeFalsy();
        expect(updated!.flags.read).toBe(true);
    });

    it("Does not relay a message whose scheduledSendTime is still in the future.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const bodyBlobKey = `bodies/${uuid.v4()}`;
        await blobStore.put(bodyBlobKey, Buffer.from("From: owner@example.com\r\nTo: recipient@example.com\r\n\r\nHi\r\n"));
        await createMessage({ bodyBlobKey, scheduledSendTime: new Date(Date.now() + 60 * 60 * 1000) });

        await job.run();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(0);
    });

    it("Ignores a message with no scheduledSendTime at all.", async () => {
        await createMessage({ scheduledSendTime: undefined });

        await job.run();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(0);
    });

    it("Leaves a message that fails to relay as-is (still carrying its due scheduledSendTime) for retry next poll.", async () => {
        // No blob was ever put at this key, so `blobStore.get()` inside `relayDueMessage()` rejects.
        const message = await createMessage({
            bodyBlobKey: `bodies/${uuid.v4()}`,
            scheduledSendTime: new Date(Date.now() - 60 * 1000),
        });

        await expect(job.run()).resolves.toBeUndefined();

        const updated = await messageRepo.findOne({ uid: message.uid } as any);
        expect(updated!.scheduledSendTime).toBeTruthy();
        expect(updated!.folderUid).toBe(message.folderUid);

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(0);
    });
});
