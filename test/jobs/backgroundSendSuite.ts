///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// What `ScheduledSendJob` does for a background send - `enqueue()`, the `send-*` events, permanent failures, a bounded
// pool, and a crash at each step - identical on both backends. `ScheduledSendJob{Mongo,SQL}.test.ts` call this from inside
// their own `describe`, after their `beforeEach` has created the mailbox and its Outbox.
import { NotificationUtils } from "@rapidrest/service-core";
import { FolderType, RecipientType } from "../../src/models/types.js";
import type { RecordingMailTransport } from "../testDoubles.js";

export interface BackgroundSendSuiteContext {
    job: () => any;
    transport: () => RecordingMailTransport;
    mailboxUid: () => string;
    outboxUid: () => string;
    putBody: (raw?: string) => Promise<string>;
    createMessage: (data?: any) => Promise<any>;
    findMessage: (uid: string) => Promise<any>;
    findFolder: (type: FolderType) => Promise<any>;
    inboxNotices: () => Promise<any[]>;
    /** Applies a partial update straight to the row, as another process would. */
    updateMessage: (uid: string, fields: any) => Promise<void>;
    /** Makes every message's `update()` through the job's repository fail from now on, as a process that died would. */
    repo: () => any;
    /** How many relays the backend can really run at once (a single-connection SQLite runs one). */
    parallel: number;
}

/** A message `enqueue()` may relay: due now, in the Outbox, as `POST /send { background: true }` leaves it. */
const DUE = (): Date => new Date(Date.now() - 1000);

export function backgroundSendSuite(ctx: BackgroundSendSuiteContext): void {
    let events: { uids: string[]; type: string; action: string; data: any }[];
    let sendMessage: any;
    const sendEvents = (action?: string) => events.filter((event) => /^send-/.test(event.action) && (!action || event.action === action));

    beforeEach(() => {
        events = [];
        sendMessage = vi.spyOn(NotificationUtils.prototype, "sendMessage").mockImplementation((uids: any, type: any, action: any, data: any) => {
            events.push({ uids: Array.isArray(uids) ? uids : [uids], type, action, data });
        });
        ctx.transport().gate = undefined;
        ctx.transport().inFlight = 0;
        ctx.transport().maxInFlight = 0;
    });
    afterEach(() => {
        sendMessage.mockRestore();
        ctx.transport().gate = undefined;
    });

    const dueMessage = async (data: any = {}) => await ctx.createMessage({ bodyBlobKey: await ctx.putBody(), scheduledSendTime: DUE(), ...data });

    describe("background send: enqueue()", () => {
        it("relays a due message at once - no scheduled run needed - files it in Sent Items and publishes send-succeeded", async () => {
            const message = await dueMessage({ subject: "Lunch?" });

            await ctx.job().enqueue(message.uid);

            expect(ctx.transport().sent).toHaveLength(1);
            const filed = await ctx.findMessage(message.uid);
            const sent = await ctx.findFolder(FolderType.SENT_ITEMS);
            expect(filed.folderUid).toBe(sent.uid);
            expect(filed.scheduledSendTime).toBeFalsy();
            expect(filed.scheduledSendRelayedAt).toBeFalsy();
            expect(filed.scheduledSendLeaseExpiresAt).toBeFalsy();
            expect(filed.flags.read).toBe(true);

            const [event, ...others] = sendEvents();
            expect(others).toEqual([]);
            expect(event.action).toBe("send-succeeded");
            expect(event.type).toBe(ctx.job().messageClass.name);
            expect(new Set(event.uids)).toEqual(new Set([ctx.mailboxUid(), ctx.outboxUid(), sent.uid]));
            expect(event.uids).toHaveLength(3);
            expect(event.data).toEqual({
                uid: message.uid,
                mailboxUid: ctx.mailboxUid(),
                subject: "Lunch?",
                recipients: ["recipient@example.com"],
                attempt: 1,
            });
        });

        it("leaves a message that is not due alone: one held for later, one with no time (cancelled), one already filed, one that is gone", async () => {
            const later = await dueMessage({ scheduledSendTime: new Date(Date.now() + 3_600_000) });
            const cancelled = await dueMessage({ scheduledSendTime: null });

            await ctx.job().enqueue(later.uid);
            await ctx.job().enqueue(cancelled.uid);
            await ctx.job().enqueue("no-such-message");

            expect(ctx.transport().sent).toEqual([]);
            expect((await ctx.findMessage(later.uid)).folderUid).toBe(ctx.outboxUid());
            expect((await ctx.findMessage(cancelled.uid)).scheduledSendError ?? null).toBeNull();
            expect(sendEvents()).toEqual([]);
        });

        it("relays a message once however many times it is started at once, by kicks or by a scheduled run", async () => {
            const message = await dueMessage();

            await Promise.all([ctx.job().enqueue(message.uid), ctx.job().enqueue(message.uid), ctx.job().run(), ctx.job().enqueue(message.uid)]);
            await ctx.job().run();

            expect(ctx.transport().sent).toHaveLength(1);
            expect(sendEvents("send-succeeded")).toHaveLength(1);
        });

        it("does not relay twice when another process claims the message first: the loser's claim fails and it sends nothing", async () => {
            const message = await dueMessage();
            // Another process (or a scheduled run in another replica) leased it a moment before this one's claim.
            const repo = ctx.repo();
            const realUpdate = repo.update.bind(repo);
            const conflict = vi.spyOn(repo, "update").mockImplementationOnce(async (...args: any[]) => {
                const [patch, existing, options] = args;
                const leased = new Date(Date.now() + 60_000);
                await realUpdate({ ...patch, scheduledSendTime: leased, scheduledSendLeaseExpiresAt: leased }, existing, options);
                return await realUpdate(...args);
            });

            await ctx.job().enqueue(message.uid);
            conflict.mockRestore();

            expect(ctx.transport().sent).toEqual([]);
            expect(sendEvents()).toEqual([]);
        });

        it("runs a bounded number of relays at a time and still relays every message", async () => {
            const job = ctx.job();
            const saved = job.concurrency;
            job.concurrency = 2;
            let release!: () => void;
            ctx.transport().gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            try {
                const messages = [];
                for (let i = 0; i < 5; i++) {
                    messages.push(await dueMessage({ subject: `Message ${i}` }));
                }

                const done = messages.map((message) => job.enqueue(message.uid));
                await vi.waitFor(() => expect(ctx.transport().inFlight).toBe(ctx.parallel));
                await new Promise((resolve) => setTimeout(resolve, 50));
                expect(ctx.transport().inFlight).toBe(ctx.parallel);
                release();
                await Promise.all(done);

                expect(ctx.transport().sent).toHaveLength(5);
                expect(ctx.transport().maxInFlight).toBe(ctx.parallel);
                expect(sendEvents("send-succeeded")).toHaveLength(5);
                await job.whenIdle();
            } finally {
                job.concurrency = saved;
            }
        });

        it("answers at once: enqueue() returns before the relay is done", async () => {
            let release!: () => void;
            ctx.transport().gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const message = await dueMessage();

            const started = Date.now();
            const done = ctx.job().enqueue(message.uid);
            expect(Date.now() - started).toBeLessThan(50);
            expect(await ctx.findMessage(message.uid)).toMatchObject({ folderUid: ctx.outboxUid() });
            release();
            await done;

            expect(ctx.transport().sent).toHaveLength(1);
        });

        it("starts nothing after stop() - the message stays due for the next process - and stop() waits for a relay in flight", async () => {
            let release!: () => void;
            ctx.transport().gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const inFlight = await dueMessage();
            const running = ctx.job().enqueue(inFlight.uid);
            await vi.waitFor(() => expect(ctx.transport().inFlight).toBe(1));

            let stopped = false;
            const stopping = ctx.job().stop().then(() => (stopped = true));
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(stopped).toBe(false);

            const late = await dueMessage();
            await ctx.job().enqueue(late.uid);
            expect(ctx.transport().inFlight).toBe(1);

            release();
            await running;
            await stopping;
            expect(stopped).toBe(true);
            expect(ctx.transport().sent).toHaveLength(1);
            expect((await ctx.findMessage(late.uid)).folderUid).toBe(ctx.outboxUid());
            expect((await ctx.findMessage(late.uid)).scheduledSendTime).toBeTruthy();

            // The next process (or start()) picks the late one up.
            await ctx.job().start();
            await ctx.job().whenIdle();
            expect(ctx.transport().sent).toHaveLength(2);
        });

        it("gives up waiting for a relay that will not finish, once drain_ms has passed", async () => {
            const job = ctx.job();
            const saved = job.drainMs;
            job.drainMs = 40;
            let release!: () => void;
            ctx.transport().gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            let running: Promise<void> | undefined;
            try {
                const message = await dueMessage();
                running = job.enqueue(message.uid);
                await vi.waitFor(() => expect(ctx.transport().inFlight).toBe(1));

                const started = Date.now();
                await job.stop();

                expect(Date.now() - started).toBeLessThan(1000);
            } finally {
                job.drainMs = saved;
                release();
                await running;
                await job.whenIdle();
                await job.start();
                await job.whenIdle();
            }
        });
    });

    describe("background send: what a failure does", () => {
        it("a temporary failure publishes send-retrying with the attempt and when the next one is, leaves the message queued in Outbox, and a later attempt succeeds", async () => {
            const message = await dueMessage({ recipients: [{ address: "temp-fail@example.com", type: RecipientType.TO }] });
            const before = Date.now();

            await ctx.job().enqueue(message.uid);

            const queued = await ctx.findMessage(message.uid);
            expect(queued.folderUid).toBe(ctx.outboxUid());
            expect(queued.scheduledSendAttempts).toBe(1);
            expect(queued.scheduledSendError).toContain("Temporary local problem");
            expect(queued.scheduledSendLeaseExpiresAt).toBeFalsy();
            expect(new Date(queued.scheduledSendTime).getTime()).toBeGreaterThanOrEqual(before + 60_000);
            expect(ctx.transport().sent).toEqual([]);
            expect(await ctx.inboxNotices()).toEqual([]);

            const [event, ...others] = sendEvents();
            expect(others).toEqual([]);
            expect(event.action).toBe("send-retrying");
            expect(event.uids).toEqual([ctx.mailboxUid(), ctx.outboxUid()]);
            expect(event.data).toMatchObject({ uid: message.uid, mailboxUid: ctx.mailboxUid(), subject: "Scheduled message", recipients: ["temp-fail@example.com"], attempt: 1 });
            expect(Math.abs(Date.parse(event.data.nextAttemptAt) - new Date(queued.scheduledSendTime).getTime())).toBeLessThan(1000);
            expect(event.data.error.message).toContain("Temporary local problem");
            expect(event.data.error.details).toMatchObject({ transport: "recording", failures: [{ address: "temp-fail@example.com", code: 451, temporary: true }] });

            // The backoff passes and the mail system takes it: the second attempt files it.
            await ctx.updateMessage(message.uid, { scheduledSendTime: DUE(), recipients: [{ address: "recipient@example.com", type: RecipientType.TO }] });
            events.length = 0;
            await ctx.job().run();

            expect(ctx.transport().sent).toHaveLength(1);
            const filed = await ctx.findMessage(message.uid);
            expect(filed.folderUid).not.toBe(ctx.outboxUid());
            expect(filed.scheduledSendAttempts ?? null).toBeNull();
            expect(filed.scheduledSendError ?? null).toBeNull();
            expect(sendEvents().map((event) => [event.action, event.data.attempt])).toEqual([["send-succeeded", 2]]);
        });

        it("a failure that will not pass (every recipient refused with a 5xx) is final at once: send-failed, no retry, one notice, the message stays in Outbox marked failed", async () => {
            const message = await dueMessage({ recipients: [{ address: "reject@example.com", type: RecipientType.TO }] });

            await ctx.job().enqueue(message.uid);
            await ctx.job().run();

            const failed = await ctx.findMessage(message.uid);
            expect(failed.folderUid).toBe(ctx.outboxUid());
            expect(failed.scheduledSendTime).toBeFalsy();
            expect(failed.scheduledSendLeaseExpiresAt).toBeFalsy();
            expect(failed.scheduledSendError).toContain("Recipient address rejected");
            expect(failed.scheduledSendError).not.toContain("Gave up");
            expect(ctx.transport().sent).toEqual([]);

            const [event, ...others] = sendEvents();
            expect(others).toEqual([]);
            expect(event.action).toBe("send-failed");
            expect(event.uids).toEqual([ctx.mailboxUid(), ctx.outboxUid()]);
            expect(event.data).toMatchObject({ uid: message.uid, recipients: ["reject@example.com"], attempt: 1 });
            expect(event.data.nextAttemptAt).toBeUndefined();
            expect(event.data.error.message).toContain("554 5.7.1");
            expect(event.data.error.details.failures[0]).toMatchObject({ address: "reject@example.com", code: 554, enhancedCode: "5.7.1", temporary: false });

            const notices = await ctx.inboxNotices();
            expect(notices).toHaveLength(1);
            expect(notices[0].subject).toBe("Undeliverable: Scheduled message");
        });

        it("a message that fails spam or malware scanning is final at once too", async () => {
            const message = await dueMessage({
                bodyBlobKey: await ctx.putBody("From: owner@example.com\r\nTo: recipient@example.com\r\nX-Test-Force-Spam: true\r\nSubject: Buy\r\n\r\nHi\r\n"),
            });

            await ctx.job().enqueue(message.uid);

            const failed = await ctx.findMessage(message.uid);
            expect(failed.scheduledSendTime).toBeFalsy();
            expect(failed.scheduledSendError).toContain("failed spam/malware scanning");
            expect(sendEvents().map((event) => event.action)).toEqual(["send-failed"]);
            expect(ctx.transport().sent).toEqual([]);
        });

        it("keeps trying an unexplained failure up to max_attempts, then gives up: send-retrying each time, send-failed at the end, one notice", async () => {
            const job = ctx.job();
            const saved = job.maxAttempts;
            job.maxAttempts = 3;
            try {
                // No body blob: reading it fails, which says nothing about whether trying again would help.
                const message = await ctx.createMessage({ bodyBlobKey: "bodies/missing", scheduledSendTime: DUE() });
                for (let attempt = 1; attempt <= 3; attempt++) {
                    await job.enqueue(message.uid);
                    if (attempt < 3) {
                        await ctx.updateMessage(message.uid, { scheduledSendTime: DUE() });
                    }
                }

                expect(sendEvents().map((event) => [event.action, event.data.attempt])).toEqual([
                    ["send-retrying", 1],
                    ["send-retrying", 2],
                    ["send-failed", 3],
                ]);
                const failed = await ctx.findMessage(message.uid);
                expect(failed.scheduledSendTime).toBeFalsy();
                expect(failed.scheduledSendError).toContain("Gave up after 3 attempts");
                expect(sendEvents("send-failed")[0].data.error.message).toContain("Gave up after 3 attempts");
                expect(await ctx.inboxNotices()).toHaveLength(1);
            } finally {
                job.maxAttempts = saved;
            }
        });

        it("publishes send-failed for a message it refuses (here, one that is not from its mailbox's own address)", async () => {
            const message = await dueMessage({ from: { address: "someone-else@example.com", type: RecipientType.TO } });

            await ctx.job().enqueue(message.uid);

            expect(ctx.transport().sent).toEqual([]);
            const [event] = sendEvents();
            expect(event.action).toBe("send-failed");
            expect(event.data.error.message).toContain("From address");
            expect(event.data.attempt).toBe(1);
        });

        it("says the message was sent, and that only its filing failed, when the mail system took it but Sent Items could not be written: send-retrying, and it is not relayed again", async () => {
            const message = await dueMessage();
            const repo = ctx.repo();
            const realFindOne = repo.findOne.bind(repo);
            // The filing re-reads the row: fail exactly that read once.
            const failing = vi.spyOn(repo, "findOne").mockImplementation(async (...args: any[]) => {
                if (ctx.transport().sent.length > 0) {
                    failing.mockImplementation(realFindOne);
                    throw new Error("simulated filing failure");
                }
                return await realFindOne(...args);
            });

            await ctx.job().enqueue(message.uid);
            failing.mockRestore();

            expect(ctx.transport().sent).toHaveLength(1);
            const [event] = sendEvents();
            expect(event.action).toBe("send-retrying");
            expect(event.data.error.message).toBe("The message was sent, but could not be filed in Sent Items: simulated filing failure");
            expect((await ctx.findMessage(message.uid)).scheduledSendRelayedAt).toBeTruthy();

            await ctx.updateMessage(message.uid, { scheduledSendTime: DUE() });
            await ctx.job().run();

            expect(ctx.transport().sent).toHaveLength(1);
            expect(sendEvents().map((sent) => sent.action)).toEqual(["send-retrying", "send-succeeded"]);
            expect((await ctx.findMessage(message.uid)).folderUid).not.toBe(ctx.outboxUid());
        });
    });

    describe("background send: the startup sweep", () => {
        it("logs a sweep that fails and carries on - a failed run never stops the job from starting", async () => {
            const job = ctx.job();
            const warn = vi.spyOn(job.logger, "warn");
            const run = vi.spyOn(job, "run").mockRejectedValueOnce(new Error("the datastore is not up yet"));

            await job.start();
            await job.whenIdle();

            expect(warn).toHaveBeenCalledWith(expect.stringContaining("the startup sweep failed: the datastore is not up yet"));
            run.mockRestore();
            warn.mockRestore();
        });
    });

    describe("background send: a crash at every step never sends twice", () => {
        it("before anything happened: the message is simply due in Outbox, and the next run sends it once", async () => {
            const message = await dueMessage();

            // (the process died before enqueue() ran) - a new process's startup sweep finds it
            await ctx.job().start();
            await ctx.job().whenIdle();

            expect(ctx.transport().sent).toHaveLength(1);
            expect((await ctx.findMessage(message.uid)).folderUid).not.toBe(ctx.outboxUid());
        });

        it("after the claim but before the relay: the lease lapses and the next run sends it once", async () => {
            const message = await dueMessage();
            const repo = ctx.repo();
            const realUpdate = repo.update.bind(repo);
            let claims = 0;
            // The claim lands, then the process dies: every later write fails, so nothing is relayed or recorded.
            const dying = vi.spyOn(repo, "update").mockImplementation(async (...args: any[]) => {
                if (claims++ === 0) {
                    return await realUpdate(...args);
                }
                throw new Error("the process died");
            });
            const blobGet = vi.spyOn(ctx.job().blobStore, "get").mockRejectedValue(new Error("the process died"));

            await ctx.job().enqueue(message.uid);
            dying.mockRestore();
            blobGet.mockRestore();

            const stuck = await ctx.findMessage(message.uid);
            expect(stuck.folderUid).toBe(ctx.outboxUid());
            expect(stuck.scheduledSendLeaseExpiresAt).toBeTruthy();
            expect(ctx.transport().sent).toEqual([]);
            // Still leased: a run right now leaves it alone (nothing is due).
            await ctx.job().run();
            expect(ctx.transport().sent).toEqual([]);

            await ctx.updateMessage(message.uid, { scheduledSendTime: DUE() });
            await ctx.job().run();

            expect(ctx.transport().sent).toHaveLength(1);
            expect((await ctx.findMessage(message.uid)).folderUid).not.toBe(ctx.outboxUid());
        });

        it("after the relay but before the filing: the message is marked relayed and due, and the next run only files it - it is never relayed again", async () => {
            const message = await dueMessage();
            const repo = ctx.repo();
            const realUpdate = repo.update.bind(repo);
            let writes = 0;
            // The claim and the relayed marker land; then the process dies: no filing, no failure bookkeeping.
            const dying = vi.spyOn(repo, "update").mockImplementation(async (...args: any[]) => {
                if (writes++ < 2) {
                    return await realUpdate(...args);
                }
                throw new Error("the process died");
            });

            await ctx.job().enqueue(message.uid);
            dying.mockRestore();

            expect(ctx.transport().sent).toHaveLength(1);
            const stuck = await ctx.findMessage(message.uid);
            expect(stuck.folderUid).toBe(ctx.outboxUid());
            expect(stuck.scheduledSendRelayedAt).toBeTruthy();
            expect(sendEvents()).toEqual([]);

            // The lease lapses; a new process's startup sweep (or the next run) finishes the filing.
            await ctx.updateMessage(message.uid, { scheduledSendTime: DUE() });
            await ctx.job().start();
            await ctx.job().whenIdle();

            expect(ctx.transport().sent).toHaveLength(1);
            const filed = await ctx.findMessage(message.uid);
            expect(filed.folderUid).not.toBe(ctx.outboxUid());
            expect(filed.scheduledSendRelayedAt).toBeFalsy();
            expect(sendEvents().map((event) => event.action)).toEqual(["send-succeeded"]);
        });
    });

    describe("what an immediate send adds is added to a background send too", () => {
        it("requests a receipt and files the tracking rows, and keeps the reply's threading, when the message asks for one", async () => {
            const message = await dueMessage({
                requestReceipt: true,
                bodyBlobKey: await ctx.putBody("From: owner@example.com\r\nTo: recipient@example.com\r\nSubject: Hi\r\nIn-Reply-To: <parent@example.com>\r\nReferences: <root@example.com> <parent@example.com>\r\n\r\nHello there.\r\n"),
            });

            await ctx.job().enqueue(message.uid);

            expect(ctx.transport().sent).toHaveLength(1);
            expect(ctx.transport().sent[0].raw.toString()).toContain("Disposition-Notification-To: owner@example.com");
            const filed = await ctx.findMessage(message.uid);
            expect(filed.receiptStatus).toEqual([{ recipientAddress: "recipient@example.com" }]);
            expect(filed.inReplyTo).toBe("parent@example.com");
            expect(filed.references).toEqual(["root@example.com", "parent@example.com"]);
            expect(filed.encrypted).toBe(false);
        });
    });
}
