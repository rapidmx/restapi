///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for ScheduledSendJobSQL - see ScanQueueJobSQL.test.ts's/
// ScheduledSendJobSQL.test.ts's file headers for the full rationale.
import { ACLUtils, AccessControlListSQL, ConnectionManager, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import config from "../../config.sql.js";
import { registerTestDoubles, RecordingMailTransport } from "../../testDoubles.js";
import { ScheduledSendJobSQL } from "../../../src/jobs/sql/ScheduledSendJobSQL.js";
import { FolderSQL } from "../../../src/models/sql/FolderSQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { MessageSQL } from "../../../src/models/sql/MessageSQL.js";
import { FolderType, MessageImportance, RecipientType } from "../../../src/models/types.js";

describe("ScheduledSendJobSQL Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: ScheduledSendJobSQL;
    let folderRepo: Repository<FolderSQL>;
    let mailboxRepo: Repository<MailboxSQL>;
    let messageRepo: Repository<MessageSQL>;

    let mailboxUid: string;
    let outboxUid: string;

    const transport = (): RecordingMailTransport => objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
    const blobStore = (): any => objectFactory.getInstance<any>("BlobStore")!;
    const findMessage = async (uid: string): Promise<MessageSQL> => (await messageRepo.findOne({ where: { uid } }))!;

    const putBody = async (raw: string = "From: owner@example.com\r\nTo: recipient@example.com\r\nSubject: Hi\r\n\r\nHello there.\r\n") => {
        const bodyBlobKey = `bodies/${uuid.v4()}`;
        await blobStore().put(bodyBlobKey, Buffer.from(raw));
        return bodyBlobKey;
    };

    const createMessage = async (data?: Partial<MessageSQL>): Promise<MessageSQL> => {
        const obj = new MessageSQL({
            mailboxUid,
            folderUid: outboxUid,
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
        models.set("MailboxSQL", MailboxSQL);
        models.set("MessageSQL", MessageSQL);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        folderRepo = conn.getRepository(FolderSQL);
        mailboxRepo = conn.getRepository(MailboxSQL);
        messageRepo = conn.getRepository(MessageSQL);

        job = await objectFactory.newInstance(ScheduledSendJobSQL, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await messageRepo.clear();
        await folderRepo.clear();
        await mailboxRepo.clear();
        transport().sent = [];
        (job as any).batchSize = 50;
        (job as any).maxAttempts = 5;
        (job as any).retryBackoffMs = 60_000;

        const mailbox = await mailboxRepo.save(
            new MailboxSQL({
                ownerUserUid: uuid.v4(),
                primarySmtpAddress: "owner@example.com",
                aliasAddresses: ["alias@example.com"],
                displayName: "Owner",
                timezone: "UTC",
                quotaBytes: 1_000_000_000,
                usedBytes: 0,
            }),
        );
        mailboxUid = mailbox.uid;
        const outbox = await folderRepo.save(new FolderSQL({ mailboxUid, name: "Outbox", type: FolderType.OUTBOX }));
        outboxUid = outbox.uid;
    });

    afterEach(() => {
        vi.restoreAllMocks();
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
        expect(transport().sent.length).toBe(0);
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
        const bodyBlobKey = await putBody();
        const message = await createMessage({ bodyBlobKey, scheduledSendTime: new Date(Date.now() - 60 * 1000) });

        await job.run();

        expect(transport().sent.length).toBe(1);
        expect(transport().sent[0].envelopeFrom).toBe("owner@example.com");

        const sentFolder = await folderRepo.findOne({ where: { mailboxUid, type: FolderType.SENT_ITEMS } });
        expect(sentFolder).toBeDefined();

        const updated = await findMessage(message.uid);
        expect(updated.folderUid).toBe(sentFolder!.uid);
                expect(updated.scheduledSendTime).toBeFalsy();
        expect(updated.scheduledSendAttempts).toBeFalsy();
        expect(updated.scheduledSendError).toBeFalsy();
        expect(updated.scheduledSendRelayedAt).toBeFalsy();
        expect(updated.flags.read).toBe(true);
    });

    it("Does not relay a message whose scheduledSendTime is still in the future.", async () => {
        const bodyBlobKey = await putBody();
        await createMessage({ bodyBlobKey, scheduledSendTime: new Date(Date.now() + 60 * 60 * 1000) });

        await job.run();

        expect(transport().sent.length).toBe(0);
    });

    it("Ignores a message with no scheduledSendTime at all.", async () => {
        await createMessage({ scheduledSendTime: undefined });

        await job.run();

        expect(transport().sent.length).toBe(0);
    });

    it("Re-queues a message that fails to relay with backoff and an attempt count, without sending it.", async () => {
        // No blob was ever put at this key, so `blobStore.get()` inside `relayDueMessage()` rejects,
        // after the claim (its own version-checked clear of scheduledSendTime) has already succeeded.
        const message = await createMessage({
            bodyBlobKey: `bodies/${uuid.v4()}`,
            scheduledSendTime: new Date(Date.now() - 60 * 1000),
        });
        const before = Date.now();

        await expect(job.run()).resolves.toBeUndefined();

        const updated = await findMessage(message.uid);
        expect(updated.scheduledSendTime).toBeTruthy();
        // Pushed forward by attempts x retryBackoffMs (1 x 60s) from now, behind every currently-due message.
        expect(new Date(updated.scheduledSendTime as any).getTime()).toBeGreaterThanOrEqual(before + 60_000);
        expect(updated.scheduledSendAttempts).toBe(1);
        expect(updated.scheduledSendError).toBeTruthy();
        expect(updated.folderUid).toBe(message.folderUid);
        expect(transport().sent.length).toBe(0);
    });

    it("Gives up after max_attempts, leaving the message unsent, out of the queue, with a failure marker.", async () => {
        (job as any).maxAttempts = 2;
        const message = await createMessage({
            bodyBlobKey: `bodies/${uuid.v4()}`,
            scheduledSendTime: new Date(Date.now() - 60 * 1000),
            scheduledSendAttempts: 1,
        });

        await job.run();

        const updated = await findMessage(message.uid);
        expect(updated.scheduledSendTime).toBeFalsy();
        expect(updated.scheduledSendError).toContain("Gave up after 2 attempts");
        expect(updated.scheduledSendAttempts).toBeFalsy();
        expect(updated.folderUid).toBe(outboxUid);
        expect(transport().sent.length).toBe(0);
    });

    it("Does not let a permanently failing message block later due messages behind it.", async () => {
        (job as any).batchSize = 1;
        // The transport test double rejects this recipient outright, on every attempt.
        const failing = await createMessage({
            bodyBlobKey: await putBody("From: owner@example.com\r\nTo: reject@example.com\r\n\r\nHi\r\n"),
            recipients: [{ address: "reject@example.com", type: RecipientType.TO }],
            scheduledSendTime: new Date(Date.now() - 120 * 1000),
        });
        const good = await createMessage({ bodyBlobKey: await putBody(), scheduledSendTime: new Date(Date.now() - 60 * 1000) });

        await job.run();
        // Oldest-due first: only the failing message was in this batch.
        expect(transport().sent.length).toBe(0);
        expect((await findMessage(failing.uid)).scheduledSendAttempts).toBe(1);

        await job.run();
        expect(transport().sent.length).toBe(1);
        expect((await findMessage(good.uid)).scheduledSendTime).toBeFalsy();
    });

    it("Refuses (and dequeues) a due message that is not in its mailbox's Outbox folder.", async () => {
        const drafts = await folderRepo.save(new FolderSQL({ mailboxUid, name: "Drafts", type: FolderType.DRAFTS }));
        const inDrafts = await createMessage({
            folderUid: drafts.uid,
            bodyBlobKey: await putBody(),
            scheduledSendTime: new Date(Date.now() - 60 * 1000),
        });
        const unknownFolder = await createMessage({
            folderUid: uuid.v4(),
            bodyBlobKey: await putBody(),
            scheduledSendTime: new Date(Date.now() - 60 * 1000),
        });
        const otherMailboxOutbox = await folderRepo.save(new FolderSQL({ mailboxUid: uuid.v4(), name: "Outbox", type: FolderType.OUTBOX }));
        const foreignOutbox = await createMessage({
            folderUid: otherMailboxOutbox.uid,
            bodyBlobKey: await putBody(),
            scheduledSendTime: new Date(Date.now() - 60 * 1000),
        });

        await job.run();

        expect(transport().sent.length).toBe(0);
        for (const message of [inDrafts, unknownFolder, foreignOutbox]) {
            const updated = await findMessage(message.uid);
            expect(updated.scheduledSendTime).toBeFalsy();
            expect(updated.scheduledSendError).toContain("Outbox");
            expect(updated.folderUid).toBe(message.folderUid);
        }
    });

    it("Refuses (and dequeues) a message whose From address is not one of the mailbox's own addresses.", async () => {
        const message = await createMessage({
            from: { address: "ceo@example.com", type: RecipientType.TO },
            bodyBlobKey: await putBody(),
            scheduledSendTime: new Date(Date.now() - 60 * 1000),
        });

        await job.run();

        expect(transport().sent.length).toBe(0);
        const updated = await findMessage(message.uid);
        expect(updated.scheduledSendTime).toBeFalsy();
        expect(updated.scheduledSendError).toContain("From address");
        expect(updated.folderUid).toBe(outboxUid);
    });

    it("Refuses a message whose mailbox no longer exists.", async () => {
        await mailboxRepo.clear();
        const message = await createMessage({ bodyBlobKey: await putBody(), scheduledSendTime: new Date(Date.now() - 60 * 1000) });

        await job.run();

        expect(transport().sent.length).toBe(0);
        expect((await findMessage(message.uid)).scheduledSendError).toContain("mailbox");
    });

    it("Accepts a From address matching one of the mailbox's aliases, case-insensitively.", async () => {
        await createMessage({
            from: { address: "Alias@Example.COM", type: RecipientType.TO },
            bodyBlobKey: await putBody(),
            scheduledSendTime: new Date(Date.now() - 60 * 1000),
        });

        await job.run();

        expect(transport().sent.length).toBe(1);
    });

    it("Never re-relays a message whose post-relay filing failed - the next run only finishes filing.", async () => {
        const message = await createMessage({ bodyBlobKey: await putBody(), scheduledSendTime: new Date(Date.now() - 60 * 1000) });

        // Fails the final re-fetch, after the transport already accepted the message.
        const repoUtils = (job as any).messageRepo;
        vi.spyOn(repoUtils, "findOne").mockRejectedValueOnce(new Error("simulated filing failure"));

        await job.run();

        expect(transport().sent.length).toBe(1);
        let updated = await findMessage(message.uid);
        expect(updated.scheduledSendRelayedAt).toBeTruthy();
        expect(updated.scheduledSendTime).toBeTruthy();
        expect(updated.scheduledSendAttempts).toBe(1);
        expect(updated.folderUid).toBe(outboxUid);
        vi.restoreAllMocks();

        // Make it due again (skipping the backoff) and re-run: it must be filed, not sent a second time.
        await messageRepo.update({ uid: message.uid }, { scheduledSendTime: new Date(Date.now() - 1000) });
        await job.run();

        expect(transport().sent.length).toBe(1);
        const sentFolder = await folderRepo.findOne({ where: { mailboxUid, type: FolderType.SENT_ITEMS } });
        updated = await findMessage(message.uid);
        expect(updated.folderUid).toBe(sentFolder!.uid);
        expect(updated.scheduledSendTime).toBeFalsy();
        expect(updated.scheduledSendRelayedAt).toBeFalsy();
        expect(updated.scheduledSendAttempts).toBeFalsy();
        expect(updated.scheduledSendError).toBeFalsy();
    });

    it("Treats a failure inside scanAndRelay() after the transport accepted the message as relayed, not as a relay failure.", async () => {
        // An HTML body makes scanAndRelay() store a sanitized-HTML blob AFTER the transport accepted the message;
        // that put is made to fail, so scanAndRelay() itself rejects even though the email was really sent.
        const message = await createMessage({
            bodyBlobKey: await putBody(
                "From: owner@example.com\r\nTo: recipient@example.com\r\nSubject: Hi\r\nContent-Type: text/html\r\n\r\n<p>Hello</p>\r\n",
            ),
            scheduledSendTime: new Date(Date.now() - 60 * 1000),
        });
        const store = blobStore();
        const realPut = store.put.bind(store);
        vi.spyOn(store, "put").mockImplementation(async (key: string, ...rest: any[]) => {
            if (key.startsWith("sanitized/")) {
                throw new Error("simulated post-relay blob failure");
            }
            return realPut(key, ...rest);
        });

        await job.run();

        expect(transport().sent.length).toBe(1);
        const sentFolder = await folderRepo.findOne({ where: { mailboxUid, type: FolderType.SENT_ITEMS } });
        const updated = await findMessage(message.uid);
        expect(updated.folderUid).toBe(sentFolder!.uid);
        expect(updated.scheduledSendTime).toBeFalsy();
        expect(updated.scheduledSendAttempts).toBeFalsy();
        // The relayed Message-ID is still persisted, recovered from the bytes the transport actually sent.
        expect(updated.messageId).toBeTruthy();
    });

    it("Does not relay when the message was already modified since it was fetched - the claim itself fails, before any email is sent.", async () => {
        const message = await createMessage({ bodyBlobKey: await putBody(), scheduledSendTime: new Date(Date.now() - 60 * 1000) });

        // Simulates a concurrent cancel/edit that already bumped this row's version in the DB, between
        // this job's own find() and relayDueMessage() being called with the now-stale `message` object -
        // exactly the race relayDueMessage()'s own claim step is meant to close.
        await messageRepo.increment({ uid: message.uid }, "version", 1);

        await expect((job as any).relayDueMessage(message)).rejects.toThrow();

        expect(transport().sent.length).toBe(0);

        const current = await findMessage(message.uid);
        expect(current.folderUid).toBe(message.folderUid);
    });

    it("Logs a warning (without throwing) when even recording a failed attempt itself fails.", async () => {
        // No blob was ever put at this key, so the relay itself fails after the claim succeeds for real;
        // the claim's own update() call is then made to reject too, on the failed-attempt write specifically.
        const message = await createMessage({
            bodyBlobKey: `bodies/${uuid.v4()}`,
            scheduledSendTime: new Date(Date.now() - 60 * 1000),
        });

        const repoUtils = (job as any).messageRepo;
        const realUpdate = repoUtils.update.bind(repoUtils);
        vi.spyOn(repoUtils, "update").mockImplementationOnce(realUpdate).mockRejectedValueOnce(new Error("restore also failed"));

        await expect(job.run()).resolves.toBeUndefined();

        expect(transport().sent.length).toBe(0);
        // The failed write never landed, so scheduledSendTime stays cleared (the claim's own successful
        // write) - the message simply drops out of the queue rather than being retried.
        const current = await findMessage(message.uid);
        expect(current.scheduledSendTime).toBeFalsy();
    });
});
