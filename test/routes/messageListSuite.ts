///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The mail list's own server-side sorting, filtering, conversation listing/expansion and bulk update -
// identical on both backends. `test/routes/{mongo,sql}/MessageList.test.ts` supply a started server and raw row
// helpers. Every case goes through real HTTP against a real database, because the whole point of these fields is
// that the *database* can order and filter on them: asserting against an in-memory double would prove nothing.
import { request } from "@rapidrest/service-core/test";
import { ACLAction } from "@rapidrest/service-core";
import { JWTUtils } from "@rapidrest/core";
import * as uuid from "uuid";
import { MAX_BULK_UPDATE } from "../../src/routes/BaseScopedChildRoute.js";
import { MAX_MESSAGE_LABEL_FILTER_UIDS } from "../../src/util/MessageListUtils.js";
import { FolderType, MessageClassification, MessageImportance, RecipientType } from "../../src/models/types.js";

type AclRecords = { userOrRoleId: string; actions: string[] }[];

export interface MessageListSuiteContext {
    config: any;
    app: () => any;
    baseUrl: string;
    /** Saves a mailbox owned by `ownerUserUid`, with a full-access ACL for it. */
    saveMailbox: (ownerUserUid: string) => Promise<any>;
    /** Saves a folder of `type` in `mailboxUid`, with an ACL parented on the mailbox carrying `records`. */
    saveFolder: (mailboxUid: string, type: FolderType, records?: AclRecords) => Promise<any>;
    /** Saves a message row, `fields` merged over this suite's own defaults. Goes through the real model class,
     * so the denormalized list fields are derived exactly as a delivered message's would be. */
    saveMessage: (mailboxUid: string, folderUid: string, fields?: Record<string, any>) => Promise<any>;
    /** Reads one message row straight out of the database, bypassing the route. */
    readMessage: (uid: string) => Promise<any>;
}

export function messageListSuite(ctx: MessageListSuiteContext): void {
    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const stranger: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const tokenFor = (user: any): string => JWTUtils.createTokenSync(ctx.config.get("auth"), user);

    const get = (path: string, user: any = owner) =>
        request(ctx.app())
            .get(`${ctx.baseUrl}${path}`)
            .set("Authorization", "jwt " + tokenFor(user));
    const head = (path: string, user: any = owner) =>
        request(ctx.app())
            .head(`${ctx.baseUrl}${path}`)
            .set("Authorization", "jwt " + tokenFor(user));
    const put = (path: string, body: any, user: any = owner) =>
        request(ctx.app())
            .put(`${ctx.baseUrl}${path}`)
            .set("Authorization", "jwt " + tokenFor(user))
            .send(body);

    const subjects = (body: any[]): string[] => body.map((message) => message.subject);
    const day = (offsetDays: number): Date => new Date(Date.UTC(2026, 0, 10 + offsetDays, 12));

    describe("sorting (GET /?sortBy=&sortOrder=)", () => {
        let folderUid: string;

        /** Three messages whose every sortable field orders them differently, so no assertion below can pass by
         * accident on the insertion order. */
        beforeEach(async () => {
            const mailbox = await ctx.saveMailbox(owner.uid);
            const folder = await ctx.saveFolder(mailbox.uid, FolderType.INBOX);
            folderUid = folder.uid;
            await ctx.saveMessage(mailbox.uid, folderUid, {
                subject: "Charlie",
                from: { address: "Anna@Example.COM", type: RecipientType.TO },
                receivedDate: day(0),
                sentDate: day(2),
                importance: MessageImportance.NORMAL,
                flags: { read: false, flagged: true, answered: false, forwarded: false },
            });
            await ctx.saveMessage(mailbox.uid, folderUid, {
                subject: "Alpha",
                from: { address: "carl@example.com", type: RecipientType.TO },
                receivedDate: day(1),
                sentDate: day(0),
                importance: MessageImportance.HIGH,
                flags: { read: true, flagged: false, answered: false, forwarded: false },
            });
            await ctx.saveMessage(mailbox.uid, folderUid, {
                subject: "Bravo",
                from: { address: "bob@example.com", type: RecipientType.TO },
                receivedDate: day(2),
                sentDate: day(1),
                importance: MessageImportance.LOW,
                flags: { read: false, flagged: false, answered: false, forwarded: false },
            });
        });

        it("defaults to newest received first, with no sortBy at all", async () => {
            const res = await get(`?folderUid=${folderUid}`);
            expect(res.status).toBe(200);
            expect(subjects(res.body)).toEqual(["Bravo", "Alpha", "Charlie"]);
        });

        it("sorts oldest first with sortOrder=asc (Outlook's 'Oldest on top')", async () => {
            const res = await get(`?folderUid=${folderUid}&sortBy=date&sortOrder=asc`);
            expect(subjects(res.body)).toEqual(["Charlie", "Alpha", "Bravo"]);
        });

        it("sorts by sender on the normalized fromAddress mirror, not the from sub-document", async () => {
            const res = await get(`?folderUid=${folderUid}&sortBy=from`);
            // `Anna@Example.COM` is stored lowercased, so it sorts before `bob@`/`carl@` rather than after them
            // (uppercase letters sort first in every collation these backends use by default).
            expect(subjects(res.body)).toEqual(["Charlie", "Bravo", "Alpha"]);
            const descending = await get(`?folderUid=${folderUid}&sortBy=from&sortOrder=desc`);
            expect(subjects(descending.body)).toEqual(["Alpha", "Bravo", "Charlie"]);
        });

        it("sorts by subject", async () => {
            const res = await get(`?folderUid=${folderUid}&sortBy=subject`);
            expect(subjects(res.body)).toEqual(["Alpha", "Bravo", "Charlie"]);
        });

        it("sorts by sentDate independently of receivedDate", async () => {
            const res = await get(`?folderUid=${folderUid}&sortBy=sentDate`);
            expect(subjects(res.body)).toEqual(["Charlie", "Bravo", "Alpha"]);
        });

        it("sorts by importance high first, which the stored enum strings would not do alphabetically", async () => {
            const res = await get(`?folderUid=${folderUid}&sortBy=importance`);
            expect(subjects(res.body)).toEqual(["Alpha", "Charlie", "Bravo"]);
        });

        it("sorts flagged messages first", async () => {
            const res = await get(`?folderUid=${folderUid}&sortBy=flagged`);
            expect(res.body[0].subject).toBe("Charlie");
        });

        it("rejects an unknown sortBy (400) and an unknown sortOrder (400)", async () => {
            expect((await get(`?folderUid=${folderUid}&sortBy=category`)).status).toBe(400);
            expect((await get(`?folderUid=${folderUid}&sortBy=date&sortOrder=sideways`)).status).toBe(400);
        });

        it("leaves an explicit generic ?sort= alone when no sortBy/sortOrder is named", async () => {
            const res = await get(`?folderUid=${folderUid}&sort=${encodeURIComponent(JSON.stringify({ subject: "ASC" }))}`);
            expect(subjects(res.body)).toEqual(["Alpha", "Bravo", "Charlie"]);
        });

        it("pages stably: every message appears exactly once across two pages", async () => {
            const first = await get(`?folderUid=${folderUid}&limit=2&page=0`);
            const second = await get(`?folderUid=${folderUid}&limit=2&page=1`);
            expect([...subjects(first.body), ...subjects(second.body)]).toEqual(["Bravo", "Alpha", "Charlie"]);
        });
    });

    describe("filtering (GET /?filter=)", () => {
        let folderUid: string;

        beforeEach(async () => {
            const mailbox = await ctx.saveMailbox(owner.uid);
            const folder = await ctx.saveFolder(mailbox.uid, FolderType.INBOX);
            folderUid = folder.uid;
            await ctx.saveMessage(mailbox.uid, folderUid, {
                subject: "unread-focused",
                inferenceClassification: MessageClassification.FOCUSED,
            });
            await ctx.saveMessage(mailbox.uid, folderUid, {
                subject: "read-other",
                flags: { read: true, flagged: false, answered: false, forwarded: false },
                inferenceClassification: MessageClassification.OTHER,
            });
            await ctx.saveMessage(mailbox.uid, folderUid, {
                subject: "flagged-with-file",
                flags: { read: true, flagged: true, answered: false, forwarded: false },
                hasAttachments: true,
            });
        });

        it("filters unread, read, flagged and has-files", async () => {
            expect(subjects((await get(`?folderUid=${folderUid}&filter=unread`)).body)).toEqual(["unread-focused"]);
            expect(subjects((await get(`?folderUid=${folderUid}&filter=read`)).body).sort()).toEqual([
                "flagged-with-file",
                "read-other",
            ]);
            expect(subjects((await get(`?folderUid=${folderUid}&filter=flagged`)).body)).toEqual(["flagged-with-file"]);
            expect(subjects((await get(`?folderUid=${folderUid}&filter=hasAttachments`)).body)).toEqual(["flagged-with-file"]);
        });

        it("filter=all is the same as no filter at all", async () => {
            expect((await get(`?folderUid=${folderUid}&filter=all`)).body.length).toBe(3);
            expect((await get(`?folderUid=${folderUid}`)).body.length).toBe(3);
        });

        it("counts focused as including a message with no inferenceClassification at all", async () => {
            // The third message above was stored with none, which `Message.inferenceClassification` defines as focused.
            const focused = await get(`?folderUid=${folderUid}&filter=focused`);
            expect(subjects(focused.body).sort()).toEqual(["flagged-with-file", "unread-focused"]);
            expect(subjects((await get(`?folderUid=${folderUid}&filter=other`)).body)).toEqual(["read-other"]);
        });

        it("rejects an unknown filter (400)", async () => {
            expect((await get(`?folderUid=${folderUid}&filter=mentionsMe`)).status).toBe(400);
        });

        it("applies the same filter to HEAD, so a count matches the list it labels", async () => {
            const counted = await head(`?folderUid=${folderUid}&filter=unread`);
            expect(counted.status).toBe(200);
            expect(Number(counted.headers["content-length"])).toBe(1);
            expect(Number((await head(`?folderUid=${folderUid}`)).headers["content-length"])).toBe(3);
        });

        it("still honors the generic query DSL alongside a named filter", async () => {
            const res = await get(`?folderUid=${folderUid}&filter=read&subject=${encodeURIComponent("eq(read-other)")}`);
            expect(subjects(res.body)).toEqual(["read-other"]);
        });
    });

    describe("label filtering (GET /?labelUids=)", () => {
        let folderUid: string;
        let mailboxUid: string;
        let red: string;
        let blue: string;
        let green: string;

        /** Three labels over four messages: one red, one blue, one carrying both, and one legacy row whose
         * `labelUids` was never written at all (`null` on both backends - see `MessageSQL.labelUids`). */
        beforeEach(async () => {
            const mailbox = await ctx.saveMailbox(owner.uid);
            mailboxUid = mailbox.uid;
            const folder = await ctx.saveFolder(mailbox.uid, FolderType.INBOX);
            folderUid = folder.uid;
            red = uuid.v4();
            blue = uuid.v4();
            green = uuid.v4();
            await ctx.saveMessage(mailbox.uid, folderUid, { subject: "red-one", labelUids: [red], receivedDate: day(0) });
            await ctx.saveMessage(mailbox.uid, folderUid, {
                subject: "blue-read",
                labelUids: [blue],
                receivedDate: day(1),
                flags: { read: true, flagged: false, answered: false, forwarded: false },
            });
            await ctx.saveMessage(mailbox.uid, folderUid, { subject: "both", labelUids: [blue, red], receivedDate: day(2) });
            await ctx.saveMessage(mailbox.uid, folderUid, { subject: "legacy", labelUids: null, receivedDate: day(3) });
        });

        it("returns every message carrying one named label", async () => {
            const res = await get(`?folderUid=${folderUid}&labelUids=${red}`);
            expect(res.status).toBe(200);
            expect(subjects(res.body).sort()).toEqual(["both", "red-one"]);
        });

        it("ORs several labels rather than requiring all of them, whatever order they are named in", async () => {
            const res = await get(`?folderUid=${folderUid}&labelUids=${red},${blue}`);
            expect(subjects(res.body).sort()).toEqual(["blue-read", "both", "red-one"]);
            const reversed = await get(`?folderUid=${folderUid}&labelUids=${blue},${red}`);
            expect(subjects(reversed.body).sort()).toEqual(["blue-read", "both", "red-one"]);
        });

        it("ANDs the label set with a named filter and honors a sort alongside it", async () => {
            const unread = await get(`?folderUid=${folderUid}&labelUids=${red},${blue}&filter=unread&sortBy=subject`);
            expect(subjects(unread.body)).toEqual(["both", "red-one"]);
            expect(subjects((await get(`?folderUid=${folderUid}&labelUids=${red},${blue}&filter=read`)).body)).toEqual([
                "blue-read",
            ]);
        });

        it("applies the same predicate to HEAD, so a count matches the list it labels", async () => {
            const counted = await head(`?folderUid=${folderUid}&labelUids=${red}`);
            expect(Number(counted.headers["content-length"])).toBe(2);
        });

        it("pages the filtered set stably", async () => {
            const first = await get(`?folderUid=${folderUid}&labelUids=${red},${blue}&limit=2&page=0`);
            const second = await get(`?folderUid=${folderUid}&labelUids=${red},${blue}&limit=2&page=1`);
            expect([...subjects(first.body), ...subjects(second.body)]).toEqual(["both", "blue-read", "red-one"]);
        });

        it("matches nothing for an unknown label, for another mailbox's label, and for a legacy row with none", async () => {
            expect((await get(`?folderUid=${folderUid}&labelUids=${green}`)).body).toEqual([]);

            const otherMailbox = await ctx.saveMailbox(owner.uid);
            const otherFolder = await ctx.saveFolder(otherMailbox.uid, FolderType.INBOX);
            const elsewhere = uuid.v4();
            await ctx.saveMessage(otherMailbox.uid, otherFolder.uid, { subject: "theirs", labelUids: [elsewhere] });
            // Another mailbox's label uid can only ever widen this folder's list if the predicate matched
            // something other than the uid itself.
            expect((await get(`?folderUid=${folderUid}&labelUids=${elsewhere}`)).body).toEqual([]);
            expect(subjects((await get(`?folderUid=${otherFolder.uid}&labelUids=${elsewhere}`)).body)).toEqual(["theirs"]);
            // The legacy row (no labelUids at all) is in the folder but never in a label-filtered list.
            expect(subjects((await get(`?folderUid=${folderUid}`)).body)).toContain("legacy");
        });

        it("matches a uid exactly, never as a prefix or suffix of another label's uid", async () => {
            // Same uid with its last character changed - a substring match on the stored JSON would still hit.
            const nearMiss = `${red.slice(0, -1)}${red.endsWith("a") ? "b" : "a"}`;
            expect((await get(`?folderUid=${folderUid}&labelUids=${nearMiss}`)).body).toEqual([]);
        });

        it("treats an empty labelUids as unset, and accepts a repeated parameter as one set", async () => {
            expect((await get(`?folderUid=${folderUid}&labelUids=`)).body.length).toBe(4);
            const repeated = await get(`?folderUid=${folderUid}&labelUids=${red}&labelUids=${blue}`);
            expect(subjects(repeated.body).sort()).toEqual(["blue-read", "both", "red-one"]);
        });

        it("rejects a malformed uid (400) and more than MAX_MESSAGE_LABEL_FILTER_UIDS of them (400)", async () => {
            expect((await get(`?folderUid=${folderUid}&labelUids=not-a-label`)).status).toBe(400);
            expect((await get(`?folderUid=${folderUid}&labelUids=${red},`)).status).toBe(400);
            const tooMany = Array.from({ length: MAX_MESSAGE_LABEL_FILTER_UIDS + 1 }, () => uuid.v4()).join(",");
            expect((await get(`?folderUid=${folderUid}&labelUids=${tooMany}`)).status).toBe(400);
        });

        it("filters the messages of a conversation list before they are grouped", async () => {
            const labelled = await get(`/conversations?mailboxUid=${mailboxUid}&labelUids=${red}`);
            expect(labelled.status).toBe(200);
            expect(labelled.body.map((c: any) => c.subject).sort()).toEqual(["both", "red-one"]);
            expect((await get(`/conversations?mailboxUid=${mailboxUid}&labelUids=${green}`)).body).toEqual([]);
            expect((await get(`/conversations?mailboxUid=${mailboxUid}&labelUids=nonsense`)).status).toBe(400);
            // Combined with a named filter, exactly as the message list combines them.
            const unread = await get(`/conversations?mailboxUid=${mailboxUid}&labelUids=${red},${blue}&filter=read`);
            expect(unread.body.map((c: any) => c.subject)).toEqual(["blue-read"]);
        });
    });

    describe("the denormalized list fields", () => {
        it("derives every mirror from flags/from/importance when a message is written", async () => {
            const mailbox = await ctx.saveMailbox(owner.uid);
            const folder = await ctx.saveFolder(mailbox.uid, FolderType.INBOX);
            const message = await ctx.saveMessage(mailbox.uid, folder.uid, {
                from: { address: "  Owner@Example.COM ", type: RecipientType.TO },
                importance: MessageImportance.HIGH,
                flags: { read: true, flagged: true, answered: false, forwarded: false },
            });
            const stored = await ctx.readMessage(message.uid);
            expect(stored.read).toBe(true);
            expect(stored.flagged).toBe(true);
            expect(stored.fromAddress).toBe("owner@example.com");
            expect(stored.importanceRank).toBe(2);
        });

        it("re-derives them on an ordinary update, so marking a message read takes it out of the unread filter", async () => {
            const mailbox = await ctx.saveMailbox(owner.uid);
            const folder = await ctx.saveFolder(mailbox.uid, FolderType.INBOX);
            const message = await ctx.saveMessage(mailbox.uid, folder.uid, { subject: "to-read" });
            expect(subjects((await get(`?folderUid=${folder.uid}&filter=unread`)).body)).toEqual(["to-read"]);

            const updated = await put(`/${message.uid}`, {
                uid: message.uid,
                version: message.version,
                flags: { read: true, flagged: true, answered: false, forwarded: false },
            });
            expect(updated.status).toBe(200);
            expect((await ctx.readMessage(message.uid)).read).toBe(true);
            expect((await get(`?folderUid=${folder.uid}&filter=unread`)).body).toEqual([]);
            expect(subjects((await get(`?folderUid=${folder.uid}&filter=flagged`)).body)).toEqual(["to-read"]);
        });

        it("ignores a mirror sent in a request body rather than letting it contradict flags", async () => {
            const mailbox = await ctx.saveMailbox(owner.uid);
            const folder = await ctx.saveFolder(mailbox.uid, FolderType.INBOX);
            const message = await ctx.saveMessage(mailbox.uid, folder.uid);

            const updated = await put(`/${message.uid}`, {
                uid: message.uid,
                version: message.version,
                read: true,
                flagged: true,
                fromAddress: "attacker@example.com",
                importanceRank: 99,
            });
            expect(updated.status).toBe(200);
            const stored = await ctx.readMessage(message.uid);
            expect(stored.read).toBe(false);
            expect(stored.flagged).toBe(false);
            expect(stored.fromAddress).toBe("owner@example.com");
            expect(stored.importanceRank).toBe(1);
        });
    });

    describe("conversations()", () => {
        it("carries the most recent message's meeting method and the owner's answer, so a collapsed row can show an RSVP button", async () => {
            const mailbox = await ctx.saveMailbox(owner.uid);
            const inbox = await ctx.saveFolder(mailbox.uid, FolderType.INBOX);
            await ctx.saveMessage(mailbox.uid, inbox.uid, { conversationId: "meeting", subject: "Invitation: Sync", receivedDate: day(0), meetingMethod: "REQUEST" });
            await ctx.saveMessage(mailbox.uid, inbox.uid, { conversationId: "plain", subject: "Hello", receivedDate: day(1) });
            await ctx.saveMessage(mailbox.uid, inbox.uid, {
                conversationId: "answered",
                subject: "Invitation: Standup",
                receivedDate: day(2),
                meetingMethod: "REQUEST",
                meetingResponse: "declined",
            });

            const all = await get(`/conversations?mailboxUid=${mailbox.uid}`);

            const bySubject = (subject: string) => all.body.find((row: any) => row.subject === subject);
            expect(bySubject("Invitation: Sync")).toMatchObject({ latestMeetingMethod: "REQUEST" });
            expect(bySubject("Invitation: Sync").latestMeetingResponse ?? undefined).toBeUndefined();
            expect(bySubject("Hello").latestMeetingMethod ?? undefined).toBeUndefined();
            expect(bySubject("Invitation: Standup")).toMatchObject({ latestMeetingMethod: "REQUEST", latestMeetingResponse: "declined" });
        });

        it("reports the fields a collapsed conversation row shows, and restricts to one folder on request", async () => {
            const mailbox = await ctx.saveMailbox(owner.uid);
            const inbox = await ctx.saveFolder(mailbox.uid, FolderType.INBOX);
            const sent = await ctx.saveFolder(mailbox.uid, FolderType.SENT_ITEMS);
            await ctx.saveMessage(mailbox.uid, inbox.uid, {
                conversationId: "thread-1",
                subject: "Budget",
                receivedDate: day(0),
                hasAttachments: true,
                from: { address: "alice@example.com", type: RecipientType.TO },
            });
            await ctx.saveMessage(mailbox.uid, sent.uid, {
                conversationId: "thread-1",
                subject: "Re: Budget",
                receivedDate: day(1),
                bodyPreview: "Sounds good",
                flags: { read: true, flagged: true, answered: false, forwarded: false },
                from: { address: "owner@example.com", type: RecipientType.TO },
            });

            const all = await get(`/conversations?mailboxUid=${mailbox.uid}`);
            expect(all.status).toBe(200);
            expect(all.body.length).toBe(1);
            const conversation = all.body[0];
            expect(conversation.messageCount).toBe(2);
            expect(conversation.unreadCount).toBe(1);
            expect(conversation.hasAttachments).toBe(true);
            expect(conversation.flagged).toBe(true);
            expect(conversation.subject).toBe("Re: Budget");
            expect(conversation.latestPreview).toBe("Sounds good");
            expect(conversation.latestFrom.address).toBe("owner@example.com");
            expect(conversation.latestFolderUid).toBe(sent.uid);
            expect(conversation.latestMessageUid).toBe(conversation.messageUids[1]);
            expect([...conversation.folderUids].sort()).toEqual([inbox.uid, sent.uid].sort());
            expect(conversation.participants.map((p: any) => p.address).sort()).toEqual([
                "alice@example.com",
                "owner@example.com",
                "recipient@example.com",
            ]);

            const inboxOnly = await get(`/conversations?mailboxUid=${mailbox.uid}&folderUid=${inbox.uid}`);
            expect(inboxOnly.body.length).toBe(1);
            expect(inboxOnly.body[0].messageCount).toBe(1);
            expect(inboxOnly.body[0].subject).toBe("Budget");

            // An empty folderUid is no folder restriction at all, not a restriction to a folder named "".
            const blankFolder = await get(`/conversations?mailboxUid=${mailbox.uid}&folderUid=`);
            expect(blankFolder.body.length).toBe(1);
            expect(blankFolder.body[0].messageCount).toBe(2);
        });

        it("breaks a receivedDate tie deterministically instead of following the database's own order", async () => {
            const mailbox = await ctx.saveMailbox(owner.uid);
            const inbox = await ctx.saveFolder(mailbox.uid, FolderType.INBOX);
            // Two messages of the same conversation stamped to the same millisecond - a reply filed into Sent
            // Items in the tick its original was delivered does exactly this.
            const first = await ctx.saveMessage(mailbox.uid, inbox.uid, { conversationId: "tied", receivedDate: day(0) });
            const second = await ctx.saveMessage(mailbox.uid, inbox.uid, { conversationId: "tied", receivedDate: day(0) });
            const expected = [first.uid, second.uid].sort()[1];

            const res = await get(`/conversations?mailboxUid=${mailbox.uid}`);
            expect(res.body[0].latestMessageUid).toBe(expected);
            expect(res.body[0].messageUids).toEqual([first.uid, second.uid].sort());
        });

        it("applies a named filter to the messages before grouping them", async () => {
            const mailbox = await ctx.saveMailbox(owner.uid);
            const inbox = await ctx.saveFolder(mailbox.uid, FolderType.INBOX);
            await ctx.saveMessage(mailbox.uid, inbox.uid, { conversationId: "thread-1", subject: "unread one" });
            await ctx.saveMessage(mailbox.uid, inbox.uid, {
                conversationId: "thread-2",
                subject: "read one",
                flags: { read: true, flagged: false, answered: false, forwarded: false },
            });

            const unread = await get(`/conversations?mailboxUid=${mailbox.uid}&filter=unread`);
            expect(unread.body.map((c: any) => c.conversationId)).toEqual(["thread-1"]);
        });

        it("pages the grouped rows with limit/page", async () => {
            const mailbox = await ctx.saveMailbox(owner.uid);
            const inbox = await ctx.saveFolder(mailbox.uid, FolderType.INBOX);
            await ctx.saveMessage(mailbox.uid, inbox.uid, { conversationId: "older", receivedDate: day(0) });
            await ctx.saveMessage(mailbox.uid, inbox.uid, { conversationId: "newer", receivedDate: day(1) });

            expect((await get(`/conversations?mailboxUid=${mailbox.uid}&limit=1`)).body.map((c: any) => c.conversationId)).toEqual([
                "newer",
            ]);
            expect(
                (await get(`/conversations?mailboxUid=${mailbox.uid}&limit=1&page=1`)).body.map((c: any) => c.conversationId),
            ).toEqual(["older"]);
            // A nonsensical limit/page falls back to the defaults rather than returning nothing.
            expect((await get(`/conversations?mailboxUid=${mailbox.uid}&limit=0&page=-3`)).body.length).toBe(2);
        });
    });

    describe("conversationMessages()", () => {
        it("returns one conversation's messages oldest first, across folders", async () => {
            const mailbox = await ctx.saveMailbox(owner.uid);
            const inbox = await ctx.saveFolder(mailbox.uid, FolderType.INBOX);
            const sent = await ctx.saveFolder(mailbox.uid, FolderType.SENT_ITEMS);
            await ctx.saveMessage(mailbox.uid, sent.uid, { conversationId: "thread-1", subject: "reply", receivedDate: day(1) });
            await ctx.saveMessage(mailbox.uid, inbox.uid, { conversationId: "thread-1", subject: "root", receivedDate: day(0) });
            await ctx.saveMessage(mailbox.uid, inbox.uid, { conversationId: "thread-2", subject: "unrelated" });

            const res = await get(`/conversations/thread-1?mailboxUid=${mailbox.uid}`);
            expect(res.status).toBe(200);
            expect(subjects(res.body)).toEqual(["root", "reply"]);
        });

        it("pages, capping limit at MAX_CONVERSATION_PAGE_SIZE", async () => {
            const mailbox = await ctx.saveMailbox(owner.uid);
            const inbox = await ctx.saveFolder(mailbox.uid, FolderType.INBOX);
            await ctx.saveMessage(mailbox.uid, inbox.uid, { conversationId: "thread-1", subject: "first", receivedDate: day(0) });
            await ctx.saveMessage(mailbox.uid, inbox.uid, { conversationId: "thread-1", subject: "second", receivedDate: day(1) });

            expect(subjects((await get(`/conversations/thread-1?mailboxUid=${mailbox.uid}&limit=1`)).body)).toEqual(["first"]);
            expect(subjects((await get(`/conversations/thread-1?mailboxUid=${mailbox.uid}&limit=1&page=1`)).body)).toEqual(["second"]);
            expect((await get(`/conversations/thread-1?mailboxUid=${mailbox.uid}&limit=100000`)).body.length).toBe(2);
            // A page past the end answers empty rather than falling back to the singleton lookup.
            expect((await get(`/conversations/thread-1?mailboxUid=${mailbox.uid}&limit=1&page=9`)).body).toEqual([]);
        });

        it("expands a singleton conversation keyed on the message's own uid", async () => {
            const mailbox = await ctx.saveMailbox(owner.uid);
            const inbox = await ctx.saveFolder(mailbox.uid, FolderType.INBOX);
            const loner = await ctx.saveMessage(mailbox.uid, inbox.uid, { subject: "no thread", conversationId: undefined });

            const summaries = await get(`/conversations?mailboxUid=${mailbox.uid}`);
            expect(summaries.body[0].conversationId).toBe(loner.uid);
            const res = await get(`/conversations/${loner.uid}?mailboxUid=${mailbox.uid}`);
            expect(subjects(res.body)).toEqual(["no thread"]);
        });

        it("answers empty for an unknown id, for a message in another mailbox, and for a uid that isn't a singleton", async () => {
            const mailbox = await ctx.saveMailbox(owner.uid);
            const other = await ctx.saveMailbox(owner.uid);
            const inbox = await ctx.saveFolder(other.uid, FolderType.INBOX);
            const elsewhere = await ctx.saveMessage(other.uid, inbox.uid, { conversationId: undefined });
            const ownInbox = await ctx.saveFolder(mailbox.uid, FolderType.INBOX);
            // In a thread of its own, so its uid is not the key `conversations()` would group it under.
            const threaded = await ctx.saveMessage(mailbox.uid, ownInbox.uid, { conversationId: "thread-9" });

            expect((await get(`/conversations/${uuid.v4()}?mailboxUid=${mailbox.uid}`)).body).toEqual([]);
            expect((await get(`/conversations/${elsewhere.uid}?mailboxUid=${mailbox.uid}`)).body).toEqual([]);
            expect((await get(`/conversations/${threaded.uid}?mailboxUid=${mailbox.uid}`)).body).toEqual([]);
        });

        it("requires a mailboxUid (400) and answers empty without LIST permission on it", async () => {
            const mailbox = await ctx.saveMailbox(owner.uid);
            expect((await get(`/conversations/thread-1`)).status).toBe(400);
            expect((await get(`/conversations?mailboxUid=`)).status).toBe(400);
            const denied = await get(`/conversations/thread-1?mailboxUid=${mailbox.uid}`, stranger);
            expect(denied.status).toBe(200);
            expect(denied.body).toEqual([]);
        });
    });

    describe("bulk update (PUT /)", () => {
        it("marks a whole selection read in one request, mirrors included", async () => {
            const mailbox = await ctx.saveMailbox(owner.uid);
            const inbox = await ctx.saveFolder(mailbox.uid, FolderType.INBOX);
            const first = await ctx.saveMessage(mailbox.uid, inbox.uid, { subject: "one" });
            const second = await ctx.saveMessage(mailbox.uid, inbox.uid, { subject: "two" });

            const res = await put(
                "",
                [first, second].map((message) => ({
                    uid: message.uid,
                    version: message.version,
                    flags: { read: true, flagged: false, answered: false, forwarded: false },
                })),
            );
            expect(res.status).toBe(200);
            expect((await get(`?folderUid=${inbox.uid}&filter=unread`)).body).toEqual([]);
            expect((await ctx.readMessage(first.uid)).read).toBe(true);
            expect((await ctx.readMessage(second.uid)).read).toBe(true);
        });

        it("refuses more than MAX_BULK_UPDATE objects in one request (400)", async () => {
            const mailbox = await ctx.saveMailbox(owner.uid);
            const inbox = await ctx.saveFolder(mailbox.uid, FolderType.INBOX);
            const message = await ctx.saveMessage(mailbox.uid, inbox.uid);
            const body = Array.from({ length: MAX_BULK_UPDATE + 1 }, () => ({ uid: message.uid, version: message.version }));

            expect((await put("", body)).status).toBe(400);
        });
    });

    describe("access control", () => {
        it("answers empty rather than leaking another user's folder to a sorted/filtered list", async () => {
            const mailbox = await ctx.saveMailbox(owner.uid);
            const inbox = await ctx.saveFolder(mailbox.uid, FolderType.INBOX);
            await ctx.saveMessage(mailbox.uid, inbox.uid);

            const res = await get(`?folderUid=${inbox.uid}&filter=unread&sortBy=from`, stranger);
            expect(res.status).toBe(200);
            expect(res.body).toEqual([]);
        });

        it("lets a delegate with LIST on the folder use the same filters", async () => {
            const mailbox = await ctx.saveMailbox(owner.uid);
            const inbox = await ctx.saveFolder(mailbox.uid, FolderType.INBOX, [
                { userOrRoleId: stranger.uid, actions: [ACLAction.LIST, ACLAction.READ] },
            ]);
            await ctx.saveMessage(mailbox.uid, inbox.uid, { subject: "shared" });

            const res = await get(`?folderUid=${inbox.uid}&filter=unread`, stranger);
            expect(subjects(res.body)).toEqual(["shared"]);
        });
    });
}
