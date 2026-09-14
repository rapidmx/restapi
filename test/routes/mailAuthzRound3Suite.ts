///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Round-3 review fixes for the mail/mailbox/folder routes (authorization, scoping and server-managed fields),
// identical on both backends. `test/routes/{mongo,sql}/MailAuthzRound3.test.ts` supply a started server and raw row
// helpers; everything under test goes through HTTP.
import { request } from "@rapidrest/service-core/test";
import * as uuid from "uuid";
import { FolderType, IngestStatus, MessageImportance, QuarantineReason, RecipientType } from "../../src/models/types.js";
import type { InMemoryBlobStore, NoopSearchProvider, RecordingMailTransport } from "../testDoubles.js";

/** Row kinds `save()`/`findOne()` accept - each maps to the backend's concrete model class. */
export type RowKind =
    | "Mailbox"
    | "Folder"
    | "Message"
    | "Attachment"
    | "Contact"
    | "QuarantineEntry"
    | "IngestQueueEntry"
    | "Matter"
    | "Label"
    | "CalendarShareLink"
    | "Domain";

export interface MailAuthzRound3SuiteContext {
    app: () => any;
    /** `"/mongo"` or `"/sql"`. */
    prefix: string;
    tokenFor: (user: any) => string;
    /** Saves a raw row (bypassing every route), returning it as stored. */
    save: (kind: RowKind, fields: Record<string, any>) => Promise<any>;
    findOne: (kind: RowKind, uid: string) => Promise<any | undefined>;
    /** Sets fields on a stored row directly. */
    update: (kind: RowKind, uid: string, fields: Record<string, any>) => Promise<void>;
    saveAcl: (acl: { uid: string; parentUid?: string; records: { userOrRoleId: string; actions: string[] }[] }) => Promise<void>;
    findAcl: (uid: string) => Promise<any | undefined>;
    blobStore: () => InMemoryBlobStore;
    transport: () => RecordingMailTransport;
    searchProvider: () => NoopSearchProvider;
}

export function mailAuthzRound3Suite(ctx: MailAuthzRound3SuiteContext): void {
    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const other: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const auth = (req: any, user: any) => req.set("Authorization", "jwt " + ctx.tokenFor(user));
    const url = (path: string) => `${ctx.prefix}${path}`;

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
        sentDate: new Date().toISOString(),
        receivedDate: new Date().toISOString(),
        bodyBlobKey: `bodies/${uuid.v4()}`,
        ...fields,
    });

    describe("create routes always mint the uid (finding 1)", () => {
        it("a folder created with another mailbox's uid gets a fresh uid and no grant on that mailbox's ACL", async () => {
            const victim = await createMailbox(other.uid);
            const mine = await createMailbox(owner.uid);

            const result = await auth(request(ctx.app()).post(url("/folders")), owner).send({
                uid: victim.uid,
                mailboxUid: mine.uid,
                name: "Sneaky",
                type: FolderType.USER,
                unreadCount: 5,
            });
            expect(result.status).toBe(200);
            expect(result.body.uid).not.toBe(victim.uid);
            expect(result.body.unreadCount).toBe(0);

            const victimAcl = await ctx.findAcl(victim.uid);
            expect(victimAcl.records.map((r: any) => r.userOrRoleId)).toEqual([other.uid]);
            const read = await auth(request(ctx.app()).get(url(`/messages/conversations?mailboxUid=${victim.uid}`)), owner);
            expect(read.body).toEqual([]);
        });

        it("a folder created with uid 'Mailbox' doesn't touch the Mailbox class ACL", async () => {
            const mine = await createMailbox(owner.uid);
            const before = await ctx.findAcl("Mailbox");

            const result = await auth(request(ctx.app()).post(url("/folders")), owner).send({
                uid: "Mailbox",
                mailboxUid: mine.uid,
                name: "Class",
                type: FolderType.USER,
            });
            expect(result.status).toBe(200);
            expect(result.body.uid).not.toBe("Mailbox");
            const after = await ctx.findAcl("Mailbox");
            expect(after?.records ?? []).toEqual(before?.records ?? []);
        });

        it("a message created with a client uid gets a server uid", async () => {
            const mine = await createMailbox(owner.uid);
            const drafts = await createFolder(mine.uid, FolderType.DRAFTS);
            const result = await auth(request(ctx.app()).post(url("/messages")), owner).send(
                draftBody({ uid: "chosen,uid", mailboxUid: mine.uid, folderUid: drafts.uid, from: { address: mine.primarySmtpAddress, type: "to" } }),
            );
            expect(result.status).toBe(200);
            expect(result.body.uid).not.toBe("chosen,uid");

            const rule = await auth(request(ctx.app()).post(url("/transport-rules")), admin).send({
                uid: "Domain",
                name: "Rule",
                enabled: true,
                sequence: 0,
                stopProcessingRules: false,
                conditions: {},
                actions: [],
            });
            expect(rule.status).toBe(200);
            expect(rule.body.uid).not.toBe("Domain");
        });
    });

    describe("list queries can't widen their scope (finding 2)", () => {
        const q = (query: unknown) => Buffer.from(JSON.stringify(query), "utf-8").toString("base64");

        it("a $or branch naming another folder returns only the permitted folder's messages", async () => {
            const victim = await createMailbox(other.uid);
            const victimInbox = await createFolder(victim.uid);
            await createMessage(victim, victimInbox.uid, { subject: "secret" });
            const mine = await createMailbox(owner.uid);
            const myInbox = await createFolder(mine.uid);
            await createMessage(mine, myInbox.uid, { subject: "mine" });

            const found = await auth(
                request(ctx.app()).get(url(`/messages?q=${q({ folderUid: myInbox.uid, $or: [{ folderUid: victimInbox.uid }] })}`)),
                owner,
            );
            expect(found.status).toBe(200);
            expect(found.body.map((m: any) => m.subject)).toEqual(["mine"]);

            const counted = await auth(
                request(ctx.app()).head(url(`/messages?q=${q({ folderUid: myInbox.uid, $or: [{ folderUid: victimInbox.uid }] })}`)),
                owner,
            );
            expect(counted.headers["content-length"]).toBe("1");
        });

        it("a $or branch naming another mailbox returns only accessible mailboxes and folders", async () => {
            const victim = await createMailbox(other.uid);
            await createFolder(victim.uid);
            const mine = await createMailbox(owner.uid);
            await createFolder(mine.uid);

            const mailboxes = await auth(request(ctx.app()).get(url(`/mailboxes?q=${q({ displayName: "Test Mailbox", $or: [{ uid: victim.uid }] })}`)), owner);
            expect(mailboxes.body.map((m: any) => m.uid)).toEqual([mine.uid]);

            const folders = await auth(
                request(ctx.app()).get(url(`/folders?q=${q({ mailboxUid: mine.uid, $or: [{ mailboxUid: victim.uid }] })}`)),
                owner,
            );
            expect(folders.body.map((f: any) => f.mailboxUid)).toEqual([mine.uid]);
        });
    });

    describe("share tokens (finding 3)", () => {
        const setup = async () => {
            const mailbox = await createMailbox(owner.uid);
            const calendar = await createFolder(mailbox.uid, FolderType.CALENDAR);
            await ctx.save("Contact", {
                mailboxUid: mailbox.uid,
                folderUid: calendar.uid,
                displayName: "not an event, just a row",
                emails: [],
                phones: [],
                addresses: [],
            });
            return { mailbox, calendar };
        };

        it("a user uid presented as a share token grants nothing", async () => {
            const { calendar } = await setup();
            const result = await request(ctx.app()).get(url(`/contacts?folderUid=${calendar.uid}&shareToken=${owner.uid}`));
            expect(result.body).toEqual([]);
            const events = await request(ctx.app()).get(url(`/calendar-events?folderUid=${calendar.uid}&shareToken=${owner.uid}`));
            expect(events.body).toEqual([]);
        });

        it("a real link grants its folder under a `share:` identity, and nothing once expired or on another folder", async () => {
            const { mailbox, calendar } = await setup();
            const otherCalendar = await createFolder(mailbox.uid, FolderType.CALENDAR);
            const link = await auth(request(ctx.app()).post(url("/calendar-share-links")), owner).send({
                folderUid: calendar.uid,
                permittedActions: ["list", "read", "exists"],
                createdByUserUid: owner.uid,
            });
            expect(link.status).toBe(200);
            const token: string = link.body.token;
            const acl = await ctx.findAcl(calendar.uid);
            expect(acl.records.map((r: any) => r.userOrRoleId)).toEqual([`share:${token}`]);

            const granted = await request(ctx.app()).head(url(`/folders/${calendar.uid}?shareToken=${token}`));
            expect(granted.status).toBe(200);

            // The same grant copied onto another folder's ACL is still refused - the link names one folder.
            await ctx.saveAcl({ uid: otherCalendar.uid, parentUid: mailbox.uid, records: [{ userOrRoleId: `share:${token}`, actions: ["*"] }] });
            const elsewhere = await request(ctx.app()).head(url(`/folders/${otherCalendar.uid}?shareToken=${token}`));
            expect(elsewhere.status).toBe(404);

            await ctx.update("CalendarShareLink", link.body.uid, { expiresAt: new Date(Date.now() - 1000) });
            const expired = await request(ctx.app()).head(url(`/folders/${calendar.uid}?shareToken=${token}`));
            expect(expired.status).toBe(404);
        });
    });

    describe("server-managed fields (findings 4 and 11)", () => {
        it("ignores blob keys, receipt/scan state and dates a non-trusted caller sets on a message", async () => {
            const mailbox = await createMailbox(owner.uid);
            const inbox = await createFolder(mailbox.uid);
            const message = await createMessage(mailbox, inbox.uid, { sentDate: new Date("2025-06-01") });

            const result = await auth(request(ctx.app()).put(url(`/messages/${message.uid}`)), owner).send({
                uid: message.uid,
                version: message.version,
                subject: "renamed",
                bodyBlobKey: "attachments/someone-elses",
                sanitizedHtmlBlobKey: "sanitized/someone-elses",
                encrypted: true,
                readReceiptSentAt: new Date().toISOString(),
                receiptStatus: [{ recipientAddress: "x@example.net" }],
                recallRequestedAt: new Date().toISOString(),
                dispositionNotificationTo: "attacker@example.net",
                sentDate: new Date("2001-01-01").toISOString(),
            });
            expect(result.status).toBe(200);
            const stored = await ctx.findOne("Message", message.uid);
            expect(stored.subject).toBe("renamed");
            expect(stored.bodyBlobKey).toBe(message.bodyBlobKey);
            expect(stored.sanitizedHtmlBlobKey ?? undefined).toBeUndefined();
            expect(!!stored.encrypted).toBe(false);
            expect(stored.readReceiptSentAt ?? undefined).toBeUndefined();
            expect(stored.receiptStatus ?? undefined).toBeUndefined();
            expect(stored.recallRequestedAt ?? undefined).toBeUndefined();
            expect(stored.dispositionNotificationTo ?? undefined).toBeUndefined();
            expect(new Date(stored.sentDate).toISOString()).toBe(new Date("2025-06-01").toISOString());
        });

        it("a trusted caller can still set them", async () => {
            const mailbox = await createMailbox(owner.uid);
            const inbox = await createFolder(mailbox.uid);
            const message = await createMessage(mailbox, inbox.uid);
            const result = await auth(request(ctx.app()).put(url(`/messages/${message.uid}`)), admin).send({
                uid: message.uid,
                version: message.version,
                encrypted: true,
            });
            expect(result.status).toBe(200);
            expect((await ctx.findOne("Message", message.uid)).encrypted).toBe(true);
        });

        it("keeps dispositionNotificationTo and dates only on a draft create", async () => {
            const mailbox = await createMailbox(owner.uid);
            const drafts = await createFolder(mailbox.uid, FolderType.DRAFTS);
            const inbox = await createFolder(mailbox.uid);
            const body = { from: { address: mailbox.primarySmtpAddress, type: "to" }, mailboxUid: mailbox.uid, dispositionNotificationTo: "me@example.net", sentDate: "2001-01-01T00:00:00.000Z", bodyBlobKey: "bodies/chosen" };

            const draft = await auth(request(ctx.app()).post(url("/messages")), owner).send(draftBody({ ...body, folderUid: drafts.uid }));
            expect(draft.status).toBe(200);
            expect(draft.body.dispositionNotificationTo).toBe("me@example.net");
            expect(new Date(draft.body.sentDate).getUTCFullYear()).toBe(2001);
            expect(draft.body.bodyBlobKey).not.toBe("bodies/chosen");

            const filed = await auth(request(ctx.app()).post(url("/messages")), owner).send(draftBody({ ...body, folderUid: inbox.uid }));
            expect(filed.status).toBe(200);
            expect(filed.body.dispositionNotificationTo ?? undefined).toBeUndefined();
            expect(new Date(filed.body.sentDate).getUTCFullYear()).toBeGreaterThan(2001);
        });

        it("refuses POST /attachments and ignores client blob key/size/type on update; ignores a contact photo key", async () => {
            const mailbox = await createMailbox(owner.uid);
            const inbox = await createFolder(mailbox.uid);
            const message = await createMessage(mailbox, inbox.uid);
            const created = await auth(request(ctx.app()).post(url("/attachments")), owner).send({
                messageUid: message.uid,
                folderUid: inbox.uid,
                mailboxUid: mailbox.uid,
                filename: "x.txt",
                mimeType: "text/plain",
                sizeBytes: 1,
                blobKey: "bodies/someone-elses",
                isInline: false,
            });
            expect(created.status).toBe(400);

            const attachment = await ctx.save("Attachment", {
                messageUid: message.uid,
                folderUid: inbox.uid,
                mailboxUid: mailbox.uid,
                filename: "a.txt",
                mimeType: "text/plain",
                sizeBytes: 3,
                blobKey: "attachments/mine",
                isInline: false,
            });
            const updated = await auth(request(ctx.app()).put(url(`/attachments/${attachment.uid}`)), owner).send({
                uid: attachment.uid,
                version: attachment.version,
                filename: "b.txt",
                blobKey: "bodies/someone-elses",
                sizeBytes: 999,
                mimeType: "text/html",
            });
            expect(updated.status).toBe(200);
            expect(updated.body).toEqual(expect.objectContaining({ filename: "b.txt", blobKey: "attachments/mine", sizeBytes: 3, mimeType: "text/plain" }));

            const contacts = await createFolder(mailbox.uid, FolderType.CONTACTS);
            const contact = await auth(request(ctx.app()).post(url("/contacts")), owner).send({
                mailboxUid: mailbox.uid,
                folderUid: contacts.uid,
                displayName: "Pat",
                emails: [],
                phones: [],
                addresses: [],
                photoBlobKey: "bodies/someone-elses",
            });
            expect(contact.status).toBe(200);
            expect(contact.body.photoBlobKey ?? undefined).toBeUndefined();
        });

        it("ignores a non-trusted caller's folder counters and mailbox move", async () => {
            const mailbox = await createMailbox(owner.uid);
            const elsewhere = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.USER);

            const put = await auth(request(ctx.app()).put(url(`/folders/${folder.uid}`)), owner).send({
                uid: folder.uid,
                version: folder.version,
                name: "Renamed",
                unreadCount: 42,
                totalCount: 42,
                syncKeyVersion: 42,
                mailboxUid: elsewhere.uid,
            });
            expect(put.status).toBe(200);
            expect(put.body).toEqual(expect.objectContaining({ name: "Renamed", unreadCount: 0, totalCount: 0, syncKeyVersion: 0, mailboxUid: mailbox.uid }));

            const single = await auth(request(ctx.app()).put(url(`/folders/${folder.uid}/unreadCount`)), owner).send(7 as any);
            expect(single.status).toBe(403);
        });
    });

    describe("ingest queue and quarantine writes (finding 5)", () => {
        it("are trusted-only; reads stay mailbox-scoped", async () => {
            const mailbox = await createMailbox(owner.uid);
            const entry = await ctx.save("IngestQueueEntry", {
                mailboxUid: mailbox.uid,
                envelopeFrom: "a@example.net",
                envelopeTo: [mailbox.primarySmtpAddress],
                rawBlobKey: "raw/1",
                status: IngestStatus.FAILED,
            });
            const quarantined = await ctx.save("QuarantineEntry", {
                mailboxUid: mailbox.uid,
                reason: QuarantineReason.SPAM_POLICY,
                scanResultUid: uuid.v4(),
                rawBlobKey: "raw/2",
            });

            expect((await auth(request(ctx.app()).get(url(`/ingest-queue?mailboxUid=${mailbox.uid}`)), owner)).body.length).toBe(1);
            expect((await auth(request(ctx.app()).get(url(`/quarantine?mailboxUid=${mailbox.uid}`)), owner)).body.length).toBe(1);

            const writes = [
                auth(request(ctx.app()).post(url("/ingest-queue")), owner).send({ ...entry, uid: undefined }),
                auth(request(ctx.app()).put(url(`/ingest-queue/${entry.uid}`)), owner).send({ uid: entry.uid, version: entry.version, status: IngestStatus.PENDING }),
                auth(request(ctx.app()).delete(url(`/ingest-queue/${entry.uid}`)), owner),
                auth(request(ctx.app()).put(url(`/quarantine/${quarantined.uid}`)), owner).send({ uid: quarantined.uid, version: quarantined.version, releasedAt: new Date().toISOString() }),
                auth(request(ctx.app()).put(url(`/quarantine/${quarantined.uid}/rawBlobKey`)), owner).send("raw/other" as any),
                auth(request(ctx.app()).delete(url(`/quarantine?mailboxUid=${mailbox.uid}`)), owner),
            ];
            for (const response of await Promise.all(writes)) {
                expect(response.status).toBe(403);
            }
        });

        it("a trusted release is stamped by the server", async () => {
            const mailbox = await createMailbox(owner.uid);
            const quarantined = await ctx.save("QuarantineEntry", {
                mailboxUid: mailbox.uid,
                reason: QuarantineReason.SPAM_POLICY,
                scanResultUid: uuid.v4(),
                rawBlobKey: "raw/2",
            });
            const before = Date.now();
            const released = await auth(request(ctx.app()).put(url(`/quarantine/${quarantined.uid}`)), admin).send({
                uid: quarantined.uid,
                version: quarantined.version,
                releasedAt: "2001-01-01T00:00:00.000Z",
                releasedByUserUid: owner.uid,
            });
            expect(released.status).toBe(200);
            expect(released.body.releasedByUserUid).toBe(admin.uid);
            expect(new Date(released.body.releasedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
        });
    });

    describe("mailbox aliases, deletion and bulk deletes (findings 6, 7, 9)", () => {
        it("refuses an alias another mailbox or list already uses, or a non-trusted caller's unowned alias", async () => {
            const taken = await createMailbox(other.uid);
            const mine = await createMailbox(owner.uid);

            const collision = await auth(request(ctx.app()).put(url(`/mailboxes/${mine.uid}`)), admin).send({
                uid: mine.uid,
                version: mine.version,
                aliasAddresses: [taken.primarySmtpAddress.toUpperCase()],
            });
            expect(collision.status).toBe(409);

            const single = await auth(request(ctx.app()).put(url(`/mailboxes/${mine.uid}/aliasAddresses`)), admin).send([taken.primarySmtpAddress] as any);
            expect(single.status).toBe(409);

            const unowned = await auth(request(ctx.app()).put(url(`/mailboxes/${mine.uid}`)), owner).send({
                uid: mine.uid,
                version: mine.version,
                aliasAddresses: [`ceo-${uuid.v4()}@example.com`],
            });
            expect(unowned.status).toBe(403);

            const malformed = await auth(request(ctx.app()).put(url(`/mailboxes/${mine.uid}`)), admin).send({
                uid: mine.uid,
                version: mine.version,
                aliasAddresses: ["a,b@example.com"],
            });
            expect(malformed.status).toBe(400);

            // `_` is a LIKE wildcard on SQL - the availability lookup must escape it, not treat it as "any character".
            const fresh = `free_${uuid.v4()}@example.com`;
            const ok = await auth(request(ctx.app()).put(url(`/mailboxes/${mine.uid}`)), admin).send({
                uid: mine.uid,
                version: mine.version,
                aliasAddresses: [fresh],
            });
            expect(ok.status).toBe(200);
            expect(ok.body.aliasAddresses).toEqual([fresh]);

            // Removing aliases (and resending the current ones) is always allowed.
            const removed = await auth(request(ctx.app()).put(url(`/mailboxes/${mine.uid}`)), owner).send({
                uid: mine.uid,
                version: ok.body.version,
                aliasAddresses: [],
            });
            expect(removed.status).toBe(200);
        });

        it("refuses re-creating a deleted mailbox's address while its folders remain", async () => {
            const address = `reuse-${uuid.v4()}@example.com`;
            const created = await auth(request(ctx.app()).post(url("/mailboxes")), admin).send({
                primarySmtpAddress: address,
                aliasAddresses: [],
                displayName: "Old",
                timezone: "UTC",
                ownerUserUid: owner.uid,
            });
            expect(created.status).toBe(200);
            const deleted = await auth(request(ctx.app()).delete(url(`/mailboxes/${created.body.uid}`)), admin);
            expect(deleted.status).toBeLessThan(300);

            const again = await auth(request(ctx.app()).post(url("/mailboxes")), admin).send({
                primarySmtpAddress: address,
                aliasAddresses: [],
                displayName: "New",
                timezone: "UTC",
                ownerUserUid: other.uid,
            });
            expect(again.status).toBe(409);
        });

        it("truncate deletes exactly the matched records even when a uid contains a comma", async () => {
            const victim = await createMailbox(other.uid);
            const victimInbox = await createFolder(victim.uid);
            const victimMessage = await createMessage(victim, victimInbox.uid);
            const mine = await createMailbox(owner.uid);
            const myFolder = await createFolder(mine.uid);
            await createMessage(mine, myFolder.uid, { uid: `${victimMessage.uid},x` });

            const truncated = await auth(request(ctx.app()).delete(url(`/messages?folderUid=${myFolder.uid}`)), owner);
            expect(truncated.status).toBeLessThan(300);
            expect(await ctx.findOne("Message", victimMessage.uid)).toBeDefined();
        });
    });

    describe("legal hold dates (finding 8)", () => {
        it("a held message can't be re-dated out of the hold and purged", async () => {
            const mailbox = await createMailbox(owner.uid);
            const inbox = await createFolder(mailbox.uid);
            const message = await createMessage(mailbox, inbox.uid, { sentDate: new Date("2025-01-01") });
            await ctx.save("Matter", {
                name: "Hold",
                escrowScopeId: uuid.v4(),
                custodianMailboxUids: [mailbox.uid],
                dateRangeStart: new Date("2024-01-01"),
                dateRangeEnd: new Date("2026-01-01"),
            });
            const redate = await auth(request(ctx.app()).put(url(`/messages/${message.uid}`)), owner).send({
                uid: message.uid,
                version: message.version,
                sentDate: "2010-01-01T00:00:00.000Z",
                receivedDate: "2010-01-01T00:00:00.000Z",
            });
            expect(redate.status).toBe(200);
            const purge = await auth(request(ctx.app()).delete(url(`/messages/${message.uid}?purge=true`)), owner);
            expect(purge.status).toBe(409);
        });
    });

    describe("mail filter rule targets (finding 10)", () => {
        it("refuses a folder or label from another mailbox, allows its own", async () => {
            const victim = await createMailbox(other.uid);
            const victimFolder = await createFolder(victim.uid);
            const victimLabel = await ctx.save("Label", { mailboxUid: victim.uid, name: "theirs" });
            const mine = await createMailbox(owner.uid);
            const myFolder = await createFolder(mine.uid, FolderType.USER);
            const rule = (actions: any[]) => ({
                mailboxUid: mine.uid,
                name: "Rule",
                enabled: true,
                sequence: 1,
                stopProcessingRules: false,
                conditions: { fromContains: ["x"] },
                actions,
            });

            const intoVictim = await auth(request(ctx.app()).post(url("/mail-filter-rules")), owner).send(rule([{ type: "move_to_folder", folderUid: victimFolder.uid }]));
            expect(intoVictim.status).toBe(400);
            const victimLabelRule = await auth(request(ctx.app()).post(url("/mail-filter-rules")), owner).send(rule([{ type: "apply_label", labelUid: victimLabel.uid }]));
            expect(victimLabelRule.status).toBe(400);

            const ok = await auth(request(ctx.app()).post(url("/mail-filter-rules")), owner).send(rule([{ type: "move_to_folder", folderUid: myFolder.uid }]));
            expect(ok.status).toBe(200);
            const retarget = await auth(request(ctx.app()).put(url(`/mail-filter-rules/${ok.body.uid}`)), owner).send({
                uid: ok.body.uid,
                version: ok.body.version,
                actions: [{ type: "copy_to_folder", folderUid: victimFolder.uid }],
            });
            expect(retarget.status).toBe(400);
        });
    });

    describe("sender addresses (finding 12)", () => {
        const sendable = async (mailbox: any, from: string, header?: string) => {
            const drafts = await createFolder(mailbox.uid, FolderType.DRAFTS);
            const bodyBlobKey = `bodies/${uuid.v4()}`;
            await ctx.blobStore().put(bodyBlobKey, Buffer.from(`From: ${header ?? from}\r\nTo: recipient@example.net\r\nSubject: hi\r\n\r\nhello`));
            return createMessage(mailbox, drafts.uid, { bodyBlobKey, from: { address: from, type: RecipientType.TO } });
        };

        it("refuses to send or schedule as an address that isn't the mailbox's", async () => {
            const mailbox = await createMailbox(owner.uid, { aliasAddresses: ["alias-owner@example.com"] });
            const spoofed = await sendable(mailbox, "ceo@example.com");
            expect((await auth(request(ctx.app()).post(url(`/messages/${spoofed.uid}/send`)), owner)).status).toBe(403);

            const scheduled = await sendable(mailbox, "ceo@example.com");
            await ctx.update("Message", scheduled.uid, { scheduledSendTime: new Date(Date.now() + 3_600_000) });
            expect((await auth(request(ctx.app()).post(url(`/messages/${scheduled.uid}/send`)), owner)).status).toBe(403);

            const headerSpoof = await sendable(mailbox, mailbox.primarySmtpAddress, "CEO <ceo@example.com>");
            expect((await auth(request(ctx.app()).post(url(`/messages/${headerSpoof.uid}/send`)), owner)).status).toBe(403);
            expect(ctx.transport().sent).toHaveLength(0);

            const viaAlias = await sendable(mailbox, "Alias-Owner@example.com", `Me <alias-owner@example.com>`);
            expect((await auth(request(ctx.app()).post(url(`/messages/${viaAlias.uid}/send`)), owner)).status).toBe(200);
        });

        it("refuses a recall whose sender isn't the mailbox's", async () => {
            const mailbox = await createMailbox(owner.uid);
            const sent = await createFolder(mailbox.uid, FolderType.SENT_ITEMS);
            const message = await createMessage(mailbox, sent.uid, { from: { address: "ceo@example.com", type: RecipientType.TO } });
            expect((await auth(request(ctx.app()).post(url(`/messages/${message.uid}/recall`)), owner)).status).toBe(403);
        });
    });

    describe("content responses (finding 13)", () => {
        it("serves only raster images inline; everything else as an octet-stream download, never sniffed", async () => {
            const mailbox = await createMailbox(owner.uid);
            const inbox = await createFolder(mailbox.uid);
            const message = await createMessage(mailbox, inbox.uid);
            const attach = async (mimeType: string, isInline: boolean) => {
                const blobKey = `attachments/${uuid.v4()}`;
                await ctx.blobStore().put(blobKey, Buffer.from("<script>alert(1)</script>"));
                return ctx.save("Attachment", {
                    messageUid: message.uid,
                    folderUid: inbox.uid,
                    mailboxUid: mailbox.uid,
                    filename: "f",
                    mimeType,
                    sizeBytes: 25,
                    blobKey,
                    isInline,
                });
            };
            const html = await auth(request(ctx.app()).get(url(`/attachments/${(await attach("text/html", true)).uid}/content`)), owner);
            expect(html.headers["content-type"]).toMatch(/^application\/octet-stream/);
            expect(html.headers["content-disposition"]).toMatch(/^attachment;/);
            expect(html.headers["x-content-type-options"]).toBe("nosniff");

            const svg = await auth(request(ctx.app()).get(url(`/attachments/${(await attach("image/svg+xml", true)).uid}/content`)), owner);
            expect(svg.headers["content-type"]).toMatch(/^application\/octet-stream/);

            const png = await auth(request(ctx.app()).get(url(`/attachments/${(await attach("IMAGE/PNG", true)).uid}/content`)), owner);
            expect(png.headers["content-type"]).toMatch(/^image\/png/);
            expect(png.headers["content-disposition"]).toMatch(/^inline;/);
        });

        it("message content carries nosniff and a sandboxing CSP", async () => {
            const mailbox = await createMailbox(owner.uid);
            const inbox = await createFolder(mailbox.uid);
            const message = await createMessage(mailbox, inbox.uid);
            const result = await auth(request(ctx.app()).get(url(`/messages/${message.uid}/content`)), owner);
            expect(result.status).toBe(200);
            expect(result.headers["x-content-type-options"]).toBe("nosniff");
            expect(result.headers["content-security-policy"]).toBe("default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; sandbox");
        });
    });

    describe("focused inbox overrides and search (findings 14, 15)", () => {
        it("normalizes the sender and keeps one override per sender", async () => {
            const mailbox = await createMailbox(owner.uid);
            const first = await auth(request(ctx.app()).post(url("/focused-inbox-overrides")), owner).send({
                mailboxUid: mailbox.uid,
                senderAddress: "  Bob@Example.NET ",
                classifyAs: "other",
            });
            expect(first.status).toBe(200);
            expect(first.body.senderAddress).toBe("bob@example.net");

            const second = await auth(request(ctx.app()).post(url("/focused-inbox-overrides")), owner).send({
                mailboxUid: mailbox.uid,
                senderAddress: "bob@example.net",
                classifyAs: "focused",
            });
            expect(second.status).toBe(200);
            expect(second.body.uid).toBe(first.body.uid);
            expect(second.body.classifyAs).toBe("focused");
            const listed = await auth(request(ctx.app()).get(url(`/focused-inbox-overrides?mailboxUid=${mailbox.uid}`)), owner);
            expect(listed.body).toHaveLength(1);
        });

        it("accepts a label-only search, and searches a readable shared mailbox via mailboxUid", async () => {
            const own = await createMailbox(owner.uid);
            const shared = await createMailbox(other.uid);
            await ctx.saveAcl({
                uid: shared.uid,
                parentUid: "Mailbox",
                records: [
                    { userOrRoleId: other.uid, actions: ["*"] },
                    { userOrRoleId: owner.uid, actions: ["read", "list"] },
                ],
            });
            const provider = ctx.searchProvider();
            const searchSpy = vi.spyOn(provider, "search");
            const candidatesSpy = vi.spyOn(provider, "candidates");
            try {
                const labelOnly = await auth(request(ctx.app()).get(url(`/search?label=${uuid.v4()}`)), owner);
                expect(labelOnly.status).toBe(200);
                expect(searchSpy.mock.lastCall?.[0].mailboxUid).toBe(own.uid);

                const inShared = await auth(request(ctx.app()).get(url(`/search?q=hello&mailboxUid=${encodeURIComponent(shared.uid)}`)), owner);
                expect(inShared.status).toBe(200);
                expect(searchSpy.mock.lastCall?.[0].mailboxUid).toBe(shared.uid);

                const candidates = await auth(request(ctx.app()).get(url(`/search/candidates?mailboxUid=${encodeURIComponent(shared.uid)}`)), owner);
                expect(candidates.status).toBe(200);
                expect(candidatesSpy.mock.lastCall?.[0].mailboxUid).toBe(shared.uid);

                const notShared = await auth(request(ctx.app()).get(url(`/search?q=hello&mailboxUid=${encodeURIComponent(own.uid)}`)), other);
                expect(notShared.status).toBe(404);
                const notSharedCandidates = await auth(request(ctx.app()).get(url(`/search/candidates?mailboxUid=${encodeURIComponent(own.uid)}`)), other);
                expect(notSharedCandidates.status).toBe(404);
            } finally {
                searchSpy.mockRestore();
                candidatesSpy.mockRestore();
            }
        });

        it("refuses a malformed mailboxUid (400) and an unknown one (404)", async () => {
            await createMailbox(owner.uid);
            expect((await auth(request(ctx.app()).get(url("/search?q=hello&mailboxUid=")), owner)).status).toBe(400);
            expect((await auth(request(ctx.app()).get(url(`/search/candidates?mailboxUid=${uuid.v4()}@example.com`)), owner)).status).toBe(404);
        });
    });

    describe("edge cases", () => {
        it("share tokens on a scoped child route: unknown, other-folder and expired links grant nothing", async () => {
            const mailbox = await createMailbox(owner.uid);
            const calendar = await createFolder(mailbox.uid, FolderType.CALENDAR);
            const otherCalendar = await createFolder(mailbox.uid, FolderType.CALENDAR);
            const list = (token: string, folderUid = calendar.uid) =>
                request(ctx.app()).head(url(`/calendar-events?folderUid=${folderUid}&shareToken=${token}`));

            expect((await list("A".repeat(43))).headers["content-length"]).toBe("0");
            const link = await auth(request(ctx.app()).post(url("/calendar-share-links")), owner).send({
                folderUid: calendar.uid,
                permittedActions: ["*"],
                createdByUserUid: owner.uid,
            });
            await ctx.saveAcl({ uid: otherCalendar.uid, parentUid: mailbox.uid, records: [{ userOrRoleId: `share:${link.body.token}`, actions: ["*"] }] });
            expect((await list(link.body.token, otherCalendar.uid)).headers["content-length"]).toBe("0");
            expect((await list(link.body.token)).status).toBe(200);
            await ctx.update("CalendarShareLink", link.body.uid, { expiresAt: new Date(Date.now() - 1000) });
            const expired = await request(ctx.app()).get(url(`/calendar-events?folderUid=${calendar.uid}&shareToken=${link.body.token}`));
            expect(expired.body).toEqual([]);
        });

        it("a non-string scope in an update is refused (400)", async () => {
            const mailbox = await createMailbox(owner.uid);
            const inbox = await createFolder(mailbox.uid);
            const message = await createMessage(mailbox, inbox.uid);
            const result = await auth(request(ctx.app()).put(url(`/messages/${message.uid}`)), owner).send({
                uid: message.uid,
                version: message.version,
                folderUid: [inbox.uid],
            });
            expect(result.status).toBe(400);
        });

        it("trusted callers keep full control of folder counters, message dates and folder creation input", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid, FolderType.USER);
            const counters = await auth(request(ctx.app()).put(url(`/folders/${folder.uid}`)), admin).send({
                uid: folder.uid,
                version: folder.version,
                unreadCount: 3,
            });
            expect(counters.status).toBe(200);
            expect(counters.body.unreadCount).toBe(3);
            const renamed = await auth(request(ctx.app()).put(url(`/folders/${folder.uid}/name`)), owner).send("Renamed" as any);
            expect(renamed.status).toBe(200);
            const arrayMailbox = await auth(request(ctx.app()).post(url("/folders")), admin).send({ mailboxUid: [mailbox.uid], name: "X", type: FolderType.USER });
            expect(arrayMailbox.status).toBe(403);

            const inbox = await createFolder(mailbox.uid);
            const imported = await auth(request(ctx.app()).post(url("/messages")), admin).send(
                draftBody({ mailboxUid: mailbox.uid, folderUid: inbox.uid, from: { address: "x@example.net", type: "to" }, sentDate: "2001-01-01T00:00:00.000Z" }),
            );
            expect(imported.status).toBe(200);
            expect(new Date(imported.body.sentDate).getUTCFullYear()).toBe(2001);
        });

        it("legal hold dates stored as strings are still compared", async () => {
            const mailbox = await createMailbox(owner.uid);
            const inbox = await createFolder(mailbox.uid);
            const message = await createMessage(mailbox, inbox.uid);
            await ctx.update("Message", message.uid, { sentDate: "2025-01-01T00:00:00.000Z" });
            const matter = await ctx.save("Matter", {
                name: "Hold",
                escrowScopeId: uuid.v4(),
                custodianMailboxUids: [mailbox.uid],
                dateRangeStart: new Date("2024-01-01"),
                dateRangeEnd: new Date("2026-01-01"),
            });
            await ctx.update("Matter", matter.uid, { dateRangeStart: "2024-01-01T00:00:00.000Z", dateRangeEnd: "2026-01-01T00:00:00.000Z" });
            expect((await auth(request(ctx.app()).delete(url(`/messages/${message.uid}?purge=true`)), owner)).status).toBe(409);
        });

        it("mailbox address validation: non-list aliases, unverified alias domains, malformed create addresses", async () => {
            const mailbox = await createMailbox(owner.uid);
            const notList = await auth(request(ctx.app()).put(url(`/mailboxes/${mailbox.uid}`)), admin).send({
                uid: mailbox.uid,
                version: mailbox.version,
                aliasAddresses: "a@example.com",
            });
            expect(notList.status).toBe(400);
            const createNotList = await auth(request(ctx.app()).post(url("/mailboxes")), admin).send({
                primarySmtpAddress: `${uuid.v4()}@example.com`,
                aliasAddresses: "a@example.com",
                displayName: "X",
                timezone: "UTC",
            });
            expect(createNotList.status).toBe(400);
            const createMalformed = await auth(request(ctx.app()).post(url("/mailboxes")), admin).send({
                primarySmtpAddress: `a(b)@example.com`,
                aliasAddresses: [],
                displayName: "X",
                timezone: "UTC",
            });
            expect(createMalformed.status).toBe(400);

            await ctx.save("Domain", { uid: "example.com", name: "example.com", enabled: true, verified: true, verificationToken: uuid.v4() });
            const unverified = await auth(request(ctx.app()).put(url(`/mailboxes/${mailbox.uid}`)), admin).send({
                uid: mailbox.uid,
                version: mailbox.version,
                aliasAddresses: [`x-${uuid.v4()}@unverified.example`],
            });
            expect(unverified.status).toBe(400);
        });

        it("focused inbox overrides: bulk create, invalid sender, renaming onto another override", async () => {
            const mailbox = await createMailbox(owner.uid);
            const bulk = await auth(request(ctx.app()).post(url("/focused-inbox-overrides")), owner).send([
                { mailboxUid: mailbox.uid, senderAddress: "A@example.net", classifyAs: "other" },
                { mailboxUid: mailbox.uid, senderAddress: "b@example.net", classifyAs: "other" },
            ]);
            expect(bulk.status).toBe(200);
            expect(bulk.body.map((o: any) => o.senderAddress)).toEqual(["a@example.net", "b@example.net"]);

            const invalid = await auth(request(ctx.app()).post(url("/focused-inbox-overrides")), owner).send({
                mailboxUid: mailbox.uid,
                senderAddress: 42,
                classifyAs: "other",
            });
            expect(invalid.status).toBe(400);

            // Someone without access to the mailbox can't add an override to it for a new sender (the create's own
            // permission failure is surfaced as-is, not treated as a lost create race).
            const intruder = await auth(request(ctx.app()).post(url("/focused-inbox-overrides")), other).send({
                mailboxUid: mailbox.uid,
                senderAddress: "intruder@example.net",
                classifyAs: "focused",
            });
            expect(intruder.status).toBe(403);
            const afterIntruder = await auth(request(ctx.app()).get(url(`/focused-inbox-overrides?mailboxUid=${mailbox.uid}`)), owner);
            expect(afterIntruder.body.map((o: any) => o.senderAddress).sort()).toEqual(["a@example.net", "b@example.net"]);

            const [a, b] = bulk.body;
            const onto = await auth(request(ctx.app()).put(url(`/focused-inbox-overrides/${b.uid}`)), owner).send({
                uid: b.uid,
                version: b.version,
                senderAddress: " A@EXAMPLE.NET",
            });
            expect(onto.status).toBe(409);
            const renamed = await auth(request(ctx.app()).put(url(`/focused-inbox-overrides/${b.uid}`)), owner).send({
                uid: b.uid,
                version: b.version,
                senderAddress: "C@example.net",
            });
            expect(renamed.status).toBe(200);
            expect(renamed.body.senderAddress).toBe("c@example.net");
            const reclassified = await auth(request(ctx.app()).put(url(`/focused-inbox-overrides/${a.uid}`)), owner).send({
                uid: a.uid,
                version: a.version,
                classifyAs: "focused",
            });
            expect(reclassified.status).toBe(200);
        });

        it("mail filter rules: no actions, non-string targets, own label, moving a rule to another mailbox", async () => {
            const mine = await createMailbox(owner.uid);
            const second = await createMailbox(owner.uid);
            const myFolder = await createFolder(mine.uid, FolderType.USER);
            const myLabel = await ctx.save("Label", { mailboxUid: mine.uid, name: "mine" });
            const base = { name: "Rule", enabled: true, sequence: 1, stopProcessingRules: false, conditions: { fromContains: ["x"] } };
            const post = (body: any) => auth(request(ctx.app()).post(url("/mail-filter-rules")), owner).send(body);

            expect((await post({ ...base, mailboxUid: mine.uid })).status).toBe(200);
            expect((await post({ ...base, mailboxUid: mine.uid, actions: [{ type: "move_to_folder", folderUid: 7 }] })).status).toBe(400);
            expect((await post({ ...base, mailboxUid: mine.uid, actions: [{ type: "apply_label", labelUid: 7 }] })).status).toBe(400);
            const ok = await post({
                ...base,
                mailboxUid: mine.uid,
                actions: [
                    { type: "apply_label", labelUid: myLabel.uid },
                    { type: "move_to_folder", folderUid: myFolder.uid },
                ],
            });
            expect(ok.status).toBe(200);
            const moved = await auth(request(ctx.app()).put(url(`/mail-filter-rules/${ok.body.uid}`)), owner).send({
                uid: ok.body.uid,
                version: ok.body.version,
                mailboxUid: second.uid,
            });
            expect(moved.status).toBe(400);
            const renamed = await auth(request(ctx.app()).put(url(`/mail-filter-rules/${ok.body.uid}`)), owner).send({
                uid: ok.body.uid,
                version: ok.body.version,
                name: "Renamed",
            });
            expect(renamed.status).toBe(200);
        });

        it("quarantine: a trusted create never carries a release, and a release is stamped once", async () => {
            const mailbox = await createMailbox(owner.uid);
            const created = await auth(request(ctx.app()).post(url("/quarantine")), admin).send({
                mailboxUid: mailbox.uid,
                reason: QuarantineReason.SPAM_POLICY,
                scanResultUid: uuid.v4(),
                rawBlobKey: "raw/3",
                releasedAt: new Date().toISOString(),
                releasedByUserUid: owner.uid,
            });
            expect(created.status).toBe(200);
            expect(created.body.releasedAt ?? undefined).toBeUndefined();

            const first = await auth(request(ctx.app()).put(url(`/quarantine/${created.body.uid}`)), admin).send({
                uid: created.body.uid,
                version: created.body.version,
                releasedAt: "now",
            });
            expect(first.status).toBe(200);
            const again = await auth(request(ctx.app()).put(url(`/quarantine/${created.body.uid}`)), admin).send({
                uid: created.body.uid,
                version: first.body.version,
                releasedAt: "later",
            });
            expect(again.status).toBe(200);
            expect(new Date(again.body.releasedAt).getTime()).toBe(new Date(first.body.releasedAt).getTime());
        });
    });
}
