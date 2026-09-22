///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `POST /messages/:id/send` with `{ background: true }` over a real HTTP server, identical on both backends: it answers 202
// while the relay is still waiting for the mail system, the message is in Outbox at once, the result arrives as an event, and
// a crash, a repeat or a burst never sends anything twice. `test/routes/{mongo,sql}/MessageBackgroundSend.test.ts` supply the
// server; the relay itself is the `ScheduledSendJob` the route starts in this process (its own behaviour is
// `test/jobs/backgroundSendSuite.ts`).
import { request } from "@rapidrest/service-core/test";
import { NotificationUtils } from "@rapidrest/service-core";
import { FolderType, RecipientType } from "../../src/models/types.js";
import { ScheduledSendJob } from "../../src/jobs/ScheduledSendJob.js";
import type { InMemoryBlobStore, RecordingMailTransport } from "../testDoubles.js";

export interface BackgroundSendRouteSuiteContext {
    app: () => any;
    baseUrl: string;
    foldersUrl: string;
    ownerToken: string;
    ownerUid: string;
    blobStore: () => InMemoryBlobStore;
    transport: () => RecordingMailTransport;
    /** The `ScheduledSendJob` the route started (`undefined` before the first background send). */
    job: () => ScheduledSendJob<any> | undefined;
    createMailbox: (ownerUid: string) => Promise<any>;
    createFolder: (mailboxUid: string, type: FolderType) => Promise<any>;
    createMessage: (mailboxUid: string, folderUid: string, data?: any) => Promise<any>;
    messagesIn: (mailboxUid: string, type: FolderType) => Promise<any[]>;
    findMessage: (uid: string) => Promise<any>;
    findFolder: (mailboxUid: string, type: FolderType) => Promise<any | undefined>;
    updateMessage: (uid: string, fields: any) => Promise<void>;
    /** Whether the datastore takes overlapping requests (a single-connection SQLite cannot start two transactions at once). */
    concurrentRequests: boolean;
}

export function backgroundSendRouteSuite(ctx: BackgroundSendRouteSuiteContext): void {
    const auth = (chain: any) => chain.set("Authorization", "jwt " + ctx.ownerToken);
    const post = (uid: string, body: any = { background: true }) => auth(request(ctx.app()).post(`${ctx.baseUrl}/${uid}/send`)).send(body);

    let mailbox: any;
    let drafts: any;
    let events: { uids: string[]; type: string; action: string; data: any }[];
    let sendMessage: any;
    const sendEvents = (action?: string) => events.filter((event) => /^send-/.test(event.action) && (!action || event.action === action));
    let release: (() => void) | undefined;
    const hold = () => {
        ctx.transport().gate = new Promise<void>((resolve) => {
            release = resolve;
        });
    };
    const letGo = () => {
        release?.();
        release = undefined;
        ctx.transport().gate = undefined;
    };
    const wait = { timeout: 5000, interval: 20 };

    beforeEach(async () => {
        events = [];
        sendMessage = vi.spyOn(NotificationUtils.prototype, "sendMessage").mockImplementation((uids: any, type: any, action: any, data: any) => {
            events.push({ uids: Array.isArray(uids) ? uids : [uids], type, action, data });
        });
        ctx.transport().sent = [];
        ctx.transport().inFlight = 0;
        ctx.transport().maxInFlight = 0;
        mailbox = await ctx.createMailbox(ctx.ownerUid);
        drafts = await ctx.createFolder(mailbox.uid, FolderType.DRAFTS);
    });
    afterEach(async () => {
        letGo();
        await ctx.job()?.whenIdle();
        sendMessage.mockRestore();
        vi.restoreAllMocks();
    });

    const draft = async (recipients: string[] = ["recipient@example.com"], data: any = {}) => {
        const bodyBlobKey = `bodies/${Math.random().toString(16).slice(2)}`;
        await ctx.blobStore().put(bodyBlobKey, Buffer.from(`From: owner@example.com\r\nTo: ${recipients.join(", ")}\r\nSubject: Q3 plan\r\n\r\nHello there.\r\n`));
        return await ctx.createMessage(mailbox.uid, drafts.uid, {
            bodyBlobKey,
            subject: "Q3 plan",
            recipients: recipients.map((address) => ({ address, type: RecipientType.TO })),
            ...data,
        });
    };
    const inSentItems = async (uid: string): Promise<void> => {
        await vi.waitFor(async () => {
            const sent = await ctx.findFolder(mailbox.uid, FolderType.SENT_ITEMS);
            expect((await ctx.findMessage(uid)).folderUid).toBe(sent?.uid);
        }, wait);
    };
    const folderCounts = async (type: FolderType) => {
        const listed = await auth(request(ctx.app()).get(`${ctx.foldersUrl}?mailboxUid=${mailbox.uid}`));
        const folder = listed.body.find((entry: any) => entry.type === type);
        return folder ? { total: folder.totalCount, unread: folder.unreadCount } : undefined;
    };

    describe("answering at once", () => {
        it("answers 202 { status: 'queued', message } with the message in Outbox while the relay is still waiting for the mail system", async () => {
            hold();
            const message = await draft();

            const started = performance.now();
            const result = await post(message.uid);
            const elapsed = performance.now() - started;

            expect(result.status).toBe(202);
            expect(result.body.status).toBe("queued");
            expect(result.body.message).toMatchObject({ uid: message.uid, mailboxUid: mailbox.uid, subject: "Q3 plan" });
            const outbox = await ctx.findFolder(mailbox.uid, FolderType.OUTBOX);
            expect(result.body.message.folderUid).toBe(outbox!.uid);
            expect(new Date(result.body.message.scheduledSendTime).getTime()).toBeLessThanOrEqual(Date.now());
            expect(result.body.message.scheduledSendLeaseExpiresAt ?? null).toBeNull();
            expect(elapsed).toBeLessThan(1500);
            console.info(`R1_METRIC background send answered 202 in ${elapsed.toFixed(1)} ms while the transport was held`);

            // The relay has been started (it is waiting inside the transport) but the request did not wait for it.
            await vi.waitFor(() => expect(ctx.transport().inFlight).toBe(1), wait);
            expect(ctx.transport().sent).toEqual([]);
            expect((await ctx.findMessage(message.uid)).folderUid).toBe(outbox!.uid);
        });

        it("has the message in Outbox the moment it answers - the folder lists it as queued - and moves it to Sent Items when it is done", async () => {
            hold();
            const message = await draft();
            await auth(request(ctx.app()).get(`${ctx.foldersUrl}?mailboxUid=${mailbox.uid}`));

            await post(message.uid);

            expect(await folderCounts(FolderType.OUTBOX)).toEqual({ total: 1, unread: 1 });
            expect(await folderCounts(FolderType.DRAFTS)).toEqual({ total: 0, unread: 0 });
            const queued = await ctx.findMessage(message.uid);
            expect(queued.scheduledSendTime).toBeTruthy();
            expect(queued.scheduledSendError ?? null).toBeNull();
            expect(queued.scheduledSendAttempts ?? null).toBeNull();

            letGo();
            await inSentItems(message.uid);
            await vi.waitFor(async () => expect(await folderCounts(FolderType.OUTBOX)).toEqual({ total: 0, unread: 0 }), wait);
            expect(await folderCounts(FolderType.SENT_ITEMS)).toEqual({ total: 1, unread: 0 });
            expect(ctx.transport().sent).toHaveLength(1);
        });

        it("publishes send-succeeded on the mailbox, Outbox and Sent Items channels once the mail system has taken it", async () => {
            const message = await draft(["recipient@example.com", "other@example.com"]);

            const result = await post(message.uid);
            await inSentItems(message.uid);

            expect(result.status).toBe(202);
            await vi.waitFor(() => expect(sendEvents()).toHaveLength(1), wait);
            const [event] = sendEvents();
            const sent = await ctx.findFolder(mailbox.uid, FolderType.SENT_ITEMS);
            const outbox = await ctx.findFolder(mailbox.uid, FolderType.OUTBOX);
            expect(event.action).toBe("send-succeeded");
            expect(event.type).toBe(ctx.job()!.constructor.name.replace("ScheduledSendJob", "Message"));
            expect(new Set(event.uids)).toEqual(new Set([mailbox.uid, outbox!.uid, sent!.uid]));
            expect(event.data).toEqual({
                uid: message.uid,
                mailboxUid: mailbox.uid,
                subject: "Q3 plan",
                recipients: ["recipient@example.com", "other@example.com"],
                attempt: 1,
            });
            expect(ctx.transport().sent.map((entry) => entry.envelopeTo)).toEqual([["recipient@example.com", "other@example.com"]]);
        });

        it("measures how long a background send takes to answer, against a send that waits for the whole relay", async () => {
            const samples = 15;
            const background: number[] = [];
            const inline: number[] = [];
            for (let i = 0; i < samples; i++) {
                const message = await draft();
                const started = performance.now();
                expect((await post(message.uid)).status).toBe(202);
                background.push(performance.now() - started);
            }
            await vi.waitFor(() => expect(ctx.transport().sent).toHaveLength(samples), wait);
            for (let i = 0; i < samples; i++) {
                const message = await draft();
                const started = performance.now();
                expect((await post(message.uid, {})).status).toBe(200);
                inline.push(performance.now() - started);
            }
            const stats = (values: number[]) => {
                const sorted = [...values].sort((a, b) => a - b);
                return `median ${sorted[Math.floor(sorted.length / 2)].toFixed(1)} ms, p95 ${sorted[Math.floor(sorted.length * 0.95)].toFixed(1)} ms, max ${sorted[sorted.length - 1].toFixed(1)} ms`;
            };
            console.info(`R1_METRIC background send (${samples}x): ${stats(background)}`);
            console.info(`R1_METRIC send that waits for the relay (${samples}x): ${stats(inline)}`);
            expect(Math.max(...background)).toBeLessThan(1500);
        });
    });

    describe("what is checked before it answers", () => {
        it("refuses a draft with no recipients (400), one from another address (403), one already sent (409) and one that is not a draft (403) - none of them queued", async () => {
            const noRecipients = await draft([], { recipients: [] });
            const foreign = await draft(["recipient@example.com"], { from: { address: "someone-else@example.com", type: RecipientType.TO } });
            const inbox = await ctx.createFolder(mailbox.uid, FolderType.INBOX);
            const received = await ctx.createMessage(mailbox.uid, inbox.uid, { subject: "Received", recipients: [{ address: "recipient@example.com", type: RecipientType.TO }] });
            const done = await draft();
            expect((await post(done.uid)).status).toBe(202);
            await inSentItems(done.uid);

            const results = {
                noRecipients: (await post(noRecipients.uid)).status,
                foreign: (await post(foreign.uid)).status,
                received: (await post(received.uid)).status,
                already: (await post(done.uid)).status,
                missing: (await post("no-such-message")).status,
                notBoolean: (await post(done.uid, { background: "yes" })).status,
            };

            expect(results).toEqual({ noRecipients: 400, foreign: 403, received: 403, already: 409, missing: 404, notBoolean: 400 });
            expect((await ctx.findMessage(noRecipients.uid)).folderUid).toBe(drafts.uid);
            expect((await ctx.findMessage(foreign.uid)).folderUid).toBe(drafts.uid);
            expect((await ctx.findMessage(received.uid)).folderUid).toBe(inbox.uid);
            expect(ctx.transport().sent).toHaveLength(1);
        });

        it("still answers 200 when the body does not ask for a background send, and 403 to a caller who is not signed in", async () => {
            const message = await draft();

            const anonymous = await request(ctx.app()).post(`${ctx.baseUrl}/${message.uid}/send`).send({ background: true });
            const inline = await post(message.uid, {});

            expect(anonymous.status).toBe(403);
            expect(inline.status).toBe(200);
            expect(inline.body.uid).toBe(message.uid);
            expect(inline.body.status).toBeUndefined();
            expect(ctx.transport().sent).toHaveLength(1);
        });

        it("queues a send for later the same way, answering 202 without relaying it now", async () => {
            const message = await draft();
            const later = new Date(Date.now() + 3_600_000).toISOString();

            const result = await post(message.uid, { background: true, scheduledSendTime: later });

            expect(result.status).toBe(202);
            expect(new Date(result.body.message.scheduledSendTime).toISOString()).toBe(later);
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(ctx.transport().sent).toEqual([]);
            const outbox = await ctx.findFolder(mailbox.uid, FolderType.OUTBOX);
            expect((await ctx.findMessage(message.uid)).folderUid).toBe(outbox!.uid);
            // A message held for a time the user chose is not "already on its way": sending it now is refused, as it always was.
            expect((await post(message.uid)).status).toBe(409);
        });
    });

    describe("repeating a request", () => {
        it("answers the same 202 for a message already queued or being sent, and sends it once", async () => {
            hold();
            const message = await draft();

            const first = await post(message.uid);
            await vi.waitFor(() => expect(ctx.transport().inFlight).toBe(1), wait);
            const second = await post(message.uid);
            const third = await post(message.uid);
            letGo();
            await inSentItems(message.uid);

            expect([first.status, second.status, third.status]).toEqual([202, 202, 202]);
            expect(second.body.status).toBe("queued");
            expect(second.body.message.uid).toBe(message.uid);
            expect(ctx.transport().sent).toHaveLength(1);
            expect(sendEvents("send-succeeded")).toHaveLength(1);
        });

        it("sends once when two requests arrive at the same moment", async () => {
            const message = await draft();

            const results = ctx.concurrentRequests
                ? await Promise.all([post(message.uid), post(message.uid), post(message.uid)])
                : [await post(message.uid), await post(message.uid), await post(message.uid)];
            await inSentItems(message.uid);

            // Each is the same 202, or - once the first has been sent and filed - the 409 "already sent"; never a second send or an error.
            const statuses = results.map((result) => result.status);
            expect(statuses[0]).toBe(202);
            expect(statuses.every((status) => status === 202 || status === 409)).toBe(true);
            expect(ctx.transport().sent).toHaveLength(1);
        });

        it("sends a burst of different messages once each", async () => {
            const messages = [];
            for (let i = 0; i < 6; i++) {
                messages.push(await draft(["recipient@example.com"], { subject: `Message ${i}` }));
            }

            const results = ctx.concurrentRequests ? await Promise.all(messages.map((message) => post(message.uid))) : [];
            for (const message of ctx.concurrentRequests ? [] : messages) {
                results.push(await post(message.uid));
            }
            await Promise.all(messages.map((message) => inSentItems(message.uid)));

            expect(results.map((result) => result.status)).toEqual([202, 202, 202, 202, 202, 202]);
            expect(ctx.transport().sent).toHaveLength(6);
            expect(new Set(ctx.transport().sent.map((entry) => entry.raw.toString().match(/Message-ID: <([^>]+)>/)?.[1])).size).toBe(6);
            expect(sendEvents("send-succeeded")).toHaveLength(6);
        });
    });

    describe("when the mail system does not take it", () => {
        it("keeps a message that failed for now in Outbox, counting its attempts, and publishes send-retrying with when the next attempt is due", async () => {
            const message = await draft(["temp-fail@example.com"]);

            expect((await post(message.uid)).status).toBe(202);
            await vi.waitFor(() => expect(sendEvents("send-retrying")).toHaveLength(1), wait);

            const outbox = await ctx.findFolder(mailbox.uid, FolderType.OUTBOX);
            const queued = await ctx.findMessage(message.uid);
            expect(queued.folderUid).toBe(outbox!.uid);
            expect(queued.scheduledSendAttempts).toBe(1);
            expect(queued.scheduledSendError).toContain("Temporary local problem");
            expect(new Date(queued.scheduledSendTime).getTime()).toBeGreaterThan(Date.now() + 30_000);
            const [event] = sendEvents("send-retrying");
            expect(event.data.attempt).toBe(1);
            expect(Math.abs(Date.parse(event.data.nextAttemptAt) - new Date(queued.scheduledSendTime).getTime())).toBeLessThan(1000);
            expect(event.data.error.details.failures[0]).toMatchObject({ code: 451, temporary: true });
            expect(await ctx.messagesIn(mailbox.uid, FolderType.SENT_ITEMS)).toEqual([]);
            expect(await ctx.messagesIn(mailbox.uid, FolderType.INBOX)).toEqual([]);
            expect(await folderCounts(FolderType.OUTBOX)).toEqual({ total: 1, unread: 1 });

            // Asking again while it waits out the backoff is the same "already on its way" 202.
            expect((await post(message.uid)).status).toBe(202);
        });

        it("keeps a message the mail system refused for good in Outbox marked failed, publishes send-failed, files the notice once, and sends it again when asked", async () => {
            const message = await draft(["reject@example.com"]);

            expect((await post(message.uid)).status).toBe(202);
            await vi.waitFor(() => expect(sendEvents("send-failed")).toHaveLength(1), wait);

            const outbox = await ctx.findFolder(mailbox.uid, FolderType.OUTBOX);
            const failed = await ctx.findMessage(message.uid);
            expect(failed.folderUid).toBe(outbox!.uid);
            expect(failed.scheduledSendTime).toBeFalsy();
            expect(failed.scheduledSendError).toContain("Recipient address rejected");
            const [event] = sendEvents("send-failed");
            expect(event.data).toMatchObject({ uid: message.uid, attempt: 1, recipients: ["reject@example.com"] });
            expect(event.data.error.details.failures[0]).toMatchObject({ code: 554, temporary: false });
            await vi.waitFor(async () => expect(await ctx.messagesIn(mailbox.uid, FolderType.INBOX)).toHaveLength(1), wait);
            expect(ctx.transport().sent).toEqual([]);

            // The user fixes nothing and asks again: it is queued afresh (a fresh budget), fails the same way, and says so.
            const again = await post(message.uid);
            expect(again.status).toBe(202);
            expect(again.body.message.scheduledSendError ?? null).toBeNull();
            await vi.waitFor(() => expect(sendEvents("send-failed")).toHaveLength(2), wait);
            expect(sendEvents("send-failed")[1].data.attempt).toBe(1);
        });
    });

    describe("a process that dies never sends twice", () => {
        it("leaves a message queued when the process dies right after answering: it is simply due in Outbox, and the next process sends it once", async () => {
            // The kick that follows the 202 never runs (the process died first).
            const kick = vi.spyOn(ScheduledSendJob.prototype, "enqueue").mockResolvedValue(undefined);
            const message = await draft();

            const result = await post(message.uid);
            await vi.waitFor(() => expect(kick).toHaveBeenCalledWith(message.uid), wait);

            expect(result.status).toBe(202);
            const outbox = await ctx.findFolder(mailbox.uid, FolderType.OUTBOX);
            expect((await ctx.findMessage(message.uid)).folderUid).toBe(outbox!.uid);
            expect(ctx.transport().sent).toEqual([]);
            expect(await folderCounts(FolderType.OUTBOX)).toEqual({ total: 1, unread: 1 });

            // A new process starts: the job's startup sweep finds it.
            kick.mockRestore();
            await ctx.job()!.start();
            await ctx.job()!.whenIdle();

            expect(ctx.transport().sent).toHaveLength(1);
            await inSentItems(message.uid);
        });

        it("finishes the filing of a message the mail system took right before the process died, without sending it again", async () => {
            // A first send, to have the route's job.
            const first = await draft(["other@example.com"]);
            await post(first.uid);
            await inSentItems(first.uid);
            // Relayed and marked, still in Outbox, due: exactly what is left when the process dies between those two writes.
            const message = await draft(["recipient@example.com"]);
            const outbox = await ctx.findFolder(mailbox.uid, FolderType.OUTBOX);
            await ctx.updateMessage(message.uid, { folderUid: outbox!.uid, scheduledSendTime: new Date(Date.now() - 1000), scheduledSendRelayedAt: new Date() });

            // Asking again is refused: it was sent.
            expect((await post(message.uid)).status).toBe(409);
            // The next process's startup sweep only files it.
            await ctx.job()!.start();
            await ctx.job()!.whenIdle();

            await inSentItems(message.uid);
            expect(ctx.transport().sent.map((entry) => entry.envelopeTo)).toEqual([["other@example.com"]]);
            expect(sendEvents("send-succeeded").map((event) => event.data.uid)).toEqual([first.uid, message.uid]);
            expect((await ctx.findMessage(message.uid)).scheduledSendRelayedAt).toBeFalsy();
        });
    });
}
