///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// A folder's `unreadCount`/`totalCount` are derived from its messages, never trusted from storage, and change as the
// messages do - identical on both backends. `test/routes/{mongo,sql}/FolderCounts.test.ts` supply a started server with the
// `RecordingMailTransport` test double, and raw row access. Every case goes through real HTTP against a real database:
// the point is that the *database's* grouped query agrees with what the message list shows and with what each write left.
import { request } from "@rapidrest/service-core/test";
import { NotificationUtils } from "@rapidrest/service-core";
import * as uuid from "uuid";
import { FolderType } from "../../src/models/types.js";
import type { InMemoryBlobStore } from "../testDoubles.js";

export interface FolderCountsSuiteContext {
    app: () => any;
    messagesUrl: string;
    foldersUrl: string;
    ownerToken: string;
    ownerUid: string;
    blobStore: () => InMemoryBlobStore;
    /** A mailbox owned by `ownerUid` (alias `owner@example.com`), with a full-access ACL for it. */
    createMailbox: (ownerUid: string) => Promise<any>;
    /** A folder of `type`, its stored (cached) counters set to `stored` - defaulting to zero. */
    createFolder: (mailboxUid: string, type: FolderType, stored?: { unreadCount: number; totalCount: number }) => Promise<any>;
    createMessage: (mailboxUid: string, folderUid: string, data?: any) => Promise<any>;
    findFolder: (uid: string) => Promise<any>;
    findMessage: (uid: string) => Promise<any>;
    /** Puts a soft-deleted message back the way a restore would (this library has no restore route). */
    restoreMessage: (uid: string) => Promise<void>;
    /** Runs `work`, counting the grouped count queries it made against the message table. */
    countGroupedQueries: <R>(work: () => Promise<R>) => Promise<{ result: R; queries: number }>;
}

/** The `data` of the event `refreshFolderCounts()` publishes. */
interface CountsEvent {
    channels: string[];
    type: string;
    data: { uid: string; mailboxUid: string; unreadCount: number; totalCount: number };
}

const READ = { read: true, flagged: false, answered: false, forwarded: false };
const UNREAD = { read: false, flagged: false, answered: false, forwarded: false };

export function folderCountsSuite(ctx: FolderCountsSuiteContext): void {
    const auth = (req: any) => req.set("Authorization", "jwt " + ctx.ownerToken);
    const listFolders = (mailboxUid: string, query: string = "") => auth(request(ctx.app()).get(`${ctx.foldersUrl}?mailboxUid=${mailboxUid}${query}`));
    const getFolder = (uid: string) => auth(request(ctx.app()).get(`${ctx.foldersUrl}/${uid}`));
    const putMessage = (uid: string, body: any) => auth(request(ctx.app()).put(`${ctx.messagesUrl}/${uid}`)).send({ uid, ...body });
    const counts = (folder: any) => ({ unreadCount: folder.unreadCount, totalCount: folder.totalCount });

    /** Publishes captured for the count events (and only them: the folder record's own `update` events, and the message ones,
     * carry other shapes). */
    let spy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        spy = vi.spyOn(NotificationUtils.prototype, "sendMessage");
    });
    afterEach(() => {
        spy.mockRestore();
    });
    const countEvents = (): CountsEvent[] =>
        spy.mock.calls
            .map(([channels, type, action, data]: any[]) => ({ channels: ([] as string[]).concat(channels), type, action, data }))
            .filter(
                (call) =>
                    /^Folder/.test(call.type) &&
                    call.action === "update" &&
                    Object.keys(call.data ?? {}).sort().join() === "mailboxUid,totalCount,uid,unreadCount",
            )
            .map(({ channels, type, data }) => ({ channels, type, data }));
    const eventsFor = (folderUid: string): CountsEvent[] => countEvents().filter((event) => event.data.uid === folderUid);

    /** Inbox 2 unread of 3 (a read one, an explicitly unread one and one with no `read` flag at all), one soft-deleted unread
     * one that isn't counted; Sent Items 7 read; Deleted Items 4, two unread - each folder's *stored* counters wrong. */
    const seedMailbox = async () => {
        const mailbox = await ctx.createMailbox(ctx.ownerUid);
        const inbox = await ctx.createFolder(mailbox.uid, FolderType.INBOX, { unreadCount: 7, totalCount: 7 });
        const sent = await ctx.createFolder(mailbox.uid, FolderType.SENT_ITEMS, { unreadCount: 0, totalCount: 0 });
        const deleted = await ctx.createFolder(mailbox.uid, FolderType.DELETED_ITEMS, { unreadCount: 0, totalCount: 0 });
        const inboxMessages = [
            await ctx.createMessage(mailbox.uid, inbox.uid, { subject: "read", flags: READ }),
            await ctx.createMessage(mailbox.uid, inbox.uid, { subject: "unread", flags: UNREAD }),
            await ctx.createMessage(mailbox.uid, inbox.uid, { subject: "no read flag", flags: {} }),
            await ctx.createMessage(mailbox.uid, inbox.uid, { subject: "soft-deleted", flags: UNREAD, deleted: true }),
        ];
        for (let i = 0; i < 7; i++) {
            await ctx.createMessage(mailbox.uid, sent.uid, { subject: `sent ${i}`, flags: READ });
        }
        for (let i = 0; i < 4; i++) {
            await ctx.createMessage(mailbox.uid, deleted.uid, { subject: `deleted ${i}`, flags: i < 2 ? UNREAD : READ });
        }
        return { mailbox, inbox, sent, deleted, inboxMessages };
    };

    describe("reading folders", () => {
        it("lists each folder with the counts of its messages, not the counters stored on it", async () => {
            const { mailbox, inbox, sent, deleted } = await seedMailbox();

            const res = await listFolders(mailbox.uid);

            expect(res.status).toBe(200);
            const byUid = new Map<string, any>(res.body.map((folder: any) => [folder.uid, folder]));
            expect(counts(byUid.get(inbox.uid))).toEqual({ unreadCount: 2, totalCount: 3 });
            expect(counts(byUid.get(sent.uid))).toEqual({ unreadCount: 0, totalCount: 7 });
            expect(counts(byUid.get(deleted.uid))).toEqual({ unreadCount: 2, totalCount: 4 });
        });

        it("answers a folder by id with the same derived counts", async () => {
            const { inbox, sent } = await seedMailbox();

            expect(counts((await getFolder(inbox.uid)).body)).toEqual({ unreadCount: 2, totalCount: 3 });
            expect(counts((await getFolder(sent.uid)).body)).toEqual({ unreadCount: 0, totalCount: 7 });
        });

        it("derives them for a filtered and a paged list too", async () => {
            const { mailbox, inbox, sent, deleted } = await seedMailbox();

            const filtered = await listFolders(mailbox.uid, `&type=${FolderType.SENT_ITEMS}`);
            expect(filtered.body.map((folder: any) => folder.uid)).toEqual([sent.uid]);
            expect(counts(filtered.body[0])).toEqual({ unreadCount: 0, totalCount: 7 });

            const expected: Record<string, { unreadCount: number; totalCount: number }> = {
                [inbox.uid]: { unreadCount: 2, totalCount: 3 },
                [sent.uid]: { unreadCount: 0, totalCount: 7 },
                [deleted.uid]: { unreadCount: 2, totalCount: 4 },
            };
            const seen = new Set<string>();
            for (let page = 0; page < 3; page++) {
                const paged = await listFolders(mailbox.uid, `&limit=1&page=${page}`);
                expect(paged.body).toHaveLength(1);
                expect(counts(paged.body[0])).toEqual(expected[paged.body[0].uid]);
                seen.add(paged.body[0].uid);
            }
            expect(seen.size).toBe(3);
        });

        it("equals what the message list shows: every listed message is counted, the unread filter's rows are the unread ones", async () => {
            const { inbox } = await seedMailbox();

            const folder = (await getFolder(inbox.uid)).body;
            const listed = await auth(request(ctx.app()).get(`${ctx.messagesUrl}?folderUid=${inbox.uid}`));
            const unread = await auth(request(ctx.app()).get(`${ctx.messagesUrl}?folderUid=${inbox.uid}&filter=unread`));

            expect(listed.body).toHaveLength(folder.totalCount);
            expect(unread.body).toHaveLength(folder.unreadCount);
            // A soft-deleted message is in neither.
            expect(listed.body.map((message: any) => message.subject)).not.toContain("soft-deleted");
        });

        it("counts a folder with no messages as zero, whatever its stored counters say", async () => {
            const mailbox = await ctx.createMailbox(ctx.ownerUid);
            const empty = await ctx.createFolder(mailbox.uid, FolderType.ARCHIVE, { unreadCount: 12, totalCount: -3 });

            expect(counts((await getFolder(empty.uid)).body)).toEqual({ unreadCount: 0, totalCount: 0 });
        });

        it("repairs the stored counters it found wrong, so a reader of the row itself converges", async () => {
            const { inbox, sent } = await seedMailbox();
            expect(counts(await ctx.findFolder(inbox.uid))).toEqual({ unreadCount: 7, totalCount: 7 });

            await getFolder(inbox.uid);
            await listFolders(inbox.mailboxUid);

            expect(counts(await ctx.findFolder(inbox.uid))).toEqual({ unreadCount: 2, totalCount: 3 });
            expect(counts(await ctx.findFolder(sent.uid))).toEqual({ unreadCount: 0, totalCount: 7 });
        });

        it("answers a folder update with the derived counts too", async () => {
            const { inbox, sent } = await seedMailbox();

            const renamed = await auth(request(ctx.app()).put(`${ctx.foldersUrl}/${inbox.uid}`)).send({ uid: inbox.uid, version: inbox.version, name: "Renamed" });
            expect(renamed.status).toBe(200);
            expect(renamed.body.name).toBe("Renamed");
            expect(counts(renamed.body)).toEqual({ unreadCount: 2, totalCount: 3 });

            const property = await auth(request(ctx.app()).put(`${ctx.foldersUrl}/${sent.uid}/color`)).set("Content-Type", "application/json").send(JSON.stringify("#ff0000"));
            expect(property.status).toBe(200);
            expect(counts(property.body)).toEqual({ unreadCount: 0, totalCount: 7 });

            const current = (await getFolder(inbox.uid)).body;
            const bulk = await auth(request(ctx.app()).put(ctx.foldersUrl)).send([{ uid: inbox.uid, version: current.version, name: "Inbox again" }]);
            expect(bulk.status).toBe(200);
            expect(counts(bulk.body[0])).toEqual({ unreadCount: 2, totalCount: 3 });
        });

        it("never takes counts from a client: they're dropped from an update and zero on a create", async () => {
            const { mailbox, inbox } = await seedMailbox();

            const update = await auth(request(ctx.app()).put(`${ctx.foldersUrl}/${inbox.uid}`)).send({
                uid: inbox.uid,
                version: inbox.version,
                unreadCount: 99,
                totalCount: 99,
            });
            expect(update.status).toBe(200);
            expect(counts(update.body)).toEqual({ unreadCount: 2, totalCount: 3 });

            const created = await auth(request(ctx.app()).post(ctx.foldersUrl)).send({
                mailboxUid: mailbox.uid,
                name: "Projects",
                type: FolderType.USER,
                unreadCount: 50,
                totalCount: 50,
            });
            expect(created.status).toBe(200);
            expect(counts(created.body)).toEqual({ unreadCount: 0, totalCount: 0 });
            expect(counts((await getFolder(created.body.uid)).body)).toEqual({ unreadCount: 0, totalCount: 0 });
        });

        it("answers an empty list for a mailbox with no folders, without counting anything", async () => {
            const mailbox = await ctx.createMailbox(ctx.ownerUid);

            const { result, queries } = await ctx.countGroupedQueries(() => listFolders(mailbox.uid));

            expect(result.status).toBe(200);
            expect(result.body).toEqual([]);
            expect(queries).toBe(0);
        });

        it("costs one grouped query however many folders it lists", async () => {
            const mailbox = await ctx.createMailbox(ctx.ownerUid);
            const first = await ctx.createFolder(mailbox.uid, FolderType.INBOX);
            await ctx.createMessage(mailbox.uid, first.uid, { flags: UNREAD });
            const few = await ctx.countGroupedQueries(() => listFolders(mailbox.uid));
            expect(few.result.body).toHaveLength(1);
            expect(few.queries).toBe(1);

            for (let i = 0; i < 24; i++) {
                const folder = await ctx.createFolder(mailbox.uid, FolderType.USER);
                await ctx.createMessage(mailbox.uid, folder.uid, { flags: i % 2 ? READ : UNREAD });
            }
            const many = await ctx.countGroupedQueries(() => listFolders(mailbox.uid));
            expect(many.result.body).toHaveLength(25);
            expect(many.queries).toBe(1);
            expect(many.result.body.reduce((total: number, folder: any) => total + folder.totalCount, 0)).toBe(25);
            expect(many.result.body.reduce((total: number, folder: any) => total + folder.unreadCount, 0)).toBe(13);

            const one = await ctx.countGroupedQueries(() => getFolder(first.uid));
            expect(one.queries).toBe(1);
        });
    });

    describe("what a message write does to them", () => {
        it("marking a message read, then unread, moves the unread count and publishes the folder's counts each time", async () => {
            const { mailbox, inbox, inboxMessages } = await seedMailbox();
            const unread = inboxMessages[1];

            const read = await putMessage(unread.uid, { version: unread.version, flags: READ });
            expect(read.status).toBe(200);

            expect(counts((await getFolder(inbox.uid)).body)).toEqual({ unreadCount: 1, totalCount: 3 });
            expect(eventsFor(inbox.uid)).toEqual([
                {
                    channels: [inbox.uid, mailbox.uid],
                    type: expect.stringMatching(/^Folder/),
                    data: { uid: inbox.uid, mailboxUid: mailbox.uid, unreadCount: 1, totalCount: 3 },
                },
            ]);

            spy.mockClear();
            const again = await putMessage(unread.uid, { version: (await ctx.findMessage(unread.uid)).version, flags: UNREAD });
            expect(again.status).toBe(200);
            expect(counts((await getFolder(inbox.uid)).body)).toEqual({ unreadCount: 2, totalCount: 3 });
            expect(eventsFor(inbox.uid).map((event) => event.data)).toEqual([
                { uid: inbox.uid, mailboxUid: mailbox.uid, unreadCount: 2, totalCount: 3 },
            ]);
        });

        it("names the folder class in the event, so a client matching /^Folder/ hears it", async () => {
            const { inbox, inboxMessages } = await seedMailbox();

            await putMessage(inboxMessages[1].uid, { version: inboxMessages[1].version, flags: READ });

            const [event] = eventsFor(inbox.uid);
            expect(event.type).toMatch(/^Folder(Mongo|SQL)$/);
            expect(Object.keys(event.data).sort()).toEqual(["mailboxUid", "totalCount", "uid", "unreadCount"]);
        });

        it("publishes nothing for an update that changes neither the folder, nor read, nor deleted", async () => {
            const { inboxMessages } = await seedMailbox();

            const res = await putMessage(inboxMessages[1].uid, { version: inboxMessages[1].version, subject: "Renamed subject" });

            expect(res.status).toBe(200);
            expect(countEvents()).toEqual([]);
        });

        it("a bulk update publishes each affected folder once, with its final counts", async () => {
            const { mailbox, inbox, inboxMessages } = await seedMailbox();

            const res = await auth(request(ctx.app()).put(ctx.messagesUrl)).send(
                inboxMessages.slice(0, 3).map((message) => ({ uid: message.uid, version: message.version, flags: READ })),
            );

            expect(res.status).toBe(200);
            expect(counts((await getFolder(inbox.uid)).body)).toEqual({ unreadCount: 0, totalCount: 3 });
            expect(eventsFor(inbox.uid).map((event) => event.data)).toEqual([
                { uid: inbox.uid, mailboxUid: mailbox.uid, unreadCount: 0, totalCount: 3 },
            ]);
        });

        it("a bulk update that fails part-way still publishes for what it applied", async () => {
            const { inbox, inboxMessages } = await seedMailbox();

            const res = await auth(request(ctx.app()).put(ctx.messagesUrl)).send([
                { uid: inboxMessages[1].uid, version: inboxMessages[1].version, flags: READ },
                { uid: uuid.v4(), version: 0, flags: READ },
            ]);

            expect(res.status).toBeGreaterThanOrEqual(400);
            expect(counts((await getFolder(inbox.uid)).body)).toEqual({ unreadCount: 1, totalCount: 3 });
            expect(eventsFor(inbox.uid).map((event) => event.data.unreadCount)).toEqual([1]);
        });

        it("moving a message between folders changes both and publishes for both", async () => {
            const { mailbox, inbox, deleted, inboxMessages } = await seedMailbox();

            const res = await putMessage(inboxMessages[1].uid, { version: inboxMessages[1].version, folderUid: deleted.uid });

            expect(res.status).toBe(200);
            expect(counts((await getFolder(inbox.uid)).body)).toEqual({ unreadCount: 1, totalCount: 2 });
            expect(counts((await getFolder(deleted.uid)).body)).toEqual({ unreadCount: 3, totalCount: 5 });
            expect(eventsFor(inbox.uid).map((event) => event.data)).toEqual([{ uid: inbox.uid, mailboxUid: mailbox.uid, unreadCount: 1, totalCount: 2 }]);
            expect(eventsFor(deleted.uid).map((event) => event.data)).toEqual([{ uid: deleted.uid, mailboxUid: mailbox.uid, unreadCount: 3, totalCount: 5 }]);
        });

        it("archiving a message moves it out of its folder and into a new Archive folder, publishing both", async () => {
            const { inbox, inboxMessages } = await seedMailbox();

            const res = await auth(request(ctx.app()).post(`${ctx.messagesUrl}/${inboxMessages[1].uid}/archive`));

            expect(res.status).toBe(200);
            expect(counts((await getFolder(inbox.uid)).body)).toEqual({ unreadCount: 1, totalCount: 2 });
            const archive = await getFolder(res.body.folderUid);
            expect(counts(archive.body)).toEqual({ unreadCount: 1, totalCount: 1 });
            expect(eventsFor(inbox.uid)).toHaveLength(1);
            expect(eventsFor(res.body.folderUid)).toHaveLength(1);
        });

        it("deleting a message takes it out of the count, restoring it puts it back, and purging a live one takes it out for good", async () => {
            const { mailbox, inbox, inboxMessages } = await seedMailbox();

            const deleteRes = await auth(request(ctx.app()).delete(`${ctx.messagesUrl}/${inboxMessages[1].uid}`));
            expect(deleteRes.status).toBeLessThan(300);
            expect(counts((await getFolder(inbox.uid)).body)).toEqual({ unreadCount: 1, totalCount: 2 });
            expect(eventsFor(inbox.uid).map((event) => event.data)).toEqual([{ uid: inbox.uid, mailboxUid: mailbox.uid, unreadCount: 1, totalCount: 2 }]);

            await ctx.restoreMessage(inboxMessages[1].uid);
            expect(counts((await getFolder(inbox.uid)).body)).toEqual({ unreadCount: 2, totalCount: 3 });

            spy.mockClear();
            const purgeRes = await auth(request(ctx.app()).delete(`${ctx.messagesUrl}/${inboxMessages[0].uid}?purge=true`));
            expect(purgeRes.status).toBeLessThan(300);
            expect(counts((await getFolder(inbox.uid)).body)).toEqual({ unreadCount: 2, totalCount: 2 });
            expect(eventsFor(inbox.uid).map((event) => event.data)).toEqual([{ uid: inbox.uid, mailboxUid: mailbox.uid, unreadCount: 2, totalCount: 2 }]);
        });

        it("a delete that finds nothing to delete (a message already soft-deleted) changes nothing, so publishes nothing", async () => {
            const { inbox, inboxMessages } = await seedMailbox();
            spy.mockClear();

            const res = await auth(request(ctx.app()).delete(`${ctx.messagesUrl}/${inboxMessages[3].uid}?purge=true`));

            expect(res.status).toBe(404);
            expect(counts((await getFolder(inbox.uid)).body)).toEqual({ unreadCount: 2, totalCount: 3 });
            expect(countEvents()).toEqual([]);
        });

        it("emptying a folder (truncate) leaves it at zero and publishes its counts", async () => {
            const { mailbox, deleted } = await seedMailbox();

            const res = await auth(request(ctx.app()).delete(`${ctx.messagesUrl}?folderUid=${deleted.uid}`));

            expect(res.status).toBeLessThan(300);
            expect(counts((await getFolder(deleted.uid)).body)).toEqual({ unreadCount: 0, totalCount: 0 });
            expect(eventsFor(deleted.uid).map((event) => event.data)).toEqual([{ uid: deleted.uid, mailboxUid: mailbox.uid, unreadCount: 0, totalCount: 0 }]);
        });

        it("saving a draft, then discarding it, changes Drafts' counts and publishes each time", async () => {
            const mailbox = await ctx.createMailbox(ctx.ownerUid);
            const drafts = await ctx.createFolder(mailbox.uid, FolderType.DRAFTS, { unreadCount: 4, totalCount: 4 });

            const created = await auth(request(ctx.app()).post(ctx.messagesUrl)).send({
                mailboxUid: mailbox.uid,
                folderUid: drafts.uid,
                messageId: `${uuid.v4()}@example.com`,
                subject: "Draft",
                from: { address: "owner@example.com", type: "to" },
                recipients: [],
                sentDate: new Date().toISOString(),
                receivedDate: new Date().toISOString(),
                bodyBlobKey: `bodies/${uuid.v4()}`,
                bodyPreview: "Draft preview",
                flags: UNREAD,
                importance: "normal",
                references: [],
                hasAttachments: false,
            });
            expect(created.status).toBe(200);
            expect(counts((await getFolder(drafts.uid)).body)).toEqual({ unreadCount: 1, totalCount: 1 });
            expect(eventsFor(drafts.uid).map((event) => event.data)).toEqual([{ uid: drafts.uid, mailboxUid: mailbox.uid, unreadCount: 1, totalCount: 1 }]);

            spy.mockClear();
            const removed = await auth(request(ctx.app()).delete(`${ctx.messagesUrl}/${created.body.uid}`));
            expect(removed.status).toBeLessThan(300);
            expect(counts((await getFolder(drafts.uid)).body)).toEqual({ unreadCount: 0, totalCount: 0 });
            expect(eventsFor(drafts.uid).map((event) => event.data)).toEqual([{ uid: drafts.uid, mailboxUid: mailbox.uid, unreadCount: 0, totalCount: 0 }]);
        });

        it("saving several drafts at once publishes Drafts' counts once", async () => {
            const mailbox = await ctx.createMailbox(ctx.ownerUid);
            const drafts = await ctx.createFolder(mailbox.uid, FolderType.DRAFTS);
            const draft = () => ({
                mailboxUid: mailbox.uid,
                folderUid: drafts.uid,
                messageId: `${uuid.v4()}@example.com`,
                subject: "Draft",
                from: { address: "owner@example.com", type: "to" },
                recipients: [],
                sentDate: new Date().toISOString(),
                receivedDate: new Date().toISOString(),
                bodyBlobKey: `bodies/${uuid.v4()}`,
                bodyPreview: "Draft preview",
                flags: UNREAD,
                importance: "normal",
                references: [],
                hasAttachments: false,
            });

            const res = await auth(request(ctx.app()).post(ctx.messagesUrl)).send([draft(), draft()]);

            expect(res.status).toBe(200);
            expect(eventsFor(drafts.uid).map((event) => event.data.totalCount)).toEqual([2]);
        });
    });

    describe("send", () => {
        const draftTo = async (recipients: string[]) => {
            const mailbox = await ctx.createMailbox(ctx.ownerUid);
            const drafts = await ctx.createFolder(mailbox.uid, FolderType.DRAFTS);
            const bodyBlobKey = `bodies/${uuid.v4()}`;
            await ctx.blobStore().put(
                bodyBlobKey,
                Buffer.from(`From: owner@example.com\r\nTo: ${recipients.join(", ")}\r\nSubject: Q3 plan\r\n\r\nHello there.\r\n`),
            );
            const message = await ctx.createMessage(mailbox.uid, drafts.uid, {
                bodyBlobKey,
                subject: "Q3 plan",
                recipients: recipients.map((address) => ({ address, type: "to" })),
            });
            return { mailbox, drafts, message };
        };
        const send = (uid: string, body?: any) => auth(request(ctx.app()).post(`${ctx.messagesUrl}/${uid}/send`)).send(body ?? {});

        it("moves a draft's count out of Drafts and into Sent Items (read), and publishes the folders it passed through once each", async () => {
            const { mailbox, drafts, message } = await draftTo(["ok@example.com"]);

            const res = await send(message.uid);

            expect(res.status).toBe(200);
            const sentUid: string = res.body.folderUid;
            expect(counts((await getFolder(drafts.uid)).body)).toEqual({ unreadCount: 0, totalCount: 0 });
            expect(counts((await getFolder(sentUid)).body)).toEqual({ unreadCount: 0, totalCount: 1 });
            expect((await ctx.findFolder(sentUid)).type).toBe(FolderType.SENT_ITEMS);
            expect(eventsFor(drafts.uid).map((event) => event.data)).toEqual([{ uid: drafts.uid, mailboxUid: mailbox.uid, unreadCount: 0, totalCount: 0 }]);
            expect(eventsFor(sentUid).map((event) => event.data)).toEqual([{ uid: sentUid, mailboxUid: mailbox.uid, unreadCount: 0, totalCount: 1 }]);
            // Outbox was only a stop on the way: it ends up empty, and is published once.
            const outbox = countEvents().filter((event) => event.data.uid !== drafts.uid && event.data.uid !== sentUid);
            expect(outbox.map((event) => event.data.totalCount)).toEqual([0]);
        });

        it("leaves Drafts' counts as they were when the transport refuses the message", async () => {
            const { drafts, message } = await draftTo(["reject@example.com"]);

            const res = await send(message.uid);

            expect(res.status).toBe(502);
            expect(counts((await getFolder(drafts.uid)).body)).toEqual({ unreadCount: 1, totalCount: 1 });
            expect(eventsFor(drafts.uid).map((event) => event.data.totalCount)).toEqual([1]);
        });

        it("queues a scheduled send in Outbox, moving the count there", async () => {
            const { mailbox, drafts, message } = await draftTo(["ok@example.com"]);

            const res = await send(message.uid, { scheduledSendTime: new Date(Date.now() + 3_600_000).toISOString() });

            expect(res.status).toBe(200);
            const outboxUid: string = res.body.folderUid;
            expect(counts((await getFolder(drafts.uid)).body)).toEqual({ unreadCount: 0, totalCount: 0 });
            expect(counts((await getFolder(outboxUid)).body)).toEqual({ unreadCount: 1, totalCount: 1 });
            expect(eventsFor(outboxUid).map((event) => event.data)).toEqual([{ uid: outboxUid, mailboxUid: mailbox.uid, unreadCount: 1, totalCount: 1 }]);
        });
    });
}
