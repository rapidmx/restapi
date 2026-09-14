///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Round-4 review fixes for the mail/mailbox/scoped-child/folder/attachment/message/label routes, identical on both
// backends. `test/routes/{mongo,sql}/MailAuthzRound4.test.ts` supply a started server and raw row helpers; everything
// under test goes through HTTP.
import { request } from "@rapidrest/service-core/test";
import * as uuid from "uuid";
import { FolderType, MessageImportance, RecipientType } from "../../src/models/types.js";
import type { InMemoryBlobStore, RecordingMailTransport } from "../testDoubles.js";

/** Row kinds `save()`/`findOne()` accept - each maps to the backend's concrete model class. */
export type Round4RowKind =
    | "Mailbox"
    | "Folder"
    | "Message"
    | "Attachment"
    | "Matter"
    | "Label"
    | "CalendarShareLink"
    | "Task"
    | "DistributionList"
    | "TransportRule"
    | "FocusedInboxOverride"
    | "MailFilterRule";

export interface MailAuthzRound4SuiteContext {
    app: () => any;
    /** `"/mongo"` or `"/sql"`. */
    prefix: string;
    tokenFor: (user: any) => string;
    /** Saves a raw row (bypassing every route), returning it as stored. */
    save: (kind: Round4RowKind, fields: Record<string, any>) => Promise<any>;
    /** The stored row, raw (a Mongo document includes `_id`). */
    findOne: (kind: Round4RowKind, uid: string) => Promise<any | undefined>;
    count: (kind: Round4RowKind) => Promise<number>;
    /** Sets fields on a stored row directly. */
    update: (kind: Round4RowKind, uid: string, fields: Record<string, any>) => Promise<void>;
    saveAcl: (acl: { uid: string; parentUid?: string; records: { userOrRoleId: string; actions: string[] }[] }) => Promise<void>;
    findAcl: (uid: string) => Promise<any | undefined>;
    blobStore: () => InMemoryBlobStore;
    transport: () => RecordingMailTransport;
}

export function mailAuthzRound4Suite(ctx: MailAuthzRound4SuiteContext): void {
    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const other: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const auth = (req: any, user: any) => req.set("Authorization", "jwt " + ctx.tokenFor(user));
    const url = (path: string) => `${ctx.prefix}${path}`;
    const isMongo: boolean = ctx.prefix === "/mongo";

    const createMailbox = async (ownerUid: string, fields: Record<string, any> = {}) => {
        const mailbox = await ctx.save("Mailbox", {
            ownerUserUid: ownerUid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Test Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
            ...fields,
        });
        await ctx.saveAcl({ uid: mailbox.uid, parentUid: "Mailbox", records: [{ userOrRoleId: ownerUid, actions: ["*"] }] });
        return mailbox;
    };
    const createFolder = async (mailboxUid: string, type: FolderType = FolderType.INBOX) => {
        const folder = await ctx.save("Folder", { mailboxUid, name: type, type, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 });
        await ctx.saveAcl({ uid: folder.uid, parentUid: mailboxUid, records: [] });
        return folder;
    };
    const createMessage = (mailbox: any, folderUid: string, fields: Record<string, any> = {}) =>
        ctx.save("Message", {
            mailboxUid: mailbox.uid,
            folderUid,
            messageId: `${uuid.v4()}@example.com`,
            subject: "Subject",
            from: { address: mailbox.primarySmtpAddress, type: RecipientType.TO },
            recipients: [{ address: "recipient@example.net", type: RecipientType.TO }],
            sentDate: new Date(),
            receivedDate: new Date(),
            bodyBlobKey: `bodies/${uuid.v4()}`,
            bodyPreview: "Hello",
            flags: { read: false, flagged: false, answered: false, forwarded: false },
            importance: MessageImportance.NORMAL,
            references: [],
            hasAttachments: false,
            ...fields,
        });
    const draftBody = (fields: Record<string, any>) => ({
        subject: "Draft",
        recipients: [],
        bodyPreview: "Draft preview",
        flags: { read: false, flagged: false, answered: false, forwarded: false },
        importance: "normal",
        references: [],
        hasAttachments: false,
        messageId: `${uuid.v4()}@example.com`,
        bodyBlobKey: `bodies/${uuid.v4()}`,
        ...fields,
    });
    /** A draft whose stored MIME source has `headers` (default: `From: <mailbox address>`). */
    const sendableDraft = async (mailbox: any, drafts: any, headers?: string, fields: Record<string, any> = {}) => {
        const bodyBlobKey = `bodies/${uuid.v4()}`;
        await ctx
            .blobStore()
            .put(bodyBlobKey, Buffer.from(`${headers ?? `From: ${mailbox.primarySmtpAddress}`}\r\nTo: recipient@example.net\r\nSubject: hi\r\n\r\nhello`));
        return createMessage(mailbox, drafts.uid, { bodyBlobKey, ...fields });
    };
    /** A stand-in `_id` value: the victim's real one on Mongo, an unused one on SQL (which has no `_id`). */
    const idOf = (row: any): string => (row?._id !== undefined ? String(row._id) : "0123456789abcdef01234567");

    describe("client _id, version and dates on create (finding 1)", () => {
        it("a message created with another message's _id leaves that message untouched, single or bulk", async () => {
            const victimMailbox = await createMailbox(other.uid);
            const victimInbox = await createFolder(victimMailbox.uid);
            const victim = await createMessage(victimMailbox, victimInbox.uid, { subject: "Victim" });
            const victimRaw = await ctx.findOne("Message", victim.uid);

            const mine = await createMailbox(owner.uid);
            const drafts = await createFolder(mine.uid, FolderType.DRAFTS);
            const body = () =>
                draftBody({
                    _id: idOf(victimRaw),
                    version: 7,
                    dateCreated: "2001-01-01T00:00:00.000Z",
                    dateModified: "2001-01-01T00:00:00.000Z",
                    "flags.read": true,
                    folderUid: drafts.uid,
                    mailboxUid: mine.uid,
                    subject: "Overwrite",
                    from: { address: mine.primarySmtpAddress, type: "to" },
                });
            const before: number = await ctx.count("Message");
            const single = await auth(request(ctx.app()).post(url("/messages")), owner).send(body());
            expect(single.status).toBe(200);
            expect(single.body.version).toBe(0);
            expect(new Date(single.body.dateCreated).getFullYear()).toBeGreaterThan(2001);
            const bulk = await auth(request(ctx.app()).post(url("/messages")), owner).send([body()]);
            expect(bulk.status).toBe(200);

            const after = await ctx.findOne("Message", victim.uid);
            expect(after).toBeDefined();
            expect(after.subject).toBe("Victim");
            expect(after.folderUid).toBe(victimInbox.uid);
            expect(await ctx.count("Message")).toBe(before + 2);
        });

        it("folders, labels, mailboxes, distribution lists and transport rules ignore a client _id", async () => {
            const victimMailbox = await createMailbox(other.uid);
            const victimFolder = await createFolder(victimMailbox.uid, FolderType.USER);
            const victimLabel = await ctx.save("Label", { mailboxUid: victimMailbox.uid, name: "theirs" });
            const victimList = await ctx.save("DistributionList", {
                name: "Victim list",
                primarySmtpAddress: `${uuid.v4()}@example.com`,
                aliasAddresses: [],
                memberAddresses: ["a@example.com"],
            });
            const victimRule = await ctx.save("TransportRule", {
                name: "Victim rule",
                enabled: false,
                sequence: 0,
                stopProcessingRules: false,
                conditions: {},
                actions: [],
            });
            const mine = await createMailbox(owner.uid);

            const folder = await auth(request(ctx.app()).post(url("/folders")), owner).send({
                _id: idOf(await ctx.findOne("Folder", victimFolder.uid)),
                mailboxUid: mine.uid,
                name: "Mine",
                type: FolderType.USER,
            });
            expect(folder.status).toBe(200);
            const label = await auth(request(ctx.app()).post(url("/labels")), owner).send({
                _id: idOf(await ctx.findOne("Label", victimLabel.uid)),
                mailboxUid: mine.uid,
                name: "mine",
            });
            expect(label.status).toBe(200);
            const mailbox = await auth(request(ctx.app()).post(url("/mailboxes")), admin).send({
                _id: idOf(await ctx.findOne("Mailbox", victimMailbox.uid)),
                primarySmtpAddress: `${uuid.v4()}@example.com`,
                displayName: "Admin-made",
                timezone: "UTC",
            });
            expect(mailbox.status).toBe(200);
            const list = await auth(request(ctx.app()).post(url("/distribution-lists")), admin).send({
                _id: idOf(await ctx.findOne("DistributionList", victimList.uid)),
                name: "New list",
                primarySmtpAddress: `${uuid.v4()}@example.com`,
                aliasAddresses: [],
                memberAddresses: [],
            });
            expect(list.status).toBe(200);
            const rule = await auth(request(ctx.app()).post(url("/transport-rules")), admin).send({
                _id: idOf(await ctx.findOne("TransportRule", victimRule.uid)),
                name: "New rule",
                enabled: false,
                sequence: 1,
                stopProcessingRules: false,
                conditions: {},
                actions: [],
            });
            expect(rule.status).toBe(200);

            expect((await ctx.findOne("Folder", victimFolder.uid))?.mailboxUid).toBe(victimMailbox.uid);
            expect((await ctx.findOne("Label", victimLabel.uid))?.name).toBe("theirs");
            expect((await ctx.findOne("Mailbox", victimMailbox.uid))?.displayName).toBe("Test Mailbox");
            expect((await ctx.findOne("DistributionList", victimList.uid))?.name).toBe("Victim list");
            expect((await ctx.findOne("TransportRule", victimRule.uid))?.name).toBe("Victim rule");
        });
    });

    describe("dotted and $ keys in update bodies (finding 2)", () => {
        it("are refused on mailboxes, messages, folders, filter rules and transport rules, and as a property name", async () => {
            const mailbox = await createMailbox(owner.uid, { aliasAddresses: ["first@example.com"] });
            const inbox = await createFolder(mailbox.uid);
            const message = await createMessage(mailbox, inbox.uid);
            const put = (user: any, path: string, body: any) => auth(request(ctx.app()).put(url(path)), user).send(body);

            expect((await put(owner, `/mailboxes/${mailbox.uid}`, { uid: mailbox.uid, version: mailbox.version, "aliasAddresses.0": "ceo@example.com" })).status).toBe(400);
            expect((await put(owner, `/mailboxes/${mailbox.uid}`, { uid: mailbox.uid, version: mailbox.version, "keys.0": { useType: "encrypt" } })).status).toBe(400);
            expect((await put(owner, `/mailboxes/${mailbox.uid}/aliasAddresses.0`, "ceo@example.com")).status).toBe(400);
            expect((await put(owner, `/mailboxes`, [{ uid: mailbox.uid, version: mailbox.version, "aliasAddresses.0": "ceo@example.com" }])).status).toBe(400);
            expect((await put(owner, `/messages/${message.uid}`, { uid: message.uid, version: message.version, "receiptStatus.0": { recipientAddress: "x" } })).status).toBe(400);
            expect((await put(owner, `/messages/${message.uid}`, { uid: message.uid, version: message.version, $set: { bodyBlobKey: "x" } })).status).toBe(400);
            expect((await put(owner, `/messages/${message.uid}/receiptStatus.0`, { recipientAddress: "x" })).status).toBe(400);
            expect((await put(owner, `/messages`, [{ uid: message.uid, version: message.version, "flags.read": true }])).status).toBe(400);
            expect((await put(owner, `/folders/${inbox.uid}`, { uid: inbox.uid, version: inbox.version, "unreadCount.x": 5 })).status).toBe(400);
            expect((await put(owner, `/folders/${inbox.uid}/name.x`, "n")).status).toBe(400);

            const rule = await ctx.save("MailFilterRule", {
                mailboxUid: mailbox.uid,
                name: "Rule",
                enabled: true,
                sequence: 1,
                stopProcessingRules: false,
                conditions: { fromContains: ["x"] },
                actions: [{ type: "apply_label", labelUid: "" }],
            });
            expect((await put(owner, `/mail-filter-rules/${rule.uid}`, { uid: rule.uid, version: rule.version, "actions.0.labelUid": "victim-label" })).status).toBe(400);

            const transportRule = await ctx.save("TransportRule", { name: "TR", enabled: false, sequence: 0, stopProcessingRules: false, conditions: {}, actions: [] });
            expect((await put(admin, `/transport-rules/${transportRule.uid}`, { uid: transportRule.uid, version: transportRule.version, "conditions.x": 1 })).status).toBe(400);
            expect((await put(admin, `/transport-rules/${transportRule.uid}/conditions.x`, 1)).status).toBe(400);

            expect((await ctx.findOne("Mailbox", mailbox.uid))?.aliasAddresses).toEqual(["first@example.com"]);
            expect((await ctx.findOne("Message", message.uid))?.receiptStatus ?? undefined).toBeUndefined();
        });
    });

    describe("scheduled sends and Outbox (finding 3)", () => {
        it("scheduledSendTime and moves into Outbox are only the send path's", async () => {
            const mailbox = await createMailbox(owner.uid);
            const drafts = await createFolder(mailbox.uid, FolderType.DRAFTS);
            const outbox = await createFolder(mailbox.uid, FolderType.OUTBOX);
            const draft = await sendableDraft(mailbox, drafts);
            const future = new Date(Date.now() + 3_600_000).toISOString();

            const setTime = await auth(request(ctx.app()).put(url(`/messages/${draft.uid}`)), owner).send({ uid: draft.uid, version: draft.version, scheduledSendTime: future });
            expect(setTime.status).toBe(400);
            const intoOutbox = await auth(request(ctx.app()).put(url(`/messages/${draft.uid}`)), owner).send({ uid: draft.uid, version: draft.version, folderUid: outbox.uid });
            expect(intoOutbox.status).toBe(403);
            const createdInOutbox = await auth(request(ctx.app()).post(url("/messages")), owner).send(
                draftBody({ folderUid: outbox.uid, mailboxUid: mailbox.uid, from: { address: mailbox.primarySmtpAddress, type: "to" } }),
            );
            expect(createdInOutbox.status).toBe(403);
            const invalidTime = await auth(request(ctx.app()).post(url(`/messages/${draft.uid}/send`)), owner).send({ scheduledSendTime: "soon" });
            expect(invalidTime.status).toBe(400);

            const scheduled = await auth(request(ctx.app()).post(url(`/messages/${draft.uid}/send`)), owner).send({ scheduledSendTime: future });
            expect(scheduled.status).toBe(200);
            expect(scheduled.body.folderUid).toBe(outbox.uid);
            expect(new Date(scheduled.body.scheduledSendTime).toISOString()).toBe(future);
            expect(ctx.transport().sent).toHaveLength(0);
            const stored = await ctx.findOne("Message", draft.uid);
            expect(new Date(stored.scheduledSendTime).toISOString()).toBe(future);
            if (isMongo) {
                expect(stored.scheduledSendTime).toBeInstanceOf(Date);
            }

            // Queued already: no second send until it's moved back out.
            expect((await auth(request(ctx.app()).post(url(`/messages/${draft.uid}/send`)), owner)).status).toBe(409);
            // A full round trip of the queued message (unchanged time) still saves.
            const roundTrip = await auth(request(ctx.app()).put(url(`/messages/${draft.uid}`)), owner).send({
                uid: draft.uid,
                version: scheduled.body.version,
                scheduledSendTime: scheduled.body.scheduledSendTime,
                flags: { ...scheduled.body.flags, flagged: true },
            });
            expect(roundTrip.status).toBe(200);
            // Moving it back to Drafts cancels it, as react-shared's cancelScheduledSend() does.
            const cancel = await auth(request(ctx.app()).put(url(`/messages/${draft.uid}`)), owner).send({
                uid: draft.uid,
                version: roundTrip.body.version,
                scheduledSendTime: null,
                folderUid: drafts.uid,
            });
            expect(cancel.status).toBe(200);
            expect(cancel.body.scheduledSendTime ?? null).toBeNull();
        });

        it("checks every From/Sender header of the stored source before scheduling or sending", async () => {
            const mailbox = await createMailbox(owner.uid);
            const drafts = await createFolder(mailbox.uid, FolderType.DRAFTS);
            const own: string = mailbox.primarySmtpAddress;
            const future = new Date(Date.now() + 3_600_000).toISOString();
            const spoofs: string[] = [
                `From: CEO <ceo@example.com>`,
                `From: ${own}\r\nFrom: ceo@example.com`,
                `From: ${own}\r\nSender: ceo@example.com`,
                `From: ${own}\r\nSender: ${own}\r\nSender: ${own}`,
                `From: "ceo@example.com" <${own}>`,
                `From: ${own} (ceo@example.com)`,
                `From: =?utf-8?q?ceo=40example.com?= <${own}>`,
                `From: <${own}> <ceo@example.com>`,
                `To: nobody@example.net`,
            ];
            for (const headers of spoofs) {
                const draft = await sendableDraft(mailbox, drafts, headers);
                const later = await auth(request(ctx.app()).post(url(`/messages/${draft.uid}/send`)), owner).send({ scheduledSendTime: future });
                expect({ headers, status: later.status }).toEqual({ headers, status: 403 });
                const now = await auth(request(ctx.app()).post(url(`/messages/${draft.uid}/send`)), owner);
                expect({ headers, status: now.status }).toEqual({ headers, status: 403 });
                expect((await ctx.findOne("Message", draft.uid))?.folderUid).toBe(drafts.uid);
            }
            expect(ctx.transport().sent).toHaveLength(0);

            const fine = await sendableDraft(mailbox, drafts, `From: Me <${own}>\r\nSender: ${own}`);
            expect((await auth(request(ctx.app()).post(url(`/messages/${fine.uid}/send`)), owner)).status).toBe(200);
        });
    });

    describe("legal hold and mailbox moves (finding 4)", () => {
        it("a held message can't be moved into another mailbox; a move within its mailbox is fine", async () => {
            const held = await createMailbox(owner.uid);
            const heldInbox = await createFolder(held.uid);
            const heldArchive = await createFolder(held.uid, FolderType.USER);
            const elsewhere = await createMailbox(owner.uid);
            const elsewhereInbox = await createFolder(elsewhere.uid);
            const message = await createMessage(held, heldInbox.uid, { sentDate: new Date("2025-01-01") });
            await ctx.save("Matter", {
                name: "Hold",
                escrowScopeId: uuid.v4(),
                custodianMailboxUids: [held.uid],
                dateRangeStart: new Date("2024-01-01"),
                dateRangeEnd: new Date("2026-01-01"),
            });

            const move = await auth(request(ctx.app()).put(url(`/messages/${message.uid}`)), owner).send({
                uid: message.uid,
                version: message.version,
                folderUid: elsewhereInbox.uid,
            });
            expect(move.status).toBe(409);
            expect((await ctx.findOne("Message", message.uid))?.mailboxUid).toBe(held.uid);

            const local = await auth(request(ctx.app()).put(url(`/messages/${message.uid}/folderUid`)), owner).send(heldArchive.uid);
            expect(local.status).toBe(200);
            expect(local.body.folderUid).toBe(heldArchive.uid);
        });
    });

    describe("mailbox owner ACL records (finding 5)", () => {
        it("an admin-created mailbox grants its owner, and an owner change moves the grant", async () => {
            const created = await auth(request(ctx.app()).post(url("/mailboxes")), admin).send({
                primarySmtpAddress: `${uuid.v4()}@example.com`,
                displayName: "For owner",
                timezone: "UTC",
                ownerUserUid: owner.uid,
            });
            expect(created.status).toBe(200);
            const acl = await ctx.findAcl(created.body.uid);
            expect(acl.records).toEqual(expect.arrayContaining([expect.objectContaining({ userOrRoleId: owner.uid, actions: ["*"] })]));
            expect((await auth(request(ctx.app()).get(url(`/mailboxes/${created.body.uid}`)), owner)).status).toBe(200);

            const transferred = await auth(request(ctx.app()).put(url(`/mailboxes/${created.body.uid}`)), admin).send({
                uid: created.body.uid,
                version: created.body.version,
                ownerUserUid: other.uid,
            });
            expect(transferred.status).toBe(200);
            const after = await ctx.findAcl(created.body.uid);
            const members: string[] = after.records.map((record: any) => record.userOrRoleId);
            expect(members).toContain(other.uid);
            expect(members).not.toContain(owner.uid);
            expect((await auth(request(ctx.app()).get(url(`/mailboxes/${created.body.uid}`)), other)).status).toBe(200);
            expect((await auth(request(ctx.app()).get(url(`/mailboxes/${created.body.uid}`)), owner)).status).not.toBe(200);

            const back = await auth(request(ctx.app()).put(url(`/mailboxes/${created.body.uid}/ownerUserUid`)), admin).send(owner.uid);
            expect(back.status).toBe(200);
            const final = (await ctx.findAcl(created.body.uid)).records.map((record: any) => record.userOrRoleId);
            expect(final).toContain(owner.uid);
            expect(final).not.toContain(other.uid);

            const bulk = await auth(request(ctx.app()).put(url(`/mailboxes`)), admin).send([{ uid: back.body.uid, version: back.body.version, ownerUserUid: other.uid }]);
            expect(bulk.status).toBe(200);
            expect((await ctx.findAcl(created.body.uid)).records.map((record: any) => record.userOrRoleId)).toContain(other.uid);
        });
    });

    describe("immediate sends are claimed first (finding 6)", () => {
        it("two concurrent sends relay once, a sent message can't be sent again, and a failed relay returns it to Drafts", async () => {
            const mailbox = await createMailbox(owner.uid);
            const drafts = await createFolder(mailbox.uid, FolderType.DRAFTS);
            const draft = await sendableDraft(mailbox, drafts);

            const results = await Promise.all([
                auth(request(ctx.app()).post(url(`/messages/${draft.uid}/send`)), owner),
                auth(request(ctx.app()).post(url(`/messages/${draft.uid}/send`)), owner),
            ]);
            expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
            expect(ctx.transport().sent).toHaveLength(1);
            expect((await auth(request(ctx.app()).post(url(`/messages/${draft.uid}/send`)), owner)).status).toBe(409);
            expect(ctx.transport().sent).toHaveLength(1);

            const rejected = await sendableDraft(mailbox, drafts, undefined, { recipients: [{ address: "reject@example.com", type: RecipientType.TO }] });
            const failed = await auth(request(ctx.app()).post(url(`/messages/${rejected.uid}/send`)), owner);
            expect(failed.status).toBe(502);
            const restored = await ctx.findOne("Message", rejected.uid);
            expect(restored.folderUid).toBe(drafts.uid);
            expect(restored.scheduledSendRelayedAt ?? undefined).toBeUndefined();
        });
    });

    describe("soft-deleted records (finding 8)", () => {
        it("are only visible via ?deleted=true to callers with delete and update access", async () => {
            const mailbox = await createMailbox(owner.uid);
            await ctx.saveAcl({
                uid: mailbox.uid,
                parentUid: "Mailbox",
                records: [
                    { userOrRoleId: owner.uid, actions: ["*"] },
                    { userOrRoleId: other.uid, actions: ["read", "list", "exists", "count"] },
                ],
            });
            const inbox = await createFolder(mailbox.uid);
            const message = await createMessage(mailbox, inbox.uid);
            expect([200, 204]).toContain((await auth(request(ctx.app()).delete(url(`/messages/${message.uid}`)), owner)).status);
            const deletedFolder = await createFolder(mailbox.uid, FolderType.USER);
            await ctx.update("Folder", deletedFolder.uid, { deleted: true });

            const viewerList = await auth(request(ctx.app()).get(url(`/messages?folderUid=${inbox.uid}&deleted=true`)), other);
            expect(viewerList.body).toEqual([]);
            expect((await auth(request(ctx.app()).get(url(`/messages/${message.uid}?deleted=true`)), other)).status).toBe(404);
            expect((await auth(request(ctx.app()).head(url(`/messages/${message.uid}?deleted=true`)), other)).status).toBe(404);
            const viewerCount = await auth(request(ctx.app()).head(url(`/messages?folderUid=${inbox.uid}&deleted=true`)), other);
            expect(Number(viewerCount.headers["content-length"])).toBe(0);
            const viewerFolders = await auth(request(ctx.app()).get(url(`/folders?mailboxUid=${mailbox.uid}&deleted=true`)), other);
            expect(viewerFolders.body.map((folder: any) => folder.uid)).not.toContain(deletedFolder.uid);
            expect((await auth(request(ctx.app()).head(url(`/folders/${deletedFolder.uid}?deleted=true`)), other)).status).toBe(404);

            const ownerList = await auth(request(ctx.app()).get(url(`/messages?folderUid=${inbox.uid}&deleted=true`)), owner);
            expect(ownerList.body.map((row: any) => row.uid)).toContain(message.uid);
            expect((await auth(request(ctx.app()).get(url(`/messages/${message.uid}?deleted=true`)), owner)).status).toBe(200);
            expect((await auth(request(ctx.app()).head(url(`/folders/${deletedFolder.uid}?deleted=true`)), owner)).status).toBe(200);
        });
    });

    describe("attachment and message derived fields (findings 9 and 11b)", () => {
        it("messageUid, job retry state and hasAttachments are the server's", async () => {
            const mailbox = await createMailbox(owner.uid);
            const drafts = await createFolder(mailbox.uid, FolderType.DRAFTS);
            const created = await auth(request(ctx.app()).post(url("/messages")), owner).send(
                draftBody({
                    folderUid: drafts.uid,
                    mailboxUid: mailbox.uid,
                    from: { address: mailbox.primarySmtpAddress, type: "to" },
                    hasAttachments: true,
                    searchIndexAttempts: 99,
                    scheduledSendError: "x",
                    scheduledSendTime: new Date(Date.now() + 3_600_000).toISOString(),
                }),
            );
            expect(created.status).toBe(200);
            expect(created.body.hasAttachments).toBe(false);
            expect(created.body.searchIndexAttempts ?? undefined).toBeUndefined();
            expect(created.body.scheduledSendError ?? undefined).toBeUndefined();
            expect(created.body.scheduledSendTime ?? undefined).toBeUndefined();

            const upload = await auth(request(ctx.app()).post(url(`/attachments/upload?messageUid=${created.body.uid}&filename=a.txt&mimeType=text/plain`)), owner)
                .set("Content-Type", "application/octet-stream")
                .send(Buffer.from("hello"));
            expect(upload.status).toBe(200);
            expect((await ctx.findOne("Message", created.body.uid))?.hasAttachments).toBe(true);

            const otherMessage = await createMessage(mailbox, drafts.uid);
            const repoint = await auth(request(ctx.app()).put(url(`/attachments/${upload.body.uid}`)), owner).send({
                uid: upload.body.uid,
                version: upload.body.version,
                messageUid: otherMessage.uid,
                extractionAttempts: 42,
                filename: "b.txt",
            });
            expect(repoint.status).toBe(200);
            expect(repoint.body.messageUid).toBe(created.body.uid);
            expect(repoint.body.extractionAttempts ?? undefined).toBeUndefined();

            const message = await ctx.findOne("Message", created.body.uid);
            const flip = await auth(request(ctx.app()).put(url(`/messages/${message.uid}`)), owner).send({ uid: message.uid, version: message.version, hasAttachments: false });
            expect(flip.status).toBe(200);
            expect(flip.body.hasAttachments).toBe(true);

            expect([200, 204]).toContain((await auth(request(ctx.app()).delete(url(`/attachments/${upload.body.uid}`)), owner)).status);
            expect((await ctx.findOne("Message", created.body.uid))?.hasAttachments).toBe(false);
        });
    });

    describe("date fields are stored as dates (finding 11a)", () => {
        it("mailbox OOF window, share link expiry, task due/reminder and trusted message dates", async () => {
            const mailbox = await createMailbox(owner.uid);
            const when = "2030-05-01T10:00:00.000Z";
            const sameInstant = (value: any) => {
                expect(new Date(value).toISOString()).toBe(when);
                if (isMongo) {
                    expect(value).toBeInstanceOf(Date);
                }
            };

            expect((await auth(request(ctx.app()).put(url(`/mailboxes/${mailbox.uid}/oofStartTime`)), owner).send(when as any)).status).toBe(200);
            sameInstant((await ctx.findOne("Mailbox", mailbox.uid)).oofStartTime);
            const current = await ctx.findOne("Mailbox", mailbox.uid);
            expect((await auth(request(ctx.app()).put(url(`/mailboxes/${mailbox.uid}`)), owner).send({ uid: mailbox.uid, version: current.version, oofEndTime: when })).status).toBe(200);
            sameInstant((await ctx.findOne("Mailbox", mailbox.uid)).oofEndTime);
            const fresh = await ctx.findOne("Mailbox", mailbox.uid);
            expect((await auth(request(ctx.app()).put(url(`/mailboxes/${mailbox.uid}`)), owner).send({ uid: mailbox.uid, version: fresh.version, oofEndTime: "whenever" })).status).toBe(400);

            const calendar = await createFolder(mailbox.uid, FolderType.CALENDAR);
            const link = await auth(request(ctx.app()).post(url("/calendar-share-links")), owner).send({
                folderUid: calendar.uid,
                permittedActions: ["list", "read"],
                createdByUserUid: owner.uid,
                expiresAt: when,
            });
            expect(link.status).toBe(200);
            sameInstant((await ctx.findOne("CalendarShareLink", link.body.uid)).expiresAt);

            const tasks = await createFolder(mailbox.uid, FolderType.TASKS);
            const task = await auth(request(ctx.app()).post(url("/tasks")), owner).send({
                folderUid: tasks.uid,
                mailboxUid: mailbox.uid,
                title: "Do it",
                completed: false,
                priority: "normal",
                dueDate: when,
            });
            expect(task.status).toBe(200);
            sameInstant((await ctx.findOne("Task", task.body.uid)).dueDate);
            const reminder = await auth(request(ctx.app()).put(url(`/tasks/${task.body.uid}/reminderDate`)), owner).send(when as any);
            expect(reminder.status).toBe(200);
            sameInstant((await ctx.findOne("Task", task.body.uid)).reminderDate);
            expect((await auth(request(ctx.app()).put(url(`/tasks/${task.body.uid}/dueDate`)), owner).send("tomorrow-ish" as any)).status).toBe(400);

            const inbox = await createFolder(mailbox.uid);
            const message = await createMessage(mailbox, inbox.uid);
            const trusted = await auth(request(ctx.app()).put(url(`/messages/${message.uid}`)), admin).send({ uid: message.uid, version: message.version, searchIndexNextAttemptAt: when });
            expect(trusted.status).toBe(200);
            sameInstant((await ctx.findOne("Message", message.uid)).searchIndexNextAttemptAt);
        });
    });

    describe("edge cases", () => {
        it("malformed body shapes are refused", async () => {
            const mailbox = await createMailbox(owner.uid);
            const inbox = await createFolder(mailbox.uid);
            const message = await createMessage(mailbox, inbox.uid);
            expect((await auth(request(ctx.app()).post(url("/messages")), owner).send([5] as any)).status).toBe(400);
            expect((await auth(request(ctx.app()).put(url(`/messages/${message.uid}`)), owner).send([] as any)).status).toBe(400);
            expect((await auth(request(ctx.app()).put(url("/messages")), owner).send({ uid: message.uid } as any)).status).toBeGreaterThanOrEqual(400);
            expect((await auth(request(ctx.app()).post(url("/mailboxes")), admin).send([5] as any)).status).toBe(400);
            expect((await auth(request(ctx.app()).put(url("/mailboxes")), admin).send({ uid: mailbox.uid } as any)).status).toBeGreaterThanOrEqual(400);

            // A nested array passes the generic per-element validation (an empty array has nothing to validate), so
            // it's the create() shape checks themselves that must refuse it - creating nothing.
            const messagesBefore: number = await ctx.count("Message");
            const mailboxesBefore: number = await ctx.count("Mailbox");
            expect((await auth(request(ctx.app()).post(url("/messages")), owner).send([[]] as any)).status).toBe(400);
            expect((await auth(request(ctx.app()).post(url("/mailboxes")), admin).send([[]] as any)).status).toBe(400);
            expect(await ctx.count("Message")).toBe(messagesBefore);
            expect(await ctx.count("Mailbox")).toBe(mailboxesBefore);
        });

        it("a relayed message waiting to be filed can't be sent again or taken out of Outbox; a B-encoded address display name is refused", async () => {
            const mailbox = await createMailbox(owner.uid);
            const drafts = await createFolder(mailbox.uid, FolderType.DRAFTS);
            const outbox = await createFolder(mailbox.uid, FolderType.OUTBOX);
            const relayed = await sendableDraft(mailbox, drafts, undefined, { scheduledSendRelayedAt: new Date() });
            expect((await auth(request(ctx.app()).post(url(`/messages/${relayed.uid}/send`)), owner)).status).toBe(409);

            const filing = await createMessage(mailbox, outbox.uid, { scheduledSendRelayedAt: new Date(), scheduledSendTime: new Date() });
            const moveOut = await auth(request(ctx.app()).put(url(`/messages/${filing.uid}`)), owner).send({ uid: filing.uid, version: filing.version, folderUid: drafts.uid });
            expect(moveOut.status).toBe(409);

            const encoded = Buffer.from("ceo@example.com").toString("base64");
            const spoof = await sendableDraft(mailbox, drafts, `From: =?utf-8?B?${encoded}?= <${mailbox.primarySmtpAddress}>`);
            expect((await auth(request(ctx.app()).post(url(`/messages/${spoof.uid}/send`)), owner)).status).toBe(403);
            expect(ctx.transport().sent).toHaveLength(0);
        });

        it("clearing a mailbox's owner removes the owner grant; a second attachment keeps hasAttachments", async () => {
            const created = await auth(request(ctx.app()).post(url("/mailboxes")), admin).send({
                primarySmtpAddress: `${uuid.v4()}@example.com`,
                displayName: "Shared",
                timezone: "UTC",
                ownerUserUid: owner.uid,
            });
            expect(created.status).toBe(200);
            const cleared = await auth(request(ctx.app()).put(url(`/mailboxes/${created.body.uid}`)), admin).send({
                uid: created.body.uid,
                version: created.body.version,
                ownerUserUid: null,
            });
            expect(cleared.status).toBe(200);
            expect((await ctx.findAcl(created.body.uid)).records.map((record: any) => record.userOrRoleId)).not.toContain(owner.uid);

            const mailbox = await createMailbox(owner.uid);
            const drafts = await createFolder(mailbox.uid, FolderType.DRAFTS);
            const message = await createMessage(mailbox, drafts.uid);
            const upload = () =>
                auth(request(ctx.app()).post(url(`/attachments/upload?messageUid=${message.uid}&filename=a.txt&mimeType=text/plain`)), owner)
                    .set("Content-Type", "application/octet-stream")
                    .send(Buffer.from("hello"));
            const first = await upload();
            const second = await upload();
            expect([first.status, second.status]).toEqual([200, 200]);
            expect([200, 204]).toContain((await auth(request(ctx.app()).delete(url(`/attachments/${first.body.uid}`)), owner)).status);
            expect((await ctx.findOne("Message", message.uid))?.hasAttachments).toBe(true);
        });

        it("distribution list property updates refuse a path property name", async () => {
            const list = await ctx.save("DistributionList", {
                name: "List",
                primarySmtpAddress: `${uuid.v4()}@example.com`,
                aliasAddresses: [],
                memberAddresses: [],
            });
            expect((await auth(request(ctx.app()).put(url(`/distribution-lists/${list.uid}/name.x`)), admin).send("x" as any)).status).toBe(400);
            expect((await auth(request(ctx.app()).put(url(`/distribution-lists/${list.uid}/name`)), admin).send("Renamed" as any)).status).not.toBe(400);
            expect((await auth(request(ctx.app()).put(url(`/transport-rules/${list.uid}/name`)), admin).send("Renamed" as any)).status).not.toBe(400);
        });
    });
}
