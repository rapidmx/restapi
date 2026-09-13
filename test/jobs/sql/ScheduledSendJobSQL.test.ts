///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for ScheduledSendJobSQL - see ScanQueueJobSQL.test.ts's/
// ScheduledSendJobMongo.test.ts's file headers for the full rationale.
import { ACLUtils, AccessControlListSQL, ConnectionManager, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import config from "../../config.sql.js";
import { registerTestDoubles, RecordingMailTransport } from "../../testDoubles.js";
import { ScheduledSendJobSQL } from "../../../src/jobs/sql/ScheduledSendJobSQL.js";
import { FolderSQL } from "../../../src/models/sql/FolderSQL.js";
import { MessageSQL } from "../../../src/models/sql/MessageSQL.js";
import { FolderType, MessageImportance, RecipientType } from "../../../src/models/types.js";

describe("ScheduledSendJobSQL Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: ScheduledSendJobSQL;
    let folderRepo: Repository<FolderSQL>;
    let messageRepo: Repository<MessageSQL>;

    const mailboxUid = uuid.v4();

    const createMessage = async (data?: Partial<MessageSQL>): Promise<MessageSQL> => {
        const obj = new MessageSQL({
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
        objectFactory = new ObjectFactory(config, logger);
        registerTestDoubles(objectFactory);
        objectFactory.register(ACLUtils);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("AccessControlListSQL", AccessControlListSQL);
        models.set("FolderSQL", FolderSQL);
        models.set("MessageSQL", MessageSQL);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        folderRepo = conn.getRepository(FolderSQL);
        messageRepo = conn.getRepository(MessageSQL);

        job = await objectFactory.newInstance(ScheduledSendJobSQL, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await messageRepo.clear();
        await folderRepo.clear();
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

        const sentFolder = await folderRepo.findOne({ where: { mailboxUid, type: FolderType.SENT_ITEMS } });
        expect(sentFolder).toBeDefined();

        const updated = await messageRepo.findOne({ where: { uid: message.uid } });
        expect(updated!.folderUid).toBe(sentFolder!.uid);
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
        // No blob was ever put at this key, so `blobStore.get()` inside `relayDueMessage()` rejects,
        // after the claim (its own version-checked clear of scheduledSendTime) has already succeeded -
        // this exercises the restore-on-failure path, not just "the field was never touched".
        const message = await createMessage({
            bodyBlobKey: `bodies/${uuid.v4()}`,
            scheduledSendTime: new Date(Date.now() - 60 * 1000),
        });

        await expect(job.run()).resolves.toBeUndefined();

        const updated = await messageRepo.findOne({ where: { uid: message.uid } });
        expect(updated!.scheduledSendTime).toBeTruthy();
        expect(new Date(updated!.scheduledSendTime as any).getTime()).toBe((message.scheduledSendTime as Date).getTime());
        expect(updated!.folderUid).toBe(message.folderUid);

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(0);
    });

    it("Does not relay when the message was already modified since it was fetched - the claim itself fails, before any email is sent.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const bodyBlobKey = `bodies/${uuid.v4()}`;
        await blobStore.put(bodyBlobKey, Buffer.from("From: owner@example.com\r\nTo: recipient@example.com\r\n\r\nHi\r\n"));
        const message = await createMessage({ bodyBlobKey, scheduledSendTime: new Date(Date.now() - 60 * 1000) });

        // Simulates a concurrent cancel/edit that already bumped this row's version in the DB, between
        // this job's own find() and relayDueMessage() being called with the now-stale `message` object -
        // exactly the race relayDueMessage()'s own claim step is meant to close.
        await messageRepo.increment({ uid: message.uid }, "version", 1);

        await expect((job as any).relayDueMessage(message)).rejects.toThrow();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(0);

        const current = await messageRepo.findOne({ where: { uid: message.uid } });
        expect(current!.folderUid).toBe(message.folderUid);
    });

    it("Logs a warning (without throwing) when even restoring scheduledSendTime after a relay failure itself fails.", async () => {
        // No blob was ever put at this key, so the relay itself fails after the claim succeeds for real;
        // the claim's own update() call is then made to reject too, on the restore attempt specifically.
        const message = await createMessage({
            bodyBlobKey: `bodies/${uuid.v4()}`,
            scheduledSendTime: new Date(Date.now() - 60 * 1000),
        });

        const repoUtils = (job as any).messageRepo;
        const realUpdate = repoUtils.update.bind(repoUtils);
        vi.spyOn(repoUtils, "update").mockImplementationOnce(realUpdate).mockRejectedValueOnce(new Error("restore also failed"));

        await expect(job.run()).resolves.toBeUndefined();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(0);
        // The failed restore never wrote anything back, so scheduledSendTime stays cleared (the claim's
        // own successful write) - a real, if rare, gap this best-effort restore doesn't attempt to close
        // further (see relayDueMessage()'s own doc comment for why not).
        const current = await messageRepo.findOne({ where: { uid: message.uid } });
        expect(current!.scheduledSendTime).toBeFalsy();
    });
});
