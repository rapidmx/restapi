///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `POST /mail/messages/:id/report` - junk, phishing and not-junk reports that move the message, teach the spam filter and are audited -
// identical on both backends. `test/routes/{mongo,sql}/MessageReport.test.ts` supply a started server and raw row helpers.
import { request } from "@rapidrest/service-core/test";
import { ACLAction, RepoUtils } from "@rapidrest/service-core";
import * as uuid from "uuid";
import { MAX_REPORT_LEARN_BYTES } from "../../src/routes/BaseMessageRoute.js";
import { AuditAction, FolderType, MessageImportance, RecipientType } from "../../src/models/types.js";
import type { AlwaysCleanSpamScanProvider, InMemoryBlobStore } from "../testDoubles.js";

export interface MessageReportSuiteContext {
    app: () => any;
    baseUrl: string;
    tokenFor: (user: any) => string;
    /** Saves a mailbox (aliased `owner@example.com`) with an ACL giving `ownerUid` every action. */
    saveMailbox: (ownerUid: string, fields?: Record<string, any>, records?: { userOrRoleId: string; actions: string[] }[]) => Promise<any>;
    /** Saves a folder with an ACL under its mailbox carrying `records`. */
    saveFolder: (mailboxUid: string, type: FolderType, records?: { userOrRoleId: string; actions: string[] }[]) => Promise<any>;
    saveMessage: (fields: Record<string, any>) => Promise<any>;
    findMessage: (uid: string) => Promise<any>;
    findMailbox: (uid: string) => Promise<any>;
    /** How many folders of `type` the mailbox has. */
    countFolders: (mailboxUid: string, type: FolderType) => Promise<number>;
    /** Writes `fields` straight to the message row, bumping its version like any real write. */
    rawUpdateMessage: (uid: string, fields: Record<string, any>) => Promise<void>;
    /** Every audit log entry about `targetUid`. */
    auditEntries: (targetUid: string) => Promise<any[]>;
    blobStore: () => InMemoryBlobStore;
    spam: () => AlwaysCleanSpamScanProvider;
    /** Turns the route's `mail:scan:spam:learn:enabled` on or off. */
    setLearnEnabled: (enabled: boolean) => void;
}

export function messageReportSuite(ctx: MessageReportSuiteContext): void {
    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const manager: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const delegate: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const reader: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const updaterOnly: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const stranger: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };

    const RAW = (from: string = "Ann <ann@sender.example>"): Buffer =>
        Buffer.from(`From: ${from}\r\nTo: owner@example.com\r\nSubject: Cheap pills\r\nMessage-ID: <${uuid.v4()}@sender.example>\r\n\r\nBuy now.\r\n`);

    /** A mailbox with an Inbox (holding a message) and, unless `junk` is `false`, a Junk Email folder; the message's source is in the blob store. */
    const setup = async (options: { type?: FolderType; junk?: boolean; fields?: Record<string, any>; raw?: Buffer | false; mailboxFields?: Record<string, any> } = {}) => {
        const mailbox = await ctx.saveMailbox(owner.uid, options.mailboxFields, [{ userOrRoleId: manager.uid, actions: [ACLAction.FULL] }]);
        const records = [
            { userOrRoleId: manager.uid, actions: [ACLAction.FULL] },
            { userOrRoleId: delegate.uid, actions: [ACLAction.READ, ACLAction.UPDATE] },
            { userOrRoleId: reader.uid, actions: [ACLAction.READ] },
            { userOrRoleId: updaterOnly.uid, actions: [ACLAction.UPDATE] },
            // A trusted caller has no implicit access to a mailbox: an administrator who reports holds an explicit grant.
            { userOrRoleId: admin.uid, actions: [ACLAction.FULL] },
        ];
        const folder = await ctx.saveFolder(mailbox.uid, options.type ?? FolderType.INBOX, records);
        const junk = options.junk === false ? undefined : await ctx.saveFolder(mailbox.uid, FolderType.JUNK, records);
        const bodyBlobKey = `bodies/${uuid.v4()}`;
        if (options.raw !== false) {
            await ctx.blobStore().put(bodyBlobKey, options.raw ?? RAW());
        }
        const message = await ctx.saveMessage({
            mailboxUid: mailbox.uid,
            folderUid: folder.uid,
            messageId: `${uuid.v4()}@example.com`,
            subject: "Cheap pills",
            from: { address: "envelope@sender.example", displayName: "Ann", type: RecipientType.TO },
            recipients: [{ address: "owner@example.com", type: RecipientType.TO }],
            sentDate: new Date(),
            receivedDate: new Date(),
            bodyBlobKey,
            bodyPreview: "Buy now.",
            flags: { read: false, flagged: false, answered: false, forwarded: false },
            importance: MessageImportance.NORMAL,
            references: [],
            hasAttachments: false,
            ...options.fields,
        });
        return { mailbox, folder, junk, message };
    };
    const report = (uid: string, body: any, user: any = owner) => {
        const req = request(ctx.app()).post(`${ctx.baseUrl}/${uid}/report`).set("Authorization", "jwt " + ctx.tokenFor(user));
        return body === undefined ? req : req.send(body);
    };
    /** Makes the next `RepoUtils.update()` run `interleave()` first - a concurrent write between the route's read and write. */
    const interleaveNextUpdate = (interleave: () => Promise<void>): void => {
        const original = RepoUtils.prototype.update;
        vi.spyOn(RepoUtils.prototype, "update").mockImplementationOnce(async function (this: any, ...args: any[]) {
            await interleave();
            return await (original as any).apply(this, args);
        });
    };

    beforeEach(() => {
        ctx.spam().learned = [];
        ctx.spam().learnError = undefined;
        ctx.setLearnEnabled(true);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("junk", () => {
        it("Moves the message to the mailbox's Junk Email folder, records the report, and teaches the spam filter the raw message as spam.", async () => {
            const { mailbox, junk, message } = await setup();

            const res = await report(message.uid, { kind: "junk" });

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ uid: message.uid, kind: "junk", moved: true, folderUid: junk.uid, learned: true });
            const row = await ctx.findMessage(message.uid);
            expect(row.folderUid).toBe(junk.uid);
            expect(row.reportedAs).toBe("junk");
            expect(new Date(row.dateReported).getTime()).toBeGreaterThan(Date.now() - 60_000);
            expect(ctx.spam().learned).toHaveLength(1);
            expect(ctx.spam().learned[0].kind).toBe("spam");
            expect(ctx.spam().learned[0].raw.toString()).toContain("Subject: Cheap pills");
            // The mailbox the report came from, for an engine that keeps statistics per user.
            expect(ctx.spam().learned[0].options).toEqual({ recipient: mailbox.primarySmtpAddress });
        });

        it("Creates the Junk Email folder when the mailbox has none.", async () => {
            const { mailbox, message } = await setup({ junk: false });

            const res = await report(message.uid, { kind: "junk" });

            expect(res.status).toBe(200);
            expect(await ctx.countFolders(mailbox.uid, FolderType.JUNK)).toBe(1);
            expect((await ctx.findMessage(message.uid)).folderUid).toBe(res.body.folderUid);
        });

        it("Is not a move for a message that is already in Junk Email - but still records the report and teaches the filter.", async () => {
            const { junk, message } = await setup({ junk: true });
            await ctx.rawUpdateMessage(message.uid, { folderUid: junk.uid });

            const res = await report(message.uid, { kind: "junk" });

            expect(res.body).toMatchObject({ moved: false, folderUid: junk.uid, learned: true });
            expect((await ctx.findMessage(message.uid)).reportedAs).toBe("junk");
            expect(ctx.spam().learned).toHaveLength(1);
        });

        it("Is idempotent: reporting again moves nothing, and answers the same.", async () => {
            const { message } = await setup();

            const first = await report(message.uid, { kind: "junk" });
            const second = await report(message.uid, { kind: "junk" });

            expect(first.body.moved).toBe(true);
            expect(second.status).toBe(200);
            expect(second.body).toEqual({ ...first.body, moved: false });
            expect(await ctx.auditEntries(message.uid)).toHaveLength(2);
        });

        it("Leaves the search index to be redone for the moved message and keeps its other fields.", async () => {
            const { message } = await setup({ fields: { searchIndexedAt: new Date(), flags: { read: true, flagged: true, answered: false, forwarded: false } } });

            await report(message.uid, { kind: "junk" });

            const row = await ctx.findMessage(message.uid);
            expect(row.searchIndexedAt ?? null).toBeNull();
            expect(row.flags).toMatchObject({ read: true, flagged: true });
            expect(row.subject).toBe("Cheap pills");
        });

        it("Retries when an unrelated write wins the optimistic lock (the client marking the message read at the same moment).", async () => {
            const { junk, message } = await setup();
            interleaveNextUpdate(() => ctx.rawUpdateMessage(message.uid, { flags: { read: true, flagged: false, answered: false, forwarded: false } }));

            const res = await report(message.uid, { kind: "junk" });

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ moved: true, folderUid: junk.uid });
            const row = await ctx.findMessage(message.uid);
            expect(row.folderUid).toBe(junk.uid);
            expect(row.flags.read).toBe(true);
        });

        it("Notices when the retry finds the message already moved by the concurrent write.", async () => {
            const { junk, message } = await setup();
            interleaveNextUpdate(() => ctx.rawUpdateMessage(message.uid, { folderUid: junk.uid }));

            const res = await report(message.uid, { kind: "junk" });

            expect(res.status).toBe(200);
            expect(res.body.moved).toBe(false);
        });

        it("Answers 404 when the message is deleted between the read and the write.", async () => {
            const { message } = await setup();
            interleaveNextUpdate(() => ctx.rawUpdateMessage(message.uid, { deleted: true }));

            const res = await report(message.uid, { kind: "junk" });

            expect(res.status).toBe(404);
        });
    });

    describe("phishing", () => {
        it("Moves the message to Junk Email, teaches the filter it is spam, and audits it as a phishing report.", async () => {
            const { mailbox, junk, message } = await setup();

            const res = await report(message.uid, { kind: "phishing" });

            expect(res.body).toEqual({ uid: message.uid, kind: "phishing", moved: true, folderUid: junk.uid, learned: true });
            expect((await ctx.findMessage(message.uid)).reportedAs).toBe("phishing");
            expect(ctx.spam().learned.map((lesson) => lesson.kind)).toEqual(["spam"]);
            const entries = await ctx.auditEntries(message.uid);
            expect(entries).toHaveLength(1);
            expect(entries[0]).toMatchObject({
                action: AuditAction.MESSAGE_REPORTED,
                targetType: "Message",
                targetUid: message.uid,
                mailboxUid: mailbox.uid,
                actorUserUid: owner.uid,
            });
            expect(entries[0].details).toEqual({
                kind: "phishing",
                from: "envelope@sender.example",
                moved: true,
                folderUid: junk.uid,
                learned: true,
                alwaysTrustSender: false,
            });
        });
    });

    describe("not_junk", () => {
        it("Moves the message from Junk Email to the Inbox and teaches the filter it is ham.", async () => {
            const { folder, junk, message } = await setup();
            await ctx.rawUpdateMessage(message.uid, { folderUid: junk.uid, reportedAs: "junk" });

            const res = await report(message.uid, { kind: "not_junk" });

            expect(res.body).toEqual({ uid: message.uid, kind: "not_junk", moved: true, folderUid: folder.uid, learned: true });
            const row = await ctx.findMessage(message.uid);
            expect(row.folderUid).toBe(folder.uid);
            expect(row.reportedAs).toBe("not_junk");
            expect(ctx.spam().learned.map((lesson) => lesson.kind)).toEqual(["ham"]);
        });

        it("Creates the Inbox when the mailbox has none, and does not move a message that is already there.", async () => {
            const stay = await setup();
            const res = await report(stay.message.uid, { kind: "not_junk" });
            expect(res.body).toMatchObject({ moved: false, folderUid: stay.folder.uid, learned: true });

            const noInbox = await setup({ type: FolderType.ARCHIVE });
            const created = await report(noInbox.message.uid, { kind: "not_junk" });
            expect(created.body.moved).toBe(true);
            expect(await ctx.countFolders(noInbox.mailbox.uid, FolderType.INBOX)).toBe(1);
        });

        it("With alwaysTrustSender, adds the From header's address (not the envelope's) to the safe senders and takes it off the blocked list.", async () => {
            const { message, mailbox } = await setup({ mailboxFields: { blockedSenders: ["ann@sender.example", "other@x.example"], safeSenders: [] } });

            const res = await report(message.uid, { kind: "not_junk", alwaysTrustSender: true });

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ kind: "not_junk", learned: true, safeSender: "ann@sender.example" });
            const row = await ctx.findMailbox(mailbox.uid);
            expect(row.safeSenders).toEqual(["ann@sender.example"]);
            expect(row.blockedSenders).toEqual(["other@x.example"]);
            expect((await ctx.auditEntries(message.uid))[0].details.alwaysTrustSender).toBe(true);
        });

        it("Does not add anybody without alwaysTrustSender, or with it false.", async () => {
            const { message, mailbox } = await setup();

            await report(message.uid, { kind: "not_junk" });
            await report(message.uid, { kind: "not_junk", alwaysTrustSender: false });

            expect((await ctx.findMailbox(mailbox.uid)).safeSenders ?? []).toEqual([]);
        });

        it("Falls back to the message's own from address when the source names no usable From, and adds nobody when neither does.", async () => {
            const noHeader = await setup({ raw: Buffer.from("Subject: no from\r\n\r\nbody\r\n"), fields: { from: { address: "envelope@sender.example", type: RecipientType.TO } } });
            const fallback = await report(noHeader.message.uid, { kind: "not_junk", alwaysTrustSender: true });
            expect(fallback.body.safeSender).toBe("envelope@sender.example");

            const nobody = await setup({ raw: Buffer.from("Subject: no from\r\n\r\nbody\r\n"), fields: { from: { address: "", type: RecipientType.TO } } });
            const none = await report(nobody.message.uid, { kind: "not_junk", alwaysTrustSender: true });
            expect(none.status).toBe(200);
            expect(none.body.safeSender).toBeUndefined();
            expect((await ctx.findMailbox(nobody.mailbox.uid)).safeSenders ?? []).toEqual([]);
        });

        it("Refuses (403) alwaysTrustSender from a delegate who lacks full access - before moving anything or teaching the filter.", async () => {
            const { folder, message, mailbox } = await setup();

            const res = await report(message.uid, { kind: "not_junk", alwaysTrustSender: true }, delegate);

            expect(res.status).toBe(403);
            expect((await ctx.findMessage(message.uid)).folderUid).toBe(folder.uid);
            expect(ctx.spam().learned).toHaveLength(0);
            expect((await ctx.findMailbox(mailbox.uid)).safeSenders ?? []).toEqual([]);
            expect(await ctx.auditEntries(message.uid)).toHaveLength(0);
        });

        it("Lets a full-access delegate use alwaysTrustSender.", async () => {
            const { message, mailbox } = await setup();

            const res = await report(message.uid, { kind: "not_junk", alwaysTrustSender: true }, manager);

            expect(res.body.safeSender).toBe("ann@sender.example");
            expect((await ctx.findMailbox(mailbox.uid)).safeSenders).toEqual(["ann@sender.example"]);
        });

        it("Reads a From header from the start of a message too large to learn, and still reports it as not learned.", async () => {
            const raw = Buffer.concat([RAW("Big <big@sender.example>"), Buffer.alloc(MAX_REPORT_LEARN_BYTES + 10, "x")]);
            const { message, mailbox } = await setup({ raw });

            const res = await report(message.uid, { kind: "not_junk", alwaysTrustSender: true });

            expect(res.body).toMatchObject({ learned: false, learnSkipped: "too_large", safeSender: "big@sender.example" });
            expect((await ctx.findMailbox(mailbox.uid)).safeSenders).toEqual(["big@sender.example"]);
            expect(ctx.spam().learned).toHaveLength(0);
        });

        it("Falls back to the message's own address when the source cannot be read at all.", async () => {
            const { message } = await setup({ raw: false });

            const res = await report(message.uid, { kind: "not_junk", alwaysTrustSender: true });

            expect(res.body).toMatchObject({ learned: false, learnSkipped: "failed", safeSender: "envelope@sender.example" });
        });

        it("Refuses (400) alwaysTrustSender for junk and phishing reports, and a value that is not a boolean.", async () => {
            const { message } = await setup();

            expect((await report(message.uid, { kind: "junk", alwaysTrustSender: true })).status).toBe(400);
            expect((await report(message.uid, { kind: "phishing", alwaysTrustSender: true })).status).toBe(400);
            expect((await report(message.uid, { kind: "not_junk", alwaysTrustSender: "yes" })).status).toBe(400);
            expect((await ctx.findMessage(message.uid)).reportedAs ?? null).toBeNull();
            // false is harmless for any kind.
            expect((await report(message.uid, { kind: "junk", alwaysTrustSender: false })).status).toBe(200);
        });
    });

    describe("teaching the spam filter", () => {
        it("Still moves the message when the filter fails, reporting learned: false and why - and audits that.", async () => {
            const { junk, message } = await setup();
            ctx.spam().learnError = new Error("rspamd controller returned HTTP 403");

            const res = await report(message.uid, { kind: "junk" });

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ uid: message.uid, kind: "junk", moved: true, folderUid: junk.uid, learned: false, learnSkipped: "failed" });
            expect((await ctx.findMessage(message.uid)).folderUid).toBe(junk.uid);
            const details = (await ctx.auditEntries(message.uid))[0].details;
            expect(details).toMatchObject({ learned: false, learnSkipped: "failed", moved: true });
        });

        it("Never reads or teaches an encrypted message the server cannot read, and says so.", async () => {
            const { junk, message } = await setup({ fields: { encrypted: true } });
            const get = vi.spyOn(ctx.blobStore(), "get");

            const res = await report(message.uid, { kind: "junk" });

            expect(res.body).toEqual({ uid: message.uid, kind: "junk", moved: true, folderUid: junk.uid, learned: false, learnSkipped: "encrypted" });
            expect(get).not.toHaveBeenCalled();
            expect(ctx.spam().learned).toHaveLength(0);
        });

        it("Reads an encrypted message's From header for alwaysTrustSender, and still teaches nothing.", async () => {
            const { message } = await setup({ fields: { encrypted: true } });

            const res = await report(message.uid, { kind: "not_junk", alwaysTrustSender: true });

            expect(res.body).toMatchObject({ learned: false, learnSkipped: "encrypted", safeSender: "ann@sender.example" });
            expect(ctx.spam().learned).toHaveLength(0);
        });

        it("Teaches nothing when learning is turned off (disabled), and moves anyway.", async () => {
            const { junk, message } = await setup();
            ctx.setLearnEnabled(false);

            const res = await report(message.uid, { kind: "junk" });

            expect(res.body).toEqual({ uid: message.uid, kind: "junk", moved: true, folderUid: junk.uid, learned: false, learnSkipped: "disabled" });
            expect(ctx.spam().learned).toHaveLength(0);
        });

        it("Reports unsupported for an engine that cannot learn.", async () => {
            const { message } = await setup();
            const provider: any = ctx.spam();
            const learn = provider.learn;
            provider.learn = undefined;
            try {
                const res = await report(message.uid, { kind: "junk" });

                expect(res.body).toMatchObject({ moved: true, learned: false, learnSkipped: "unsupported" });
            } finally {
                provider.learn = learn;
            }
        });

        it("Does not read a message over the size bound, and says too_large - the move still happens.", async () => {
            const { junk, message } = await setup({ raw: Buffer.alloc(MAX_REPORT_LEARN_BYTES + 1, "x") });

            const res = await report(message.uid, { kind: "junk" });

            expect(res.body).toEqual({ uid: message.uid, kind: "junk", moved: true, folderUid: junk.uid, learned: false, learnSkipped: "too_large" });
            expect(ctx.spam().learned).toHaveLength(0);
        });

        it("Teaches a message of exactly the size bound.", async () => {
            const { message } = await setup({ raw: Buffer.alloc(MAX_REPORT_LEARN_BYTES, "x") });

            const res = await report(message.uid, { kind: "junk" });

            expect(res.body.learned).toBe(true);
            expect(ctx.spam().learned[0].raw).toHaveLength(MAX_REPORT_LEARN_BYTES);
        });

        it("Reports failed, and still moves, when the message's source cannot be read.", async () => {
            const { junk, message } = await setup({ raw: false });

            const res = await report(message.uid, { kind: "junk" });

            expect(res.body).toEqual({ uid: message.uid, kind: "junk", moved: true, folderUid: junk.uid, learned: false, learnSkipped: "failed" });
        });
    });

    describe("who may report, and what", () => {
        it("Refuses (400) a kind that is missing or is not one of the three, and a missing body.", async () => {
            const { folder, message } = await setup();

            for (const body of [undefined, {}, { kind: "spam" }, { kind: "Junk" }, { kind: 7 }, { kind: ["junk"] }, { kind: null }]) {
                const res = await report(message.uid, body);
                expect(res.status, JSON.stringify(body)).toBe(400);
            }
            expect((await ctx.findMessage(message.uid)).folderUid).toBe(folder.uid);
            expect(ctx.spam().learned).toHaveLength(0);
        });

        it("Answers 404 for a message that does not exist.", async () => {
            await setup();

            expect((await report(uuid.v4(), { kind: "junk" })).status).toBe(404);
        });

        it("Answers 403 to a caller without both read and update access on the message's folder - and changes nothing.", async () => {
            const { folder, message } = await setup();

            for (const [name, user] of [
                ["stranger", stranger],
                ["reader", reader],
                ["updaterOnly", updaterOnly],
            ] as [string, any][]) {
                const res = await report(message.uid, { kind: "junk" }, user);
                expect(res.status, name).toBe(403);
            }
            expect((await ctx.findMessage(message.uid)).folderUid).toBe(folder.uid);
            expect(ctx.spam().learned).toHaveLength(0);
            expect(await ctx.auditEntries(message.uid)).toHaveLength(0);
        });

        it("Lets a delegate with read and update access, and a full-access delegate, report - a trusted role is not a grant.", async () => {
            const a = await setup();
            const b = await setup();
            const c = await setup();

            expect((await report(a.message.uid, { kind: "junk" }, delegate)).status).toBe(200);
            expect((await report(b.message.uid, { kind: "junk" }, manager)).status).toBe(200);
            expect((await report(c.message.uid, { kind: "junk" }, admin)).status).toBe(200);
        });

        it("Answers 403 to an administrator who holds no grant on the mailbox.", async () => {
            const { message } = await setup();
            const roleOnly: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };

            expect((await report(message.uid, { kind: "junk" }, roleOnly)).status).toBe(403);
        });

        it("Answers 403 to a caller who is not signed in, like every other message route, and changes nothing.", async () => {
            const { folder, message } = await setup();

            const res = await request(ctx.app()).post(`${ctx.baseUrl}/${message.uid}/report`).send({ kind: "junk" });

            expect(res.status).toBe(403);
            expect((await ctx.findMessage(message.uid)).folderUid).toBe(folder.uid);
        });

        it("Refuses (400) a message in Drafts or Outbox, and moves nothing.", async () => {
            for (const type of [FolderType.DRAFTS, FolderType.OUTBOX]) {
                const { folder, message } = await setup({ type });

                const res = await report(message.uid, { kind: "junk" });

                expect(res.status, type).toBe(400);
                expect((await ctx.findMessage(message.uid)).folderUid).toBe(folder.uid);
            }
        });

        it("Accepts a report of a message in Sent Items, Archive or Deleted Items.", async () => {
            for (const type of [FolderType.SENT_ITEMS, FolderType.ARCHIVE, FolderType.DELETED_ITEMS]) {
                const { message } = await setup({ type });

                expect((await report(message.uid, { kind: "junk" })).status, type).toBe(200);
            }
        });

        it("Keeps reportedAs and dateReported server-managed: no update can set them.", async () => {
            const { folder, message } = await setup();

            const res = await request(ctx.app())
                .put(`${ctx.baseUrl}/${message.uid}`)
                .set("Authorization", "jwt " + ctx.tokenFor(owner))
                .send({ uid: message.uid, version: (await ctx.findMessage(message.uid)).version, reportedAs: "phishing", dateReported: new Date().toISOString(), subject: "Edited" });

            expect(res.status).toBe(200);
            const row = await ctx.findMessage(message.uid);
            expect(row.subject).toBe("Edited");
            expect(row.reportedAs ?? null).toBeNull();
            expect(row.dateReported ?? null).toBeNull();
            expect(row.folderUid).toBe(folder.uid);
        });
    });
}
