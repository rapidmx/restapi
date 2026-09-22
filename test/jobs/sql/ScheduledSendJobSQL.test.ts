///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for ScheduledSendJobSQL - see ScanQueueJobSQL.test.ts's/
// ScheduledSendJobSQL.test.ts's file headers for the full rationale.
import { ACLUtils, NotificationUtils, AccessControlListSQL, ConnectionManager, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { simpleParser } from "mailparser";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import config from "../../config.sql.js";
import { registerTestDoubles, RecordingMailTransport } from "../../testDoubles.js";
import { backgroundSendSuite } from "../backgroundSendSuite.js";
import { ScheduledSendJobSQL } from "../../../src/jobs/sql/ScheduledSendJobSQL.js";
import { DomainSQL } from "../../../src/models/sql/DomainSQL.js";
import { FolderSQL } from "../../../src/models/sql/FolderSQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { MessageSQL } from "../../../src/models/sql/MessageSQL.js";
import { FolderType, MessageImportance, RecipientType } from "../../../src/models/types.js";
import { boundIndexedValue } from "../../../src/util/ConversationUtils.js";

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

    const findFolder = async (type: FolderType): Promise<any> => await folderRepo.findOne({ where: { mailboxUid, type } });
    const inboxNotices = async (): Promise<MessageSQL[]> => {
        const inbox = await findFolder(FolderType.INBOX);
        return inbox ? await messageRepo.find({ where: { folderUid: inbox.uid } }) : [];
    };
    const messageRepoUpdate = async (uid: string, fields: any): Promise<void> => {
        await messageRepo.update({ uid }, fields);
    };

    const expireLease = async (uid: string): Promise<void> => {
        await messageRepo.update({ uid }, { scheduledSendTime: new Date(Date.now() - 1000) });
    };

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
        models.set("DomainSQL", DomainSQL);
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

    it("start() sweeps without waiting and stop() waits for what is in flight - both are quiet with nothing due.", async () => {
        await expect(job.start()).resolves.toBeUndefined();
        await job.whenIdle();
        await expect(job.stop()).resolves.toBeUndefined();
        await job.start();
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
        const sendMessageSpy = vi.spyOn(NotificationUtils.prototype, "sendMessage");

        await job.run();

        expect(transport().sent.length).toBe(1);
        expect(transport().sent[0].envelopeFrom).toBe("owner@example.com");
        // Outbox -> Sent Items: the counts of both folders are published.
        const countEvents = sendMessageSpy.mock.calls
            .filter(([, type, action]) => /^Folder/.test(String(type)) && action === "update")
            .map(([, , , data]: any[]) => data)
            .filter((data) => Object.keys(data).length === 4);
        sendMessageSpy.mockRestore();
        const sentUid = (await findMessage(message.uid)).folderUid;
        expect(countEvents).toEqual(
            expect.arrayContaining([
                { uid: outboxUid, mailboxUid, unreadCount: 0, totalCount: 0 },
                { uid: sentUid, mailboxUid, unreadCount: 0, totalCount: 1 },
            ]),
        );
        expect(countEvents).toHaveLength(2);

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

    it("Files a scheduled reply into the conversation its parent is already in, resolved the same way an immediate send is.", async () => {
        // The parent this mailbox already holds - the scheduled reply names only its direct parent, so without the
        // mailbox lookup it would start a conversation of its own keyed on `second@example.com`.
        await createMessage({ messageId: "root@example.com", conversationId: "root@example.com", subject: "Hello", scheduledSendTime: undefined });
        await createMessage({
            messageId: "second@example.com",
            conversationId: "root@example.com",
            inReplyTo: "root@example.com",
            subject: "Re: Hello",
            scheduledSendTime: undefined,
        });
        const bodyBlobKey = await putBody(
            "From: owner@example.com\r\nTo: recipient@example.com\r\nSubject: Re: Hello\r\n" +
                "Message-ID: <scheduled@example.com>\r\nIn-Reply-To: <second@example.com>\r\n\r\nReply body.\r\n",
        );
        const message = await createMessage({ bodyBlobKey, scheduledSendTime: new Date(Date.now() - 60 * 1000) });

        await job.run();

        const updated = await findMessage(message.uid);
        expect(updated.conversationId).toBe("root@example.com");
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

    describe("delivery failure notices", () => {
        const past = () => new Date(Date.now() - 60 * 1000);
        const noticeText = async (notice: any): Promise<string> => (await simpleParser(await blobStore().get(notice.bodyBlobKey))).text!;

        it("Tells the sender in their Inbox, once, when it gives up on a message the mail system refused - with its diagnostics.", async () => {
            (job as any).maxAttempts = 1;
            const message = await createMessage({
                subject: "Refused",
                bodyBlobKey: await putBody("From: owner@example.com\r\nTo: reject@example.com\r\nBcc: hidden@example.com\r\nSubject: Refused\r\n\r\nSecret body\r\n"),
                recipients: [{ address: "reject@example.com", type: RecipientType.TO }],
                scheduledSendTime: past(),
            });

            await job.run();

            const notices = await inboxNotices();
            expect(notices).toHaveLength(1);
            const notice: any = notices[0];
            expect(notice.subject).toBe("Undeliverable: Refused");
            expect(notice.from).toMatchObject({ address: "postmaster@example.com", displayName: "Mail Delivery System" });
            expect(notice.recipients.map((recipient: any) => recipient.address)).toEqual(["owner@example.com"]);
            expect(notice.flags.read).toBe(false);
            const raw: string = (await blobStore().get(notice.bodyBlobKey)).toString();
            expect(raw).toContain("Final-Recipient: rfc822; reject@example.com");
            expect(raw).toContain("Status: 5.7.1");
            expect(raw).toContain("Diagnostic-Code: smtp; 554 5.7.1 <reject@example.com>: Recipient address rejected: Access denied");
            expect(raw).not.toContain("hidden@example.com");
            expect(raw).not.toContain("Secret body");
            const text = await noticeText(notice);
            expect(text).toContain("Reason: Gave up after 1 attempts: This message could not be sent: the mail system refused it for reject@example.com.");
            expect(text).toContain("Transport:   recording");
            expect(text).toContain("Server response:  554 5.7.1 <reject@example.com>: Recipient address rejected: Access denied");
            expect((await findMessage(message.uid)).scheduledSendError).toContain("Gave up after 1 attempts");

            // Nothing more comes of it: the message is out of the queue, and a second look reports nothing new.
            await job.run();
            expect(await inboxNotices()).toHaveLength(1);
        });

        it("Reports each giving-up separately - a message rescheduled and failing again is a new failure.", async () => {
            (job as any).maxAttempts = 1;
            const message = await createMessage({
                bodyBlobKey: await putBody("From: owner@example.com\r\nTo: reject@example.com\r\n\r\nHi\r\n"),
                recipients: [{ address: "reject@example.com", type: RecipientType.TO }],
                scheduledSendTime: past(),
            });
            await job.run();
            expect(await inboxNotices()).toHaveLength(1);

            await messageRepoUpdate(message.uid, { scheduledSendTime: past(), scheduledSendError: null });
            await job.run();

            expect(await inboxNotices()).toHaveLength(2);
        });

        it("Does not tell the sender a message failed after the transport had accepted it - it was delivered.", async () => {
            (job as any).maxAttempts = 1;
            const message = await createMessage({ bodyBlobKey: await putBody(), scheduledSendTime: past() });
            // Fails the final re-fetch, after the transport already accepted the message.
            vi.spyOn((job as any).messageRepo, "findOne").mockRejectedValueOnce(new Error("simulated filing failure"));

            await job.run();

            expect(transport().sent.length).toBe(1);
            expect((await findMessage(message.uid)).scheduledSendError).toContain("Gave up after 1 attempts");
            expect(await inboxNotices()).toEqual([]);
        });

        it("Tells the sender why a message was refused without being sent, in the job's own words.", async () => {
            await createMessage({
                from: { address: "ceo@example.com", type: RecipientType.TO },
                bodyBlobKey: await putBody(),
                scheduledSendTime: past(),
            });

            await job.run();

            const notices = await inboxNotices();
            expect(notices).toHaveLength(1);
            const raw: string = (await blobStore().get((notices[0] as any).bodyBlobKey)).toString();
            expect(raw).toContain("Final-Recipient: rfc822; recipient@example.com");
            expect(raw).toContain("Status: 5.0.0");
            expect(raw).toContain("Diagnostic-Code: X-RapidMX; The From address is not one of the sending mailbox's own addresses.");
            expect(await noticeText(notices[0])).toContain("Reason: The From address is not one of the sending mailbox's own addresses.");
        });

        it("Tells the sender which recipients the mail system refused while relaying to the others, and still files the message as sent.", async () => {
            const message = await createMessage({
                subject: "Mixed",
                bodyBlobKey: await putBody("From: owner@example.com\r\nTo: ok@example.com, partial-reject@example.com\r\nSubject: Mixed\r\n\r\nHi\r\n"),
                recipients: [
                    { address: "ok@example.com", type: RecipientType.TO },
                    { address: "partial-reject@example.com", type: RecipientType.TO },
                ],
                scheduledSendTime: past(),
            });

            await job.run();

            expect(transport().sent.map((sent) => sent.envelopeTo)).toEqual([["ok@example.com"]]);
            const sentFolder: any = await findFolder(FolderType.SENT_ITEMS);
            expect((await findMessage(message.uid)).folderUid).toBe(sentFolder.uid);
            const notices = await inboxNotices();
            expect(notices).toHaveLength(1);
            const raw: string = (await blobStore().get((notices[0] as any).bodyBlobKey)).toString();
            expect(raw).toContain("Final-Recipient: rfc822; partial-reject@example.com");
            expect(raw).not.toContain("Final-Recipient: rfc822; ok@example.com");
            expect(await noticeText(notices[0])).toContain("The mail system accepted this message for some of its recipients but refused these.");
        });

        it("Never lets a failure to file the notice change what happens to the message.", async () => {
            (job as any).maxAttempts = 1;
            const put = blobStore().put.bind(blobStore());
            vi.spyOn(blobStore(), "put").mockImplementation((key: string, ...rest: any[]) =>
                key.startsWith("notices/") ? Promise.reject(new Error("blob store down")) : put(key, ...rest),
            );
            const warn = vi.spyOn((job as any).logger, "warn");
            const message = await createMessage({
                bodyBlobKey: await putBody("From: owner@example.com\r\nTo: reject@example.com\r\n\r\nHi\r\n"),
                recipients: [{ address: "reject@example.com", type: RecipientType.TO }],
                scheduledSendTime: past(),
            });

            await job.run();

            expect((await findMessage(message.uid)).scheduledSendError).toContain("Gave up after 1 attempts");
            expect(await inboxNotices()).toEqual([]);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("Failed to file the delivery failure notice for scheduled message"));
        });

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
        // Refused for good (an SMTP 5xx for every recipient) - out of the queue at once, not retried.
        const refused: any = await findMessage(failing.uid);
        expect(refused.scheduledSendTime).toBeFalsy();
        expect(refused.scheduledSendError).toContain("Recipient address rejected");

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
        // The failed write never landed, so the claim's own lease is what remains: scheduledSendTime is pushed
        // into the future (not cleared), so the message is retried once the lease expires rather than lost.
        const current = await findMessage(message.uid);
        expect(new Date(current.scheduledSendTime as any).getTime()).toBeGreaterThan(Date.now() + 60_000);
    });

    describe("Claim lease", () => {
        it("Claims with a lease (scheduledSendTime pushed lease_ms ahead) rather than clearing it, so a crash mid-relay doesn't lose the send.", async () => {
            (job as any).leaseMs = 10 * 60 * 1000;
            const message = await createMessage({ bodyBlobKey: await putBody(), scheduledSendTime: new Date(Date.now() - 60 * 1000) });
            let midFlight: any;
            // Simulates the process dying mid-relay: the claim has landed, then nothing after it gets to run.
            vi.spyOn(blobStore(), "get").mockImplementationOnce(async () => {
                midFlight = await findMessage(message.uid);
                throw new Error("simulated crash");
            });
            vi.spyOn(job as any, "recordFailedAttempt").mockResolvedValueOnce(undefined);

            await job.run();

            expect(transport().sent.length).toBe(0);
            const leasedUntil: number = new Date(midFlight.scheduledSendTime).getTime();
            expect(leasedUntil).toBeGreaterThan(Date.now() + 5 * 60 * 1000);
            expect(new Date((await findMessage(message.uid)).scheduledSendTime as any).getTime()).toBe(leasedUntil);
            vi.restoreAllMocks();

            // Not due again until the lease expires...
            await job.run();
            expect(transport().sent.length).toBe(0);

            // ...and once it has, it is relayed and the lease is released.
            await expireLease(message.uid);
            await job.run();
            expect(transport().sent.length).toBe(1);
            expect((await findMessage(message.uid)).scheduledSendTime).toBeFalsy();
        });
    });

    describe("Stored MIME originator headers", () => {
        const runWithBody = async (raw: string): Promise<any> => {
            const message = await createMessage({ bodyBlobKey: await putBody(raw), scheduledSendTime: new Date(Date.now() - 60 * 1000) });
            await job.run();
            return await findMessage(message.uid);
        };

        it("Refuses (and dequeues) a message whose stored From header names another address, even though from.address is valid.", async () => {
            const updated = await runWithBody("From: CEO <ceo@example.com>\r\nTo: recipient@example.com\r\n\r\nHi\r\n");
            expect(transport().sent.length).toBe(0);
            expect(updated.scheduledSendTime).toBeFalsy();
            expect(updated.scheduledSendError).toContain("From header");
            expect(updated.folderUid).toBe(outboxUid);
        });

        it("Refuses a stored From header listing an allowed address alongside a foreign one.", async () => {
            const updated = await runWithBody("From: owner@example.com, ceo@example.com\r\nTo: recipient@example.com\r\n\r\nHi\r\n");
            expect(transport().sent.length).toBe(0);
            expect(updated.scheduledSendError).toContain("From header");
        });

        it("Refuses a message with two From headers.", async () => {
            const updated = await runWithBody("From: owner@example.com\r\nfrom: ceo@example.com\r\n\r\nHi\r\n");
            expect(transport().sent.length).toBe(0);
            expect(updated.scheduledSendError).toContain("more than one From");
        });

        it("Refuses a folded From header whose continuation line carries a foreign address.", async () => {
            const updated = await runWithBody("From: owner@example.com,\r\n ceo@example.com\r\n\r\nHi\r\n");
            expect(transport().sent.length).toBe(0);
            expect(updated.scheduledSendError).toContain("From header");
        });

        it("Refuses a Sender header naming a foreign address.", async () => {
            const updated = await runWithBody("From: owner@example.com\r\nSENDER: ceo@example.com\r\n\r\nHi\r\n");
            expect(transport().sent.length).toBe(0);
            expect(updated.scheduledSendError).toContain("Sender header");
        });

        it("Refuses a stored From whose display name carries an address (the same rule as BaseMessageRoute.send()).", async () => {
            const updated = await runWithBody('From : "ceo@victim.com" <owner@example.com>\r\nTo: recipient@example.com\r\n\r\nHi\r\n');
            expect(transport().sent.length).toBe(0);
            expect(updated.scheduledSendError).toContain("display name");
            expect(updated.scheduledSendLeaseExpiresAt).toBeFalsy();
        });

        it("Refuses a stored message with no From header at all.", async () => {
            const updated = await runWithBody("To: recipient@example.com\r\n\r\nHi\r\n");
            expect(transport().sent.length).toBe(0);
            expect(updated.scheduledSendError).toContain("no From header");
        });

        it("Relays when every From/Sender address (quoted display names, group syntax, aliases, any case) is the mailbox's own.", async () => {
            const updated = await runWithBody(
                'From: "Doe, Owner (the boss)" <Owner@Example.com>, team: =?utf-8?Q?Alias?= <alias@example.com>;\r\nSender: owner@example.com\r\nTo: recipient@example.com\r\n\r\nHi\r\n',
            );
            expect(transport().sent.length).toBe(1);
            expect(updated.scheduledSendError).toBeFalsy();
        });
    });

    describe("Round 5: in-flight claim, relayed marker, bounded ids", () => {
        const repoUtils = (): any => (job as any).messageRepo;
        const past = (): Date => new Date(Date.now() - 60 * 1000);

        it("Marks the claim in flight, and doesn't file a message that left Outbox under the claim mid-relay.", async () => {
            const drafts = await folderRepo.save(new FolderSQL({ mailboxUid, name: "Drafts", type: FolderType.DRAFTS }));
            const message = await createMessage({ bodyBlobKey: await putBody(), scheduledSendTime: past() });
            let midFlight: any;
            const realSend = transport().send.bind(transport());
            vi.spyOn(transport(), "send").mockImplementationOnce(async (outbound: any) => {
                midFlight = await findMessage(message.uid);
                // A move that got past the in-flight marker (e.g. once a slow relay outlived its lease).
                const current = await repoUtils().findOne(message.uid, { ignoreACL: true });
                await repoUtils().update(
                    { uid: current.uid, version: current.version, folderUid: drafts.uid, scheduledSendTime: null, scheduledSendLeaseExpiresAt: null },
                    current,
                    { ignoreACL: true },
                );
                return realSend(outbound);
            });

            await job.run();

            expect(midFlight.scheduledSendLeaseExpiresAt).toBeTruthy();
            expect(new Date(midFlight.scheduledSendLeaseExpiresAt).getTime()).toBe(new Date(midFlight.scheduledSendTime).getTime());
            expect(transport().sent.length).toBe(1);
            const after = await findMessage(message.uid);
            expect(after.folderUid).toBe(drafts.uid);
            // The relay is still recorded, so the message can't be sent a second time.
            expect(after.scheduledSendRelayedAt).toBeTruthy();
        });

        it("Stores an over-long relayed Message-ID bounded, so a varchar(255) column can't fail the filing.", async () => {
            const longId = `${"x".repeat(300)}@example.com`;
            const message = await createMessage({
                bodyBlobKey: await putBody(`Message-ID: <${longId}>\r\nFrom: owner@example.com\r\nTo: recipient@example.com\r\n\r\nHi\r\n`),
                scheduledSendTime: past(),
            });
            const realUpdate = repoUtils().update.bind(repoUtils());
            const writes: string[][] = [];
            vi.spyOn(repoUtils(), "update").mockImplementation(async (obj: any, ...rest: any[]) => {
                writes.push(Object.keys(obj).sort());
                // What MySQL/MariaDB does with a varchar(255) column.
                for (const field of ["messageId", "conversationId"]) {
                    if (typeof obj[field] === "string" && obj[field].length > 255) {
                        throw new Error(`ER_DATA_TOO_LONG: ${field}`);
                    }
                }
                return realUpdate(obj, ...rest);
            });

            await job.run();

            expect(transport().sent.length).toBe(1);
            const updated = await findMessage(message.uid);
            expect(updated.folderUid).not.toBe(outboxUid);
            expect(updated.scheduledSendTime).toBeFalsy();
            expect(updated.scheduledSendLeaseExpiresAt).toBeFalsy();
            expect(updated.scheduledSendRelayedAt).toBeFalsy();
            expect(updated.messageId).toBe(boundIndexedValue(longId));
            expect(updated.conversationId).toBe(boundIndexedValue(longId));
            // Claim, then the relayed marker on its own, then the filing.
            expect(writes[1]).toEqual(["scheduledSendRelayedAt", "uid", "version"]);
        });

        it("Persists the relayed marker the moment the transport accepts, so even a filing and bookkeeping failure never relays twice.", async () => {
            const message = await createMessage({ bodyBlobKey: await putBody(), scheduledSendTime: past() });
            const realUpdate = repoUtils().update.bind(repoUtils());
            vi.spyOn(repoUtils(), "update").mockImplementation(async (obj: any, ...rest: any[]) => {
                if ("folderUid" in obj || "scheduledSendAttempts" in obj) {
                    throw new Error("simulated database failure");
                }
                return realUpdate(obj, ...rest);
            });

            await job.run();

            expect(transport().sent.length).toBe(1);
            const afterFailure = await findMessage(message.uid);
            expect(afterFailure.scheduledSendRelayedAt).toBeTruthy();
            expect(afterFailure.folderUid).toBe(outboxUid);
            vi.restoreAllMocks();

            await expireLease(message.uid);
            await job.run();

            expect(transport().sent.length).toBe(1);
            const filed = await findMessage(message.uid);
            expect(filed.folderUid).not.toBe(outboxUid);
            expect(filed.scheduledSendRelayedAt).toBeFalsy();
            expect(filed.scheduledSendLeaseExpiresAt).toBeFalsy();
        });

        it("Retries the relayed marker after a version conflict with an unrelated write.", async () => {
            const message = await createMessage({ bodyBlobKey: await putBody(), scheduledSendTime: past() });
            const realSend = transport().send.bind(transport());
            vi.spyOn(transport(), "send").mockImplementationOnce(async (outbound: any) => {
                // The user flags the message while it is on the wire - the claim's version is now stale.
                const current = await repoUtils().findOne(message.uid, { ignoreACL: true });
                await repoUtils().update({ uid: current.uid, version: current.version, flags: { ...current.flags, flagged: true } }, current, { ignoreACL: true });
                return realSend(outbound);
            });
            const realUpdate = repoUtils().update.bind(repoUtils());
            vi.spyOn(repoUtils(), "update").mockImplementation(async (obj: any, ...rest: any[]) => {
                if ("folderUid" in obj || "scheduledSendAttempts" in obj) {
                    throw new Error("simulated database failure");
                }
                return realUpdate(obj, ...rest);
            });

            await job.run();

            const updated = await findMessage(message.uid);
            expect(transport().sent.length).toBe(1);
            expect(updated.flags.flagged).toBe(true);
            expect(updated.scheduledSendRelayedAt).toBeTruthy();
        });

        it("Stops retrying the relayed marker once a concurrent writer already stamped it.", async () => {
            const message = await createMessage({ bodyBlobKey: await putBody(), scheduledSendTime: past() });
            const concurrentStamp = new Date("2030-01-01T00:00:00.000Z");
            const realSend = transport().send.bind(transport());
            vi.spyOn(transport(), "send").mockImplementationOnce(async (outbound: any) => {
                // Another writer records the relay while the message is on the wire - the claim's version is now stale.
                const current = await repoUtils().findOne(message.uid, { ignoreACL: true });
                await repoUtils().update({ uid: current.uid, version: current.version, scheduledSendRelayedAt: concurrentStamp }, current, { ignoreACL: true });
                return realSend(outbound);
            });
            const realUpdate = repoUtils().update.bind(repoUtils());
            const markerAttempts: Date[] = [];
            vi.spyOn(repoUtils(), "update").mockImplementation(async (obj: any, ...rest: any[]) => {
                if (obj.scheduledSendRelayedAt && obj.scheduledSendRelayedAt !== concurrentStamp) {
                    markerAttempts.push(obj.scheduledSendRelayedAt);
                }
                return realUpdate(obj, ...rest);
            });

            await job.run();

            expect(transport().sent.length).toBe(1);
            // One stale attempt (a version conflict), then the re-read finds the marker and stops.
            expect(markerAttempts).toHaveLength(1);
            // Filed as usual - the filing clears the marker along with the claim.
            const filed = await findMessage(message.uid);
            expect(filed.folderUid).not.toBe(outboxUid);
            expect(filed.scheduledSendRelayedAt).toBeFalsy();
        });

        it("Refuses (without relaying or retrying) a message with no To, Cc or Bcc recipient.", async () => {
            for (const recipients of [[], [{ address: "", type: RecipientType.BCC }]]) {
                const message = await createMessage({ recipients, bodyBlobKey: await putBody(), scheduledSendTime: past() });
                await job.run();
                const updated = await findMessage(message.uid);
                expect(updated.scheduledSendError).toContain("recipients");
                expect(updated.scheduledSendTime).toBeFalsy();
                expect(updated.scheduledSendAttempts).toBeFalsy();
                expect(updated.folderUid).toBe(outboxUid);
            }
            expect(transport().sent.length).toBe(0);
        });
    });
    describe("Round 6 (part A): relay marker on a message deleted mid-relay", () => {
        const repoUtils = (): any => (job as any).messageRepo;

        it("Still stamps the relayed marker when the message was soft-deleted while on the wire.", async () => {
            const message = await createMessage({ bodyBlobKey: await putBody(), scheduledSendTime: new Date(Date.now() - 60 * 1000) });
            const realSend = transport().send.bind(transport());
            vi.spyOn(transport(), "send").mockImplementationOnce(async (outbound: any) => {
                await repoUtils().delete(message.uid, { ignoreACL: true });
                return realSend(outbound);
            });

            await job.run();

            expect(transport().sent.length).toBe(1);
            const after: any = await findMessage(message.uid);
            expect(after.deleted).toBe(true);
            expect(after.scheduledSendRelayedAt).toBeTruthy();
        });
    });
    it("runs one relay at a time on a single-connection SQLite driver, and as many as `concurrency` says on any other", () => {
        const original = (job as any).appConfig;
        try {
            expect((job as any).maxParallel()).toBe(1);
            (job as any).appConfig = { get: () => "mysql" };
            expect((job as any).maxParallel()).toBe(Math.max(1, Number((job as any).concurrency)));
            (job as any).appConfig = undefined;
            expect((job as any).maxParallel()).toBe(Math.max(1, Number((job as any).concurrency)));
        } finally {
            (job as any).appConfig = original;
        }
    });

    backgroundSendSuite({
        job: () => job,
        transport,
        mailboxUid: () => mailboxUid,
        outboxUid: () => outboxUid,
        putBody,
        createMessage,
        findMessage,
        findFolder,
        inboxNotices,
        updateMessage: messageRepoUpdate,
        repo: () => (job as any).messageRepo,
        parallel: 1,
    });
});
