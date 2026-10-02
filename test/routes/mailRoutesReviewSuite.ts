///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Review fixes for the mail routes (blob keys, soft-deleted folders, elevation of administrative writes, abuse limits...),
// identical on both backends. `test/routes/{mongo,sql}/MailRoutesReview.test.ts` supply a started server and raw row helpers;
// everything under test goes through HTTP.
import { request } from "@rapidrest/service-core/test";
import * as uuid from "uuid";
import { FolderType, MessageImportance, RecipientType } from "../../src/models/types.js";
import type { InMemoryBlobStore, RecordingMailTransport } from "../testDoubles.js";

/** Row kinds `save()`/`findOne()` accept - each maps to the backend's concrete model class (`<kind>SQL`/`<kind>Mongo`). */
export type ReviewRowKind = string;

export interface MailRoutesReviewSuiteContext {
    app: () => any;
    /** `"/mongo"` or `"/sql"`. */
    prefix: string;
    tokenFor: (user: any) => string;
    /** Saves a raw row (bypassing every route), returning it as stored. */
    save: (kind: ReviewRowKind, fields: Record<string, any>) => Promise<any>;
    /** The stored row, raw (a Mongo document includes `_id`). */
    findOne: (kind: ReviewRowKind, uid: string) => Promise<any | undefined>;
    count: (kind: ReviewRowKind) => Promise<number>;
    /** Every stored row of `kind`, raw. */
    findAll: (kind: ReviewRowKind) => Promise<any[]>;
    /** Sets fields on a stored row directly. */
    update: (kind: ReviewRowKind, uid: string, fields: Record<string, any>) => Promise<void>;
    saveAcl: (acl: { uid: string; parentUid?: string; records: { userOrRoleId: string; actions: string[] }[] }) => Promise<void>;
    findAcl: (uid: string) => Promise<any | undefined>;
    /** The registered `SearchProvider` double. */
    searchProvider: () => any;
    /** The bearer secret of `/internal/mta/*`. */
    ingestSecret: string;
    blobStore: () => InMemoryBlobStore;
    transport: () => RecordingMailTransport;
}

export function mailRoutesReviewSuite(ctx: MailRoutesReviewSuiteContext): void {
    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const other: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    /** A trusted administrator whose token was never stepped up. */
    const plainAdmin: any = { uid: uuid.v4(), roles: ["admin"] };
    const auth = (req: any, user: any) => req.set("Authorization", "jwt " + ctx.tokenFor(user));
    const url = (path: string) => `${ctx.prefix}${path}`;

    const createMailbox = async (ownerUid: string | undefined, fields: Record<string, any> = {}) => {
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
        await ctx.saveAcl({
            uid: mailbox.uid,
            parentUid: "Mailbox",
            records: ownerUid ? [{ userOrRoleId: ownerUid, actions: ["*"] }] : [],
        });
        return mailbox;
    };
    const grant = async (mailbox: any, userUid: string, actions: string[] = ["*"]) =>
        await ctx.saveAcl({
            uid: mailbox.uid,
            parentUid: "Mailbox",
            records: [
                ...(mailbox.ownerUserUid ? [{ userOrRoleId: mailbox.ownerUserUid, actions: ["*"] }] : []),
                { userOrRoleId: userUid, actions },
            ],
        });
    const createFolder = async (mailboxUid: string, type: FolderType = FolderType.INBOX, fields: Record<string, any> = {}) => {
        const folder = await ctx.save("Folder", { mailboxUid, name: type, type, unreadCount: 0, totalCount: 0, syncKeyVersion: 0, ...fields });
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
        ...fields,
    });

    describe("server-managed blob keys (A1, B1, X1-01, X1-05)", () => {
        it("a trusted caller can't set a message's blob keys on create or update", async () => {
            const mine = await createMailbox(admin.uid);
            const drafts = await createFolder(mine.uid, FolderType.DRAFTS);
            const created = await auth(request(ctx.app()).post(url("/messages")), admin).send(
                draftBody({
                    folderUid: drafts.uid,
                    bodyBlobKey: "ingest/victim",
                    sanitizedHtmlBlobKey: "sanitized/victim",
                    retainedBodyBlobKeys: ["bodies/victim"],
                    scanResultUid: "scan",
                    encrypted: true,
                }),
            );
            expect(created.status).toBe(200);
            const stored = await ctx.findOne("Message", created.body.uid);
            for (const field of ["bodyBlobKey", "sanitizedHtmlBlobKey", "scanResultUid"]) {
                expect(stored[field] || undefined).toBeUndefined();
            }
            expect(stored.retainedBodyBlobKeys?.length ?? 0).toBe(0);
            expect(stored.encrypted ?? false).toBe(false);

            const message = await createMessage(mine, drafts.uid, { bodyBlobKey: "bodies/mine" });
            const updated = await auth(request(ctx.app()).put(url(`/messages/${message.uid}`)), admin).send({
                uid: message.uid,
                version: message.version,
                subject: "Edited",
                bodyBlobKey: "ingest/victim",
                sanitizedHtmlBlobKey: "sanitized/victim",
                retainedBodyBlobKeys: ["bodies/victim"],
            });
            expect(updated.status).toBe(200);
            const after = await ctx.findOne("Message", message.uid);
            expect(after.subject).toBe("Edited");
            expect(after.bodyBlobKey).toBe("bodies/mine");
            expect(after.sanitizedHtmlBlobKey || undefined).toBeUndefined();
            expect(after.retainedBodyBlobKeys?.length ?? 0).toBe(0);
        });

        it("a trusted caller can't set an attachment's blob keys", async () => {
            const mine = await createMailbox(admin.uid);
            const drafts = await createFolder(mine.uid, FolderType.DRAFTS);
            const message = await createMessage(mine, drafts.uid);
            const attachment = await ctx.save("Attachment", {
                mailboxUid: mine.uid,
                folderUid: drafts.uid,
                messageUid: message.uid,
                filename: "a.txt",
                mimeType: "text/plain",
                sizeBytes: 3,
                blobKey: "attachments/mine",
            });
            const updated = await auth(request(ctx.app()).put(url(`/attachments/${attachment.uid}`)), admin).send({
                uid: attachment.uid,
                version: attachment.version,
                blobKey: "ingest/victim",
                extractedTextBlobKey: "ingest/victim",
            });
            expect(updated.status).toBe(200);
            const after = await ctx.findOne("Attachment", attachment.uid);
            expect(after.blobKey).toBe("attachments/mine");
            expect(after.extractedTextBlobKey ?? undefined).toBeUndefined();
        });

        it("ingest-queue and quarantine entries can't be created through the API, and their rawBlobKey can't be changed", async () => {
            const mine = await createMailbox(admin.uid);
            const created = await auth(request(ctx.app()).post(url("/ingest-queue")), admin).send({
                mailboxUid: mine.uid,
                rawBlobKey: "ingest/victim",
                envelopeFrom: "a@example.net",
                envelopeTo: [mine.primarySmtpAddress],
            });
            expect(created.status).toBe(403);
            expect(await ctx.count("IngestQueueEntry")).toBe(0);
            const quarantined = await auth(request(ctx.app()).post(url("/quarantine")), admin).send({
                mailboxUid: mine.uid,
                rawBlobKey: "ingest/victim",
            });
            expect(quarantined.status).toBe(403);

            const entry = await ctx.save("IngestQueueEntry", {
                mailboxUid: mine.uid,
                rawBlobKey: "ingest/real",
                envelopeFrom: "a@example.net",
                envelopeTo: [mine.primarySmtpAddress],
                status: "pending",
            });
            const updated = await auth(request(ctx.app()).put(url(`/ingest-queue/${entry.uid}`)), admin).send({
                uid: entry.uid,
                version: entry.version,
                rawBlobKey: "ingest/victim",
            });
            expect(updated.status).toBe(200);
            expect((await ctx.findOne("IngestQueueEntry", entry.uid)).rawBlobKey).toBe("ingest/real");
        });
    });


    describe("mailbox administration (B3, X1-02, A7, B12, A13)", () => {
        it("an owner change needs an elevated administrator, who can't hand themselves a mailbox they hold no grant on", async () => {
            const victim = await createMailbox(other.uid);
            const unelevated = await auth(request(ctx.app()).put(url(`/mailboxes/${victim.uid}`)), plainAdmin).send({
                uid: victim.uid,
                version: victim.version,
                ownerUserUid: owner.uid,
            });
            expect(unelevated.status).toBe(403);
            const toSelf = await auth(request(ctx.app()).put(url(`/mailboxes/${victim.uid}`)), admin).send({
                uid: victim.uid,
                version: victim.version,
                ownerUserUid: admin.uid,
            });
            expect(toSelf.status).toBe(403);
            expect((await ctx.findOne("Mailbox", victim.uid)).ownerUserUid).toBe(other.uid);
            const toThird = await auth(request(ctx.app()).put(url(`/mailboxes/${victim.uid}`)), admin).send({
                uid: victim.uid,
                version: victim.version,
                ownerUserUid: owner.uid,
            });
            expect(toThird.status).toBe(200);
            expect((await ctx.findOne("Mailbox", victim.uid)).ownerUserUid).toBe(owner.uid);
        });

        it("an elevation older than mail:security:elevation_max_age_seconds (900) no longer opens an administrator's endpoints (R2-08)", async () => {
            const a = await createMailbox(other.uid);
            const stale: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() - 16 * 60_000 };
            const refused = await auth(request(ctx.app()).delete(url(`/mailboxes/${a.uid}`)), stale);
            expect(refused.status).toBe(403);
            expect(refused.body.code).toBe("api-104");
            expect(await ctx.count("Mailbox")).toBe(1);
            const fresh: any = { ...stale, elevated: Date.now() - 5 * 60_000 };
            expect((await auth(request(ctx.app()).delete(url(`/mailboxes/${a.uid}`)), fresh)).status).toBe(204);
        });

        it("truncating or deleting mailboxes needs an elevated administrator, and truncating needs a filter", async () => {
            const a = await createMailbox(other.uid);
            await createMailbox(owner.uid);
            expect((await auth(request(ctx.app()).delete(url("/mailboxes")), plainAdmin)).status).toBe(403);
            expect((await auth(request(ctx.app()).delete(url(`/mailboxes/${a.uid}`)), plainAdmin)).status).toBe(403);
            expect((await auth(request(ctx.app()).delete(url("/mailboxes")), admin)).status).toBe(400);
            expect((await auth(request(ctx.app()).delete(url("/mailboxes?limit=10")), admin)).status).toBe(400);
            // A parameter that isn't a field of a mailbox names no filter either.
            expect((await auth(request(ctx.app()).delete(url("/mailboxes?scope=admin")), admin)).status).toBe(400);
            expect((await auth(request(ctx.app()).delete(url("/mailboxes?nonsense=1&limit=10")), admin)).status).toBe(400);
            expect(await ctx.count("Mailbox")).toBe(2);
            expect((await auth(request(ctx.app()).delete(url(`/mailboxes/${a.uid}`)), admin)).status).toBe(204);
            expect(await ctx.count("Mailbox")).toBe(1);
        });

        it("an owner can't turn their mailbox into a bookable resource", async () => {
            const mine = await createMailbox(owner.uid);
            const res = await auth(request(ctx.app()).put(url(`/mailboxes/${mine.uid}`)), owner).send({
                uid: mine.uid,
                version: mine.version,
                isResource: true,
                autoAcceptBookings: true,
            });
            expect(res.status).toBe(403);
            expect((await ctx.findOne("Mailbox", mine.uid)).isResource ?? false).toBe(false);
            // A full object round-tripped with the unset values still saves.
            const same = await auth(request(ctx.app()).put(url(`/mailboxes/${mine.uid}`)), owner).send({
                uid: mine.uid,
                version: mine.version,
                isResource: false,
                displayName: "Renamed",
            });
            expect(same.status).toBe(200);
        });

        it("a delegate can't wipe the owner's published keys with an empty value", async () => {
            const mine = await createMailbox(owner.uid, { keys: [{ fingerprint: "ab", certificate: "x" }], keyDiscoveryHash: "hash" });
            await grant(mine, other.uid, ["read", "list", "count", "exists", "update"]);
            const res = await auth(request(ctx.app()).put(url(`/mailboxes/${mine.uid}`)), other).send({
                uid: mine.uid,
                version: mine.version,
                keys: [],
                keyDiscoveryHash: "",
                displayName: "Delegate edit",
            });
            expect(res.status).toBe(200);
            const after = await ctx.findOne("Mailbox", mine.uid);
            expect(after.displayName).toBe("Delegate edit");
            expect(after.keyDiscoveryHash).toBe("hash");
            expect(after.keys?.length).toBe(1);
        });
    });


    describe("retention, exports, erasure approval and imports (A5, X1-03, A8, A23, A9)", () => {
        it("the message retention period needs an elevated administrator, a floor of 30 days, and records the previous value", async () => {
            const put = (user: any, body: any) => auth(request(ctx.app()).put(url("/retention-policy")), user).send(body);
            expect((await put(plainAdmin, { messageRetentionDays: 365 })).status).toBe(403);
            expect((await put(admin, { messageRetentionDays: 1 })).status).toBe(400);
            expect((await put(admin, { messageRetentionDays: 365 })).status).toBe(200);
            expect((await put(admin, { messageRetentionDays: 90 })).status).toBe(200);
            expect((await put(admin, { messageRetentionDays: null })).status).toBe(200);
            const entries = (await ctx.findAll("AuditLogEntry")).filter((e) => e.action === "retention_policy.update");
            expect(entries.length).toBe(3);
            expect(entries.some((e) => e.details?.previous?.messageRetentionDays === 365)).toBe(true);
        });

        it("exporting another mailbox needs an elevated administrator, and only one export per mailbox runs at a time", async () => {
            const victim = await createMailbox(other.uid);
            const body = { mailboxUid: victim.uid, format: "json" };
            expect((await auth(request(ctx.app()).post(url("/data-export-requests")), plainAdmin).send(body)).status).toBe(403);
            const first = await auth(request(ctx.app()).post(url("/data-export-requests")), admin).send(body);
            expect(first.status).toBe(200);
            expect((await auth(request(ctx.app()).post(url("/data-export-requests")), admin).send(body)).status).toBe(409);
            // Without elevation an administrator neither lists nor reads another mailbox's export.
            expect((await auth(request(ctx.app()).get(url("/data-export-requests")), plainAdmin)).body).toEqual([]);
            expect((await auth(request(ctx.app()).get(url(`/data-export-requests/${first.body.uid}`)), plainAdmin)).status).toBe(403);
            expect((await auth(request(ctx.app()).get(url(`/data-export-requests/${first.body.uid}`)), other)).status).toBe(200);
        });

        it("an erasure request is approved by an elevated administrator other than the requester", async () => {
            const victim = await createMailbox(other.uid);
            const second: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
            const pending = await ctx.save("DataSubjectErasureRequest", {
                mailboxUid: victim.uid,
                requestedByUserUid: admin.uid,
                status: "pending",
            });
            const approve = (user: any) => auth(request(ctx.app()).post(url(`/erasure-requests/${pending.uid}/approve`)), user).send();
            expect((await approve(plainAdmin)).status).toBe(403);
            expect((await approve(admin)).status).toBe(403);
            expect((await ctx.findOne("DataSubjectErasureRequest", pending.uid)).status).toBe("pending");
            expect((await approve(second)).status).toBe(200);
            expect((await ctx.findOne("DataSubjectErasureRequest", pending.uid)).status).toBe("approved");
        });

        it("a second import into a mailbox is refused while one is pending", async () => {
            const mine = await createMailbox(owner.uid);
            const inbox = await createFolder(mine.uid);
            await ctx.save("MailboxImportRequest", {
                mailboxUid: mine.uid,
                requestedByUserUid: owner.uid,
                targetFolderUid: inbox.uid,
                format: "mbox",
                sourceBlobKey: "mailbox-imports/x",
                status: "pending",
            });
            const res = await auth(request(ctx.app()).post(url(`/mailbox-import-requests?format=mbox&targetFolderUid=${inbox.uid}`)), owner)
                .set("Content-Type", "application/mbox")
                .send(Buffer.from(["From x", "", ""].join(String.fromCharCode(13, 10))));
            expect(res.status).toBe(409);
        });
    });


    describe("message audit, recall, legal hold and drafts (A10, B6, B11, A18, B15, A19)", () => {
        it("a deleted message's subject is not written to the audit log", async () => {
            const mine = await createMailbox(owner.uid);
            const inbox = await createFolder(mine.uid);
            const message = await createMessage(mine, inbox.uid, { subject: "Confidential subject line" });
            expect((await auth(request(ctx.app()).delete(url(`/messages/${message.uid}`)), owner)).status).toBe(204);
            const entries = (await ctx.findAll("AuditLogEntry")).filter((e) => e.action === "message.delete");
            expect(entries).toHaveLength(1);
            expect(JSON.stringify(entries[0].details)).not.toContain("Confidential");
        });

        it("a recall doesn't name Bcc recipients in To, goes out once and refuses a message to too many recipients", async () => {
            const mine = await createMailbox(owner.uid);
            const sent = await createFolder(mine.uid, FolderType.SENT_ITEMS);
            const message = await createMessage(mine, sent.uid, {
                sentByServerAt: new Date(),
                recipients: [
                    { address: "to@example.net", type: RecipientType.TO },
                    { address: "hidden@example.net", type: RecipientType.BCC },
                ],
            });
            const first = await auth(request(ctx.app()).post(url(`/messages/${message.uid}/recall`)), owner);
            expect(first.status).toBe(200);
            const outgoing = ctx.transport().sent;
            expect(outgoing).toHaveLength(1);
            expect(outgoing[0].envelopeTo).toEqual(["to@example.net", "hidden@example.net"]);
            expect(outgoing[0].raw.toString().toLowerCase()).not.toContain("hidden@example.net");
            expect((await auth(request(ctx.app()).post(url(`/messages/${message.uid}/recall`)), owner)).status).toBe(409);
            expect(ctx.transport().sent).toHaveLength(1);

            const crowd = await createMessage(mine, sent.uid, {
                recipients: Array.from({ length: 101 }, (_, i) => ({ address: `r${i}@example.net`, type: RecipientType.TO })),
                sentByServerAt: new Date(),
            });
            expect((await auth(request(ctx.app()).post(url(`/messages/${crowd.uid}/recall`)), owner)).status).toBe(400);
            expect(ctx.transport().sent).toHaveLength(1);
        });

        it("the subject and recipients of a message under an open legal hold can't be rewritten, but its flags can", async () => {
            const mine = await createMailbox(owner.uid);
            const inbox = await createFolder(mine.uid);
            const drafts = await createFolder(mine.uid, FolderType.DRAFTS);
            const message = await createMessage(mine, inbox.uid, { sentDate: new Date("2025-01-01") });
            const draft = await createMessage(mine, drafts.uid, { sentDate: new Date("2025-01-01") });
            await ctx.save("Matter", {
                name: "Hold",
                escrowScopeId: uuid.v4(),
                custodianMailboxUids: [mine.uid],
                dateRangeStart: new Date("2024-01-01"),
                dateRangeEnd: new Date("2030-01-01"),
            });
            const put = (uid: string, version: number, fields: any) =>
                auth(request(ctx.app()).put(url(`/messages/${uid}`)), owner).send({ uid, version, ...fields });
            expect((await put(message.uid, message.version, { subject: "Rewritten" })).status).toBe(409);
            expect((await put(message.uid, message.version, { recipients: [{ address: "x@example.net", type: "to" }] })).status).toBe(409);
            expect((await ctx.findOne("Message", message.uid)).subject).toBe("Subject");
            // The unchanged values, as a round-tripped object carries them, and the flags still save.
            const same = await put(message.uid, message.version, {
                subject: "Subject",
                recipients: [{ address: "recipient@example.net", type: "to" }],
                flags: { read: true, flagged: false, answered: false, forwarded: false },
            });
            expect(same.status).toBe(200);
            // A sender with a display name it didn't have is a change as well.
            expect((await put(message.uid, message.version, { from: { address: mine.primarySmtpAddress, type: "to", displayName: "Somebody Else" } })).status).toBe(409);
            // A draft is being written: it isn't frozen.
            expect((await put(draft.uid, draft.version, { subject: "Edited draft" })).status).toBe(200);
        });

        it("a draft can't be moved into the Inbox to pass for received mail, only thrown away", async () => {
            const mine = await createMailbox(owner.uid);
            const inbox = await createFolder(mine.uid);
            const drafts = await createFolder(mine.uid, FolderType.DRAFTS);
            const deleted = await createFolder(mine.uid, FolderType.DELETED_ITEMS);
            const draft = await createMessage(mine, drafts.uid);
            const move = (folderUid: string, version: number) =>
                auth(request(ctx.app()).put(url(`/messages/${draft.uid}`)), owner).send({ uid: draft.uid, version, folderUid });
            expect((await move(inbox.uid, draft.version)).status).toBe(403);
            expect((await ctx.findOne("Message", draft.uid)).folderUid).toBe(drafts.uid);
            expect((await move(deleted.uid, draft.version)).status).toBe(200);
        });
    });


    describe("folders and calendar share links (A14, A16, X1-11)", () => {
        it("a trusted caller can't move a folder into another mailbox by updating its mailboxUid", async () => {
            const mine = await createMailbox(admin.uid);
            const victim = await createMailbox(other.uid);
            const folder = await createFolder(mine.uid, FolderType.USER);
            const res = await auth(request(ctx.app()).put(url(`/folders/${folder.uid}`)), admin).send({
                uid: folder.uid,
                version: folder.version,
                name: "Renamed",
                mailboxUid: victim.uid,
            });
            expect(res.status).toBe(200);
            const after = await ctx.findOne("Folder", folder.uid);
            expect(after.name).toBe("Renamed");
            expect(after.mailboxUid).toBe(mine.uid);
        });

        it("a share link grants only reads the creator holds, on a calendar, in the creator's name and with an expiry", async () => {
            const mine = await createMailbox(owner.uid);
            const calendar = await createFolder(mine.uid, FolderType.CALENDAR);
            const inbox = await createFolder(mine.uid, FolderType.INBOX);
            // Set before anything reads the folder's access list (it is cached).
            await ctx.saveAcl({
                uid: calendar.uid,
                parentUid: mine.uid,
                records: [{ userOrRoleId: other.uid, actions: ["create", "list"] }],
            });
            const post = (user: any, body: any) => auth(request(ctx.app()).post(url("/calendar-share-links")), user).send(body);
            expect((await post(owner, { folderUid: calendar.uid, permittedActions: ["update"] })).status).toBe(400);
            expect((await post(owner, { folderUid: calendar.uid, permittedActions: [] })).status).toBe(400);
            expect((await post(owner, { folderUid: inbox.uid, permittedActions: ["read"] })).status).toBe(400);
            const ok = await post(owner, { folderUid: calendar.uid, permittedActions: ["read", "list"], createdByUserUid: other.uid });
            expect(ok.status).toBe(200);
            const stored = await ctx.findOne("CalendarShareLink", ok.body.uid);
            expect(stored.createdByUserUid).toBe(owner.uid);
            expect(new Date(stored.expiresAt).getTime()).toBeGreaterThan(Date.now());

            // A delegate who may create but not read can't mint a link that reads.
            expect((await post(other, { folderUid: calendar.uid, permittedActions: ["read"] })).status).toBe(403);
            expect((await post(other, { folderUid: calendar.uid, permittedActions: ["list"] })).status).toBe(200);

            // Changing only when the link expires is no new grant: nothing is checked again, and the creator stays who made it.
            const later = new Date(Date.now() + 1000 * 60 * 60).toISOString();
            const extended = await auth(request(ctx.app()).put(url(`/calendar-share-links/${ok.body.uid}`)), owner).send({
                uid: ok.body.uid,
                version: ok.body.version,
                expiresAt: later,
                createdByUserUid: other.uid,
            });
            expect(extended.status).toBe(200);
            expect((await ctx.findOne("CalendarShareLink", ok.body.uid)).createdByUserUid).toBe(owner.uid);
        });
    });


    describe("key vault (A6, X1-14)", () => {
        const wrap = (fields: Record<string, any> = {}) => ({
            method: "password",
            ciphertext: "c",
            nonce: "n",
            salt: "s",
            kdf: "argon2id",
            schemeVersion: 1,
            ...fields,
        });

        it("a delegate with read access can't fetch the owner's key vault, and a shared mailbox's needs FULL", async () => {
            const mine = await createMailbox(owner.uid);
            await grant(mine, other.uid, ["read", "list", "update"]);
            await ctx.save("KeyVault", { mailboxUid: mine.uid, wrappedKeys: [], masterKeyWraps: [wrap({ createdAt: 1 })] });
            expect((await auth(request(ctx.app()).get(url(`/mailboxes/${mine.uid}/keyvault`)), owner)).status).toBe(200);
            expect((await auth(request(ctx.app()).get(url(`/mailboxes/${mine.uid}/keyvault`)), other)).status).toBe(403);

            const shared = await createMailbox(undefined);
            await ctx.saveAcl({
                uid: shared.uid,
                parentUid: "Mailbox",
                records: [
                    { userOrRoleId: other.uid, actions: ["read", "list"] },
                    { userOrRoleId: owner.uid, actions: ["*"] },
                ],
            });
            expect((await auth(request(ctx.app()).get(url(`/mailboxes/${shared.uid}/keyvault`)), other)).status).toBe(403);
            expect((await auth(request(ctx.app()).get(url(`/mailboxes/${shared.uid}/keyvault`)), owner)).status).toBe(200);
        });

        it("a master key wrap is stored with its own fields only", async () => {
            const mine = await createMailbox(owner.uid);
            const vault = await ctx.save("KeyVault", { mailboxUid: mine.uid, wrappedKeys: [], masterKeyWraps: [wrap({ createdAt: 1 })] });
            const res = await auth(request(ctx.app()).post(url(`/mailboxes/${mine.uid}/keyvault/wraps`)), owner).send(
                wrap({ method: "recovery", junk: "x".repeat(1000), createdAt: "tomorrow" }),
            );
            expect(res.status).toBe(200);
            const stored = (await ctx.findOne("KeyVault", vault.uid)).masterKeyWraps.find((w: any) => w.method === "recovery");
            expect(stored.junk).toBeUndefined();
            expect(typeof stored.createdAt).toBe("number");
        });
    });


    describe("distribution lists and mail filter rules (A22, X1-10, A3)", () => {
        it("a list's addresses are stored lowercase, and a rename is checked against a mailbox whatever its case", async () => {
            await createMailbox(other.uid, { primarySmtpAddress: "taken@example.com" });
            const created = await auth(request(ctx.app()).post(url("/distribution-lists")), admin).send({
                name: "Sales",
                primarySmtpAddress: "Sales@Example.COM",
                aliasAddresses: ["Team@Example.com"],
                memberAddresses: ["a@example.net"],
            });
            expect(created.status).toBe(200);
            expect(created.body.primarySmtpAddress).toBe("sales@example.com");
            expect(created.body.aliasAddresses).toEqual(["team@example.com"]);
            const stored = await ctx.findOne("DistributionList", created.body.uid);
            expect(stored.primarySmtpAddress).toBe("sales@example.com");

            const clash = await auth(request(ctx.app()).put(url(`/distribution-lists/${created.body.uid}`)), admin).send({
                uid: created.body.uid,
                version: created.body.version,
                primarySmtpAddress: "TAKEN@example.com",
            });
            expect(clash.status).toBe(409);
            // A free address is fine - and so is going back to the one the list was made with, which is its own uid.
            const renamed = await auth(request(ctx.app()).put(url(`/distribution-lists/${created.body.uid}`)), admin).send({
                uid: created.body.uid,
                version: created.body.version,
                primarySmtpAddress: "Renamed@Example.com",
            });
            expect(renamed.status).toBe(200);
            expect(renamed.body.primarySmtpAddress).toBe("renamed@example.com");
            const back = await auth(request(ctx.app()).put(url(`/distribution-lists/${created.body.uid}`)), admin).send({
                uid: created.body.uid,
                version: renamed.body.version,
                primarySmtpAddress: "sales@example.com",
            });
            expect(back.status).toBe(200);
            // An address among the list's own aliases is its own too.
            const toAlias = await auth(request(ctx.app()).put(url(`/distribution-lists/${created.body.uid}`)), admin).send({
                uid: created.body.uid,
                version: back.body.version,
                primarySmtpAddress: "team@example.com",
            });
            expect(toAlias.status).toBe(200);
            back.body.version = toAlias.body.version;
            expect((await auth(request(ctx.app()).put(url(`/distribution-lists/${created.body.uid}`)), admin).send({
                uid: created.body.uid,
                version: back.body.version,
                aliasAddresses: [5],
            })).status).toBe(400);
            const aliasClash = await auth(request(ctx.app()).put(url(`/distribution-lists/${created.body.uid}`)), admin).send({
                uid: created.body.uid,
                version: back.body.version,
                aliasAddresses: ["team@example.com", "Taken@Example.com"],
            });
            expect(aliasClash.status).toBe(409);
        });

        it("a mailbox has a bounded number of rules, and a bulk create is audited rule by rule", async () => {
            const mine = await createMailbox(owner.uid);
            const rule = (name: string) => ({
                mailboxUid: mine.uid,
                name,
                enabled: true,
                sequence: 0,
                stopProcessingRules: false,
                conditions: {},
                actions: [{ type: "mark_as_read" }],
            });
            const bulk = await auth(request(ctx.app()).post(url("/mail-filter-rules")), owner).send([rule("one"), rule("two")]);
            expect(bulk.status).toBe(200);
            expect((await ctx.findAll("AuditLogEntry")).filter((e) => e.action === "mail_filter_rule.create")).toHaveLength(2);
            for (let i = 0; i < 198; i++) {
                await ctx.save("MailFilterRule", rule(`filler ${i}`));
            }
            expect((await auth(request(ctx.app()).post(url("/mail-filter-rules")), owner).send(rule("one too many"))).status).toBe(400);
        });

        it("a forward action needs one plain address, a rule has a bounded number of actions, and a forward rule is audited", async () => {
            const mine = await createMailbox(owner.uid);
            const post = (actions: any[]) =>
                auth(request(ctx.app()).post(url("/mail-filter-rules")), owner).send({
                    mailboxUid: mine.uid,
                    name: "Forward",
                    enabled: true,
                    sequence: 0,
                    stopProcessingRules: false,
                    conditions: {},
                    actions,
                });
            for (const forwardTo of ["a@example.net, b@example.net", "Boss <boss@example.net>", "", undefined, "no-at-sign"]) {
                expect((await post([{ type: "forward", forwardTo }])).status).toBe(400);
            }
            expect((await post(Array.from({ length: 21 }, () => ({ type: "forward", forwardTo: "a@example.net" })))).status).toBe(400);
            expect(await ctx.count("MailFilterRule")).toBe(0);
            const ok = await post([{ type: "forward", forwardTo: "a@example.net" }]);
            expect(ok.status).toBe(200);
            const entries = (await ctx.findAll("AuditLogEntry")).filter((e) => e.action === "mail_filter_rule.create");
            expect(entries).toHaveLength(1);
            expect(entries[0].details.forwardsTo).toEqual(["a@example.net"]);
            const changed = await auth(request(ctx.app()).put(url(`/mail-filter-rules/${ok.body.uid}`)), owner).send({
                uid: ok.body.uid,
                version: ok.body.version,
                actions: [{ type: "forward", forwardTo: "evil@example.net" }],
            });
            expect(changed.status).toBe(200);
            const updates = (await ctx.findAll("AuditLogEntry")).filter((e) => e.action === "mail_filter_rule.update");
            expect(updates[0].details.forwardsTo).toEqual(["evil@example.net"]);
        });
    });

    describe("label delete (A11)", () => {
        it("strips the label from the messages that carry it, and only those", async () => {
            const mine = await createMailbox(owner.uid);
            const inbox = await createFolder(mine.uid);
            const label = await ctx.save("Label", { mailboxUid: mine.uid, name: "work" });
            const other1 = await ctx.save("Label", { mailboxUid: mine.uid, name: "home" });
            const tagged = await createMessage(mine, inbox.uid, { labelUids: [label.uid, other1.uid] });
            const plain = await createMessage(mine, inbox.uid, { labelUids: [other1.uid] });
            expect((await auth(request(ctx.app()).delete(url(`/labels/${label.uid}`)), owner)).status).toBe(204);
            expect((await ctx.findOne("Message", tagged.uid)).labelUids).toEqual([other1.uid]);
            expect((await ctx.findOne("Message", plain.uid)).labelUids).toEqual([other1.uid]);
        });
    });


    describe("matter custodians (B5)", () => {
        it("a matter can only hold mailboxes that exist and belong to its own escrow scope", async () => {
            const scope = await ctx.save("EscrowScope", {
                name: "legal",
                publicKey: { publicKey: "base64cert", type: "x509", fingerprint: "abc123", notBefore: 1000, notAfter: 2000 },
                holderUserUids: [owner.uid],
                requiredHolders: 1,
                notifySubjectOnAccess: false,
            });
            const inScope = await createMailbox(other.uid, { escrowScopeId: scope.uid });
            const outOfScope = await createMailbox(other.uid);
            const body = (custodianMailboxUids: string[]) => ({
                name: "Investigation",
                escrowScopeId: scope.uid,
                custodianMailboxUids,
                dateRangeStart: "2026-01-01",
                dateRangeEnd: "2026-06-01",
            });
            const post = (uids: string[]) => auth(request(ctx.app()).post(url("/matters")), owner).send(body(uids));
            expect((await post([outOfScope.uid])).status).toBe(400);
            expect((await post([inScope.uid, uuid.v4()])).status).toBe(400);
            expect(await ctx.count("Matter")).toBe(0);
            const ok = await post([inScope.uid]);
            expect(ok.status).toBe(200);
            const widen = await auth(request(ctx.app()).put(url(`/matters/${ok.body.uid}`)), owner).send({
                uid: ok.body.uid,
                version: ok.body.version,
                custodianMailboxUids: [inScope.uid, outOfScope.uid],
            });
            expect(widen.status).toBe(400);
            expect((await ctx.findOne("Matter", ok.body.uid)).custodianMailboxUids).toEqual([inScope.uid]);
            const property = await auth(request(ctx.app()).put(url(`/matters/${ok.body.uid}/custodianMailboxUids`)), owner).send([outOfScope.uid]);
            expect(property.status).toBe(400);
            expect((await auth(request(ctx.app()).put(url(`/matters/${ok.body.uid}/name`)), owner).send("Renamed" as any)).status).toBe(200);
            expect((await ctx.findOne("Matter", ok.body.uid)).custodianMailboxUids).toEqual([inScope.uid]);
        });

        it("an update that carries the custodian list unchanged isn't refused for a mailbox that has since left the scope or been deleted (X2-05)", async () => {
            const scope = await ctx.save("EscrowScope", {
                name: "legal",
                publicKey: { publicKey: "base64cert", type: "x509", fingerprint: "abc123", notBefore: 1000, notAfter: 2000 },
                holderUserUids: [owner.uid],
                requiredHolders: 1,
                notifySubjectOnAccess: false,
            });
            const inScope = await createMailbox(other.uid, { escrowScopeId: scope.uid });
            const matter = await ctx.save("Matter", {
                name: "Investigation",
                escrowScopeId: scope.uid,
                custodianMailboxUids: [inScope.uid, uuid.v4()],
                dateRangeStart: new Date("2026-01-01"),
                dateRangeEnd: new Date("2026-06-01"),
            });
            const put = (version: number, fields: any) => auth(request(ctx.app()).put(url(`/matters/${matter.uid}`)), owner).send({ uid: matter.uid, version, ...fields });
            const renamed = await put(matter.version, { name: "Renamed", custodianMailboxUids: matter.custodianMailboxUids });
            expect(renamed.status).toBe(200);
            // A mailbox that isn't already held is still judged.
            const outsider = await createMailbox(other.uid);
            expect((await put(renamed.body.version, { custodianMailboxUids: [...matter.custodianMailboxUids, outsider.uid] })).status).toBe(400);
        });
    });


    describe("MTA delivery (B9, A15, B10)", () => {
        const deliver = (from: string, to: string[], raw: string) =>
            request(ctx.app())
                .post(url("/internal/mta/deliver"))
                .set("Authorization", `Bearer ${ctx.ingestSecret}`)
                .set("X-Envelope-From", from)
                .set("X-Envelope-To", to.join(","))
                .set("Content-Type", "message/rfc822")
                .send(Buffer.from(raw));
        const crlf = String.fromCharCode(13, 10);
        const message = (from: string, to: string, extra: string[] = []) => [`From: ${from}`, `To: ${to}`, ...extra, "", "Hello", ""].join(crlf);

        it("a retried delivery of the same transaction queues each recipient once", async () => {
            const a = await createMailbox(owner.uid);
            const b = await createMailbox(other.uid);
            const raw = message("sender@example.net", a.primarySmtpAddress, ["Subject: once"]);
            const to = [a.primarySmtpAddress, b.primarySmtpAddress];
            const first = await deliver("sender@example.net", to, raw);
            expect(first.status).toBe(202);
            const second = await deliver("sender@example.net", to, raw);
            expect(second.status).toBe(202);
            expect(second.body.results.map((r: any) => r.queued)).toEqual([true, true]);
            const entries = await ctx.findAll("IngestQueueEntry");
            expect(entries).toHaveLength(2);
            expect(entries.map((e) => e.mailboxUid).sort()).toEqual([a.uid, b.uid].sort());
            // A different message to the same recipient is its own entry.
            expect((await deliver("sender@example.net", [a.primarySmtpAddress], message("sender@example.net", a.primarySmtpAddress, ["Subject: another"]))).status).toBe(202);
            expect(await ctx.count("IngestQueueEntry")).toBe(3);
        });

        it("a relay to an external list member that fails is not reported as delivered", async () => {
            const member = await createMailbox(other.uid);
            await ctx.save("DistributionList", {
                name: "Team",
                primarySmtpAddress: "team@example.com",
                aliasAddresses: [],
                memberAddresses: [member.primarySmtpAddress, "external@outside.example"],
            });
            const send = vi.spyOn(ctx.transport(), "send").mockRejectedValue(new Error("relay down"));
            try {
                const failed = await deliver("sender@example.net", ["team@example.com"], message("sender@example.net", "team@example.com"));
                expect(failed.status).toBe(503);
            } finally {
                send.mockRestore();
            }
            // The internal member's entry is queued, and a retry doesn't queue it again.
            expect(await ctx.count("IngestQueueEntry")).toBe(1);
            expect((await deliver("sender@example.net", ["team@example.com"], message("sender@example.net", "team@example.com"))).status).toBe(202);
            expect(await ctx.count("IngestQueueEntry")).toBe(1);
        });

        it("a transport-rule rejection is only mailed back to a sender whose DKIM signature verified", async () => {
            const mine = await createMailbox(owner.uid);
            await ctx.save("TransportRule", {
                name: "Block",
                enabled: true,
                sequence: 0,
                stopProcessingRules: false,
                conditions: { subjectContains: ["blocked"] },
                actions: [{ type: "reject" }],
            });
            const forged = message("victim@example.net", mine.primarySmtpAddress, ["Subject: blocked topic"]);
            const unverified = await deliver("victim@example.net", [mine.primarySmtpAddress], forged);
            expect(unverified.status).toBe(202);
            expect(unverified.body.results).toEqual([{ rcpt: mine.primarySmtpAddress, queued: false }]);
            expect(ctx.transport().sent).toHaveLength(0);

            const signed = message("victim@example.net", mine.primarySmtpAddress, [
                "Subject: blocked topic",
                "Authentication-Results: mx.example.com; dkim=pass header.d=example.net",
            ]);
            expect((await deliver("victim@example.net", [mine.primarySmtpAddress], signed)).status).toBe(202);
            expect(ctx.transport().sent).toHaveLength(1);
            expect(ctx.transport().sent[0].envelopeTo).toEqual(["victim@example.net"]);
        });
    });


    describe("search (A24)", () => {
        it("doesn't return a message that was deleted, though it is still indexed", async () => {
            const mine = await createMailbox(owner.uid);
            const inbox = await createFolder(mine.uid);
            const kept = await createMessage(mine, inbox.uid, { subject: "findme kept" });
            const gone = await createMessage(mine, inbox.uid, { subject: "findme gone" });
            for (const message of [kept, gone]) {
                await ctx.searchProvider().index({ entityType: "message", entityUid: message.uid, mailboxUid: mine.uid, subject: message.subject });
            }
            const search = async () =>
                (await auth(request(ctx.app()).get(url(`/search?q=findme&mailboxUid=${mine.uid}`)), owner)).body.results.map((r: any) => r.entityUid);
            expect((await search()).sort()).toEqual([kept.uid, gone.uid].sort());

            expect((await auth(request(ctx.app()).delete(url(`/messages/${gone.uid}`)), owner)).status).toBe(204);
            expect(await search()).toEqual([kept.uid]);
        });
    });

    describe("keys of a shared mailbox (A13)", () => {
        it("a delegate can't wipe the published keys of a shared mailbox with no owner either", async () => {
            const shared = await createMailbox(undefined, { keys: [{ fingerprint: "ab", certificate: "x" }], keyDiscoveryHash: "hash" });
            await ctx.saveAcl({ uid: shared.uid, parentUid: "Mailbox", records: [{ userOrRoleId: other.uid, actions: ["read", "list", "update"] }] });
            const res = await auth(request(ctx.app()).put(url(`/mailboxes/${shared.uid}`)), other).send({
                uid: shared.uid,
                version: shared.version,
                keys: [],
                keyDiscoveryHash: "",
                displayName: "Shared edit",
            });
            expect(res.status).toBe(200);
            const after = await ctx.findOne("Mailbox", shared.uid);
            expect(after.keyDiscoveryHash).toBe("hash");
            expect(after.keys?.length).toBe(1);
        });
    });

    describe("bulk create cap (B13)", () => {
        it("refuses a bulk create of more than 100 objects", async () => {
            const mine = await createMailbox(owner.uid);
            const drafts = await createFolder(mine.uid, FolderType.DRAFTS);
            const body = Array.from({ length: 101 }, () => draftBody({ folderUid: drafts.uid }));
            expect((await auth(request(ctx.app()).post(url("/messages")), owner).send(body)).status).toBe(400);
            expect(await ctx.count("Message")).toBe(0);
        });
    });

    describe("soft-deleted folders (B2)", () => {
        it("a record can't be planted in another mailbox through a soft-deleted folder", async () => {
            const victim = await createMailbox(other.uid);
            const mine = await createMailbox(owner.uid);
            const folder = await createFolder(mine.uid, FolderType.USER, { deleted: true });
            const res = await auth(request(ctx.app()).post(url("/messages")), owner).send(
                draftBody({ folderUid: folder.uid, mailboxUid: victim.uid, from: { address: "x@example.net", type: "to" } }),
            );
            expect(res.status).toBeGreaterThanOrEqual(400);
            expect(res.status).toBeLessThan(500);
            expect((await ctx.findAll("Message")).filter((m) => m.mailboxUid === victim.uid)).toHaveLength(0);
        });

        it("a folder-scoped record in a soft-deleted folder still gets that folder's mailbox, and a folder that doesn't exist is refused", async () => {
            const mine = await createMailbox(owner.uid);
            const inbox = await createFolder(mine.uid);
            const ok = await auth(request(ctx.app()).post(url("/messages")), owner).send(
                draftBody({ folderUid: inbox.uid, mailboxUid: "other" }),
            );
            // A non-draft folder strips nothing relevant here; the mailbox is the folder's own either way.
            if (ok.status === 200) {
                expect(ok.body.mailboxUid).toBe(mine.uid);
            }
            const missing = uuid.v4();
            await ctx.saveAcl({ uid: missing, parentUid: mine.uid, records: [{ userOrRoleId: owner.uid, actions: ["*"] }] });
            const res = await auth(request(ctx.app()).post(url("/messages")), owner).send(
                draftBody({ folderUid: missing, mailboxUid: "victim" }),
            );
            expect(res.status).toBeGreaterThanOrEqual(400);
            expect(res.status).toBeLessThan(500);
        });
    });


    describe("round 3: folder type (R1-01)", () => {
        it("a client can't create a mail folder, and a folder's type never changes", async () => {
            const mine = await createMailbox(owner.uid);
            for (const type of [FolderType.DRAFTS, FolderType.SENT_ITEMS, FolderType.INBOX, FolderType.OUTBOX]) {
                const res = await auth(request(ctx.app()).post(url("/folders")), owner).send({ mailboxUid: mine.uid, name: "Fake", type });
                expect(res.status).toBe(403);
            }
            const admins = await auth(request(ctx.app()).post(url("/folders")), admin).send({ mailboxUid: mine.uid, name: "Fake", type: FolderType.DRAFTS });
            expect(admins.status).toBeGreaterThanOrEqual(400);
            expect(await ctx.count("Folder")).toBe(0);
            const cal = await auth(request(ctx.app()).post(url("/folders")), owner).send({ mailboxUid: mine.uid, name: "Work", type: FolderType.CALENDAR });
            expect(cal.status).toBe(200);
            const own = await auth(request(ctx.app()).post(url("/folders")), owner).send({ mailboxUid: mine.uid, name: "Mine", type: FolderType.USER });
            expect(own.status).toBe(200);

            const retyped = await auth(request(ctx.app()).put(url(`/folders/${own.body.uid}`)), owner).send({
                uid: own.body.uid,
                version: own.body.version,
                name: "Renamed",
                type: FolderType.DRAFTS,
            });
            expect(retyped.status).toBe(200);
            const stored = await ctx.findOne("Folder", own.body.uid);
            expect(stored.name).toBe("Renamed");
            expect(stored.type).toBe(FolderType.USER);
            const property = await auth(request(ctx.app()).put(url(`/folders/${own.body.uid}/type`)), owner).send(JSON.stringify(FolderType.DRAFTS) as any).set("Content-Type", "application/json");
            expect(property.status).toBe(403);
            expect((await ctx.findOne("Folder", own.body.uid)).type).toBe(FolderType.USER);
        });
    });


    describe("round 3: message route (R1-02, R1-03, R1-05, R1-10, X2-06)", () => {
        it("refuses to recall a message the server did not send, however it came to be in Sent Items (R1-02)", async () => {
            const mine = await createMailbox(owner.uid);
            const sent = await createFolder(mine.uid, FolderType.SENT_ITEMS);
            const message = await createMessage(mine, sent.uid);
            const refused = await auth(request(ctx.app()).post(url(`/messages/${message.uid}/recall`)), owner);
            expect(refused.status).toBe(403);
            expect(ctx.transport().sent).toHaveLength(0);
            expect((await ctx.findOne("Message", message.uid)).recallRequestedAt ?? undefined).toBeUndefined();
        });

        it("no caller can set sentByServerAt, so a message placed in Sent Items by hand stays unrecallable (R1-02)", async () => {
            const mine = await createMailbox(admin.uid);
            const sent = await createFolder(mine.uid, FolderType.SENT_ITEMS);
            const created = await auth(request(ctx.app()).post(url("/messages")), admin).send(
                draftBody({ folderUid: sent.uid, sentByServerAt: new Date().toISOString() }),
            );
            expect(created.status).toBe(200);
            expect((await ctx.findOne("Message", created.body.uid)).sentByServerAt ?? undefined).toBeUndefined();

            const message = await createMessage(mine, sent.uid);
            const updated = await auth(request(ctx.app()).put(url(`/messages/${message.uid}`)), admin).send({
                uid: message.uid,
                version: message.version,
                subject: "Edited",
                sentByServerAt: new Date().toISOString(),
            });
            expect(updated.status).toBe(200);
            expect((await ctx.findOne("Message", message.uid)).sentByServerAt ?? undefined).toBeUndefined();
            expect((await auth(request(ctx.app()).post(url(`/messages/${message.uid}/recall`)), admin)).status).toBe(403);
            expect(ctx.transport().sent).toHaveLength(0);
        });

        it("a message the server relayed and filed carries sentByServerAt, and can then be recalled (R1-02)", async () => {
            const mine = await createMailbox(owner.uid);
            const drafts = await createFolder(mine.uid, FolderType.DRAFTS);
            const bodyBlobKey = `bodies/${uuid.v4()}`;
            await ctx.blobStore().put(bodyBlobKey, Buffer.from(`From: ${mine.primarySmtpAddress}\r\nTo: recipient@example.net\r\nSubject: hi\r\n\r\nhello`));
            const draft = await createMessage(mine, drafts.uid, { bodyBlobKey });
            expect((await auth(request(ctx.app()).post(url(`/messages/${draft.uid}/send`)), owner)).status).toBe(200);
            expect((await ctx.findOne("Message", draft.uid)).sentByServerAt).toBeTruthy();
            expect((await auth(request(ctx.app()).post(url(`/messages/${draft.uid}/recall`)), owner)).status).toBe(200);
        });

        it("a recall the transport turns away isn't recorded, and can be tried again (R1-05)", async () => {
            const mine = await createMailbox(owner.uid);
            const sent = await createFolder(mine.uid, FolderType.SENT_ITEMS);
            const message = await createMessage(mine, sent.uid, { recipients: [{ address: "reject@example.com", type: RecipientType.TO }], sentByServerAt: new Date() });
            const failed = await auth(request(ctx.app()).post(url(`/messages/${message.uid}/recall`)), owner);
            expect(failed.status).toBe(502);
            expect((await ctx.findOne("Message", message.uid)).recallRequestedAt ?? undefined).toBeUndefined();
            await ctx.update("Message", message.uid, { recipients: [{ address: "ok@example.net", type: RecipientType.TO }] });
            expect((await auth(request(ctx.app()).post(url(`/messages/${message.uid}/recall`)), owner)).status).toBe(200);
            expect((await ctx.findOne("Message", message.uid)).recallRequestedAt).toBeTruthy();
        });

        it("two concurrent recalls mail the recipients once (X2-06)", async () => {
            const mine = await createMailbox(owner.uid);
            const sent = await createFolder(mine.uid, FolderType.SENT_ITEMS);
            const message = await createMessage(mine, sent.uid, { sentByServerAt: new Date() });
            const results = await Promise.all(
                [1, 2, 3].map(() => auth(request(ctx.app()).post(url(`/messages/${message.uid}/recall`)), owner)),
            );
            expect(results.filter((r) => r.status === 200)).toHaveLength(1);
            expect(ctx.transport().sent).toHaveLength(1);
        });

        it("a read receipt is only sent for received mail, never for a draft's own dispositionNotificationTo (R1-02)", async () => {
            const mine = await createMailbox(owner.uid, { autoSendReceiptsExternal: true, autoSendReceiptsInternal: true, autoSendReceiptsFederated: true });
            const drafts = await createFolder(mine.uid, FolderType.DRAFTS);
            const draft = await createMessage(mine, drafts.uid, { dispositionNotificationTo: "victim@example.net" });
            const read = await auth(request(ctx.app()).put(url(`/messages/${draft.uid}`)), owner).send({
                uid: draft.uid,
                version: draft.version,
                flags: { read: true, flagged: false, answered: false, forwarded: false },
            });
            expect(read.status).toBe(200);
            expect(ctx.transport().sent).toHaveLength(0);
            const stored = await ctx.findOne("Message", draft.uid);
            expect(stored.readReceiptSentAt ?? undefined).toBeUndefined();
            expect(stored.readReceiptPending ?? false).toBe(false);
        });

        it("a message a delegate creates outside Drafts can't be from somebody else (R1-03)", async () => {
            const mine = await createMailbox(owner.uid);
            await grant(mine, other.uid);
            const inbox = await createFolder(mine.uid);
            const res = await auth(request(ctx.app()).post(url("/messages")), other).send(
                draftBody({ folderUid: inbox.uid, from: { address: "ceo@example.net", displayName: "The CEO", type: "from" } }),
            );
            expect(res.status).toBe(200);
            expect((await ctx.findOne("Message", res.body.uid)).from.address).toBe(mine.primarySmtpAddress);
        });

        it("a draft's forged sender and dates are scrubbed on the way into Deleted Items (R1-03)", async () => {
            const mine = await createMailbox(owner.uid);
            const drafts = await createFolder(mine.uid, FolderType.DRAFTS);
            const deleted = await createFolder(mine.uid, FolderType.DELETED_ITEMS);
            const inbox = await createFolder(mine.uid);
            const forged = await auth(request(ctx.app()).post(url("/messages")), owner).send(
                draftBody({
                    folderUid: drafts.uid,
                    from: { address: "ceo@example.net", type: "from" },
                    sentDate: "2001-01-01T00:00:00.000Z",
                    receivedDate: "2001-01-01T00:00:00.000Z",
                }),
            );
            expect(forged.status).toBe(200);
            const trashed = await auth(request(ctx.app()).put(url(`/messages/${forged.body.uid}`)), owner).send({
                uid: forged.body.uid,
                version: forged.body.version,
                folderUid: deleted.uid,
            });
            expect(trashed.status).toBe(200);
            const stored = await ctx.findOne("Message", forged.body.uid);
            expect(stored.from.address).toBe(mine.primarySmtpAddress);
            expect(new Date(stored.receivedDate).getFullYear()).toBeGreaterThan(2020);
            expect(new Date(stored.sentDate).getFullYear()).toBeGreaterThan(2020);
            const restored = await auth(request(ctx.app()).put(url(`/messages/${forged.body.uid}`)), owner).send({
                uid: forged.body.uid,
                version: trashed.body.version,
                folderUid: inbox.uid,
            });
            expect(restored.status).toBe(200);
            expect((await ctx.findOne("Message", forged.body.uid)).from.address).toBe(mine.primarySmtpAddress);
        });

        it("a trusted caller can't re-date a message out of an open hold's range (R1-10)", async () => {
            const mine = await createMailbox(admin.uid);
            const inbox = await createFolder(mine.uid);
            const message = await createMessage(mine, inbox.uid, { sentDate: new Date("2025-01-01"), receivedDate: new Date("2025-01-01") });
            await ctx.save("Matter", {
                name: "Hold",
                escrowScopeId: uuid.v4(),
                custodianMailboxUids: [mine.uid],
                dateRangeStart: new Date("2024-01-01"),
                dateRangeEnd: new Date("2030-01-01"),
            });
            const res = await auth(request(ctx.app()).put(url(`/messages/${message.uid}`)), admin).send({
                uid: message.uid,
                version: message.version,
                sentDate: "2010-01-01T00:00:00.000Z",
            });
            expect(res.status).toBe(409);
            const same = await auth(request(ctx.app()).put(url(`/messages/${message.uid}`)), admin).send({
                uid: message.uid,
                version: message.version,
                sentDate: new Date("2025-01-01").toISOString(),
                subject: "Subject",
            });
            expect(same.status).toBe(200);
        });
    });


    describe("round 3: attachments (R1-04)", () => {
        const attach = async (mine: any, folderUid: string, messageUid: string, fields: Record<string, any> = {}) => {
            const blobKey = `attachments/${uuid.v4()}`;
            await ctx.blobStore().put(blobKey, Buffer.from("abc"));
            return await ctx.save("Attachment", {
                mailboxUid: mine.uid,
                folderUid,
                messageUid,
                filename: "a.txt",
                mimeType: "text/plain",
                sizeBytes: 3,
                blobKey,
                ...fields,
            });
        };

        it("a permanent delete removes the blob and gives the mailbox its bytes back, a soft delete keeps both", async () => {
            const mine = await createMailbox(owner.uid, { usedBytes: 10 });
            const inbox = await createFolder(mine.uid);
            const message = await createMessage(mine, inbox.uid);
            const soft = await attach(mine, inbox.uid, message.uid);
            const hard = await attach(mine, inbox.uid, message.uid);
            expect((await auth(request(ctx.app()).delete(url(`/attachments/${soft.uid}`)), owner)).status).toBe(204);
            expect(await ctx.blobStore().exists(soft.blobKey)).toBe(true);
            expect((await ctx.findOne("Mailbox", mine.uid)).usedBytes).toBe(10);
            expect((await auth(request(ctx.app()).delete(url(`/attachments/${hard.uid}?purge=true`)), owner)).status).toBe(204);
            expect(await ctx.blobStore().exists(hard.blobKey)).toBe(false);
            expect((await ctx.findOne("Mailbox", mine.uid)).usedBytes).toBe(7);
        });

        it("a truncate removes the blobs and refunds, but keeps a blob another attachment still names", async () => {
            const mine = await createMailbox(owner.uid, { usedBytes: 10 });
            const inbox = await createFolder(mine.uid);
            const message = await createMessage(mine, inbox.uid);
            const other1 = await createMessage(mine, (await createFolder(mine.uid, FolderType.ARCHIVE)).uid);
            const a = await attach(mine, inbox.uid, message.uid);
            const shared = await attach(mine, inbox.uid, message.uid);
            await attach(mine, (await ctx.findOne("Message", other1.uid)).folderUid, other1.uid, { blobKey: shared.blobKey });
            expect((await auth(request(ctx.app()).delete(url(`/attachments?folderUid=${inbox.uid}`)), owner)).status).toBe(204);
            expect(await ctx.blobStore().exists(a.blobKey)).toBe(false);
            expect(await ctx.blobStore().exists(shared.blobKey)).toBe(true);
            expect((await ctx.findOne("Mailbox", mine.uid)).usedBytes).toBe(4);
        });

        it("a held message's attachments can't be purged, truncated or described differently", async () => {
            const mine = await createMailbox(owner.uid);
            const inbox = await createFolder(mine.uid);
            const message = await createMessage(mine, inbox.uid, { sentDate: new Date("2025-01-01") });
            const att = await attach(mine, inbox.uid, message.uid);
            await ctx.save("Matter", {
                name: "Hold",
                escrowScopeId: uuid.v4(),
                custodianMailboxUids: [mine.uid],
                dateRangeStart: new Date("2024-01-01"),
                dateRangeEnd: new Date("2030-01-01"),
            });
            expect((await auth(request(ctx.app()).delete(url(`/attachments/${att.uid}?purge=true`)), owner)).status).toBe(409);
            expect((await auth(request(ctx.app()).delete(url(`/attachments?folderUid=${inbox.uid}`)), owner)).status).toBe(409);
            expect(await ctx.blobStore().exists(att.blobKey)).toBe(true);
            expect(await ctx.count("Attachment")).toBe(1);
            expect((await auth(request(ctx.app()).put(url(`/attachments/${att.uid}`)), owner).send({ uid: att.uid, version: att.version, filename: "renamed.txt" })).status).toBe(409);
            // A soft delete stays recoverable, and an unchanged round trip still saves.
            expect((await auth(request(ctx.app()).put(url(`/attachments/${att.uid}`)), owner).send({ uid: att.uid, version: att.version, filename: "a.txt" })).status).toBe(200);
            expect((await auth(request(ctx.app()).delete(url(`/attachments/${att.uid}`)), owner)).status).toBe(204);
        });
    });


    describe("round 3: external list relays (R1-06)", () => {
        const deliver = (to: string[], raw: string) =>
            request(ctx.app())
                .post(url("/internal/mta/deliver"))
                .set("Authorization", `Bearer ${ctx.ingestSecret}`)
                .set("X-Envelope-From", "sender@example.net")
                .set("X-Envelope-To", to.join(","))
                .set("Content-Type", "message/rfc822")
                .send(Buffer.from(raw));
        const raw = ["From: sender@example.net", "To: team@example.com", "", "Hello", ""].join(String.fromCharCode(13, 10));

        it("a transaction that already relayed to some external members isn't retried, and a permanent refusal isn't either", async () => {
            await ctx.save("DistributionList", {
                name: "Team",
                primarySmtpAddress: "team@example.com",
                aliasAddresses: [],
                memberAddresses: ["good@outside.example", "temp@outside.example", "gone@outside.example"],
            });
            const calls: string[] = [];
            const send = vi.spyOn(ctx.transport(), "send").mockImplementation(async (message: any) => {
                const to: string = message.envelopeTo[0];
                calls.push(to);
                if (to.startsWith("good")) {
                    return { accepted: [to], rejected: [] };
                }
                if (to.startsWith("gone")) {
                    return { accepted: [], rejected: [to], failures: [{ address: to, code: 550, temporary: false }] };
                }
                throw new Error("relay down");
            });
            try {
                // One went out, so a retry would send it again: the transaction is answered as delivered.
                expect((await deliver(["team@example.com"], raw)).status).toBe(202);
                expect(calls.filter((to) => to.startsWith("good"))).toHaveLength(1);
            } finally {
                send.mockRestore();
            }
        });

        it("a transaction whose every relay failed temporarily is retried, one that failed permanently is not", async () => {
            await ctx.save("DistributionList", {
                name: "Team",
                primarySmtpAddress: "team@example.com",
                aliasAddresses: [],
                memberAddresses: ["gone@outside.example"],
            });
            const send = vi.spyOn(ctx.transport(), "send").mockImplementation(async (message: any) => ({
                accepted: [],
                rejected: message.envelopeTo,
                failures: [{ address: message.envelopeTo[0], code: 550, temporary: false }],
            }));
            try {
                expect((await deliver(["team@example.com"], raw)).status).toBe(202);
            } finally {
                send.mockRestore();
            }
            const temp = vi.spyOn(ctx.transport(), "send").mockImplementation(async (message: any) => ({
                accepted: [],
                rejected: message.envelopeTo,
                failures: [{ address: message.envelopeTo[0], code: 451, temporary: true }],
            }));
            try {
                expect((await deliver(["team@example.com"], raw)).status).toBe(503);
            } finally {
                temp.mockRestore();
            }
        });
    });


    describe("round 3: accessible mailboxes of a user with roles (R1-07)", () => {
        it("lists both the mailbox a user owns and one shared with their role", async () => {
            const roleUser: any = { uid: uuid.v4(), roles: ["staff"], elevated: Date.now() };
            const mine = await createMailbox(roleUser.uid);
            const shared = await createMailbox(other.uid);
            await ctx.saveAcl({ uid: shared.uid, parentUid: "Mailbox", records: [{ userOrRoleId: other.uid, actions: ["*"] }, { userOrRoleId: "staff", actions: ["read", "list"] }] });
            const res = await auth(request(ctx.app()).get(url("/mailboxes")), roleUser);
            expect(res.status).toBe(200);
            expect(res.body.map((m: any) => m.uid).sort()).toEqual([mine.uid, shared.uid].sort());
        });
    });


    describe("round 3: mailbox key properties (R1-08, X2-10)", () => {
        it("a delegate's PUT of a key property neither wipes nor nulls the keys", async () => {
            const shared = await createMailbox(owner.uid, { keys: [{ fingerprint: "ab", certificate: "x" }], keyDiscoveryHash: "hash" });
            await grant(shared, other.uid, ["read", "list", "update"]);
            const res = await auth(request(ctx.app()).put(url(`/mailboxes/${shared.uid}/keys`)), other).set("Content-Type", "application/json").send("[]");
            expect(res.status).toBe(403);
            await auth(request(ctx.app()).put(url(`/mailboxes/${shared.uid}/keyDiscoveryHash`)), other).set("Content-Type", "application/json").send('""');
            const after = await ctx.findOne("Mailbox", shared.uid);
            expect(after.keyDiscoveryHash).toBe("hash");
            expect(after.keys?.length).toBe(1);
        });
    });


    describe("round 3: owner change spelling (X2-10)", () => {
        it("an administrator can't name themselves owner by writing their uid another way", async () => {
            const mine = await createMailbox(owner.uid);
            for (const spelled of [` ${admin.uid.toUpperCase()} `, admin.uid.toUpperCase()]) {
                const res = await auth(request(ctx.app()).put(url(`/mailboxes/${mine.uid}`)), admin).send({ uid: mine.uid, version: mine.version, ownerUserUid: spelled });
                // Either the spelling is refused as no uid at all (400) or it is read as the administrator's own (403): never accepted.
                expect([400, 403]).toContain(res.status);
            }
            const upper = await auth(request(ctx.app()).put(url(`/mailboxes/${mine.uid}`)), admin).send({ uid: mine.uid, version: mine.version, ownerUserUid: admin.uid.toUpperCase() });
            expect(upper.status).toBe(403);
            expect((await ctx.findOne("Mailbox", mine.uid)).ownerUserUid).toBe(owner.uid);
        });
    });


    describe("round 3: one import at a time (R1-09, X2-02)", () => {
        it("of several uploads started together into one mailbox, one is queued and the others refused", async () => {
            // Their own user: the lookup of a user's mailbox is cached, and the shared one has been asked about before.
            const importer: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
            const mine = await createMailbox(importer.uid);
            const folder = await createFolder(mine.uid, FolderType.USER);
            const post = () =>
                auth(request(ctx.app()).post(url(`/mailbox-import-requests?format=mbox&targetFolderUid=${folder.uid}`)), importer)
                    .set("Content-Type", "application/mbox")
                    .send(Buffer.from("From x\r\n\r\nHello\r\n"));
            const results = await Promise.all([post(), post(), post(), post()]);
            expect(results.filter((r) => r.status === 200 || r.status === 201)).toHaveLength(1);
            expect(results.filter((r) => r.status === 409)).toHaveLength(3);
            expect(await ctx.count("MailboxImportRequest")).toBe(1);
        });
    });


    describe("round 3: rule cap of a bulk create (R1-11, X2-08)", () => {
        it("a bulk create can't take a mailbox past its cap, and creates none of the rules", async () => {
            const mine = await createMailbox(owner.uid);
            const rule = (name: string) => ({
                mailboxUid: mine.uid,
                name,
                enabled: true,
                sequence: 0,
                stopProcessingRules: false,
                conditions: {},
                actions: [{ type: "mark_as_read" }],
            });
            for (let i = 0; i < 198; i++) {
                await ctx.save("MailFilterRule", rule(`filler ${i}`));
            }
            const res = await auth(request(ctx.app()).post(url("/mail-filter-rules")), owner).send([rule("a"), rule("b"), rule("c"), rule("d")]);
            expect(res.status).toBe(400);
            expect(await ctx.count("MailFilterRule")).toBe(198);
            expect((await auth(request(ctx.app()).post(url("/mail-filter-rules")), owner).send([rule("a"), rule("b")])).status).toBe(200);
            expect(await ctx.count("MailFilterRule")).toBe(200);
        });
    });


    describe("round 3: label delete (R1-12)", () => {
        it("also strips the label from a message the user deleted, which can still be restored", async () => {
            const mine = await createMailbox(owner.uid);
            const inbox = await createFolder(mine.uid);
            const label = await ctx.save("Label", { mailboxUid: mine.uid, name: "work" });
            const gone = await createMessage(mine, inbox.uid, { labelUids: [label.uid] });
            expect((await auth(request(ctx.app()).delete(url(`/messages/${gone.uid}`)), owner)).status).toBe(204);
            expect((await auth(request(ctx.app()).delete(url(`/labels/${label.uid}`)), owner)).status).toBe(204);
            expect((await ctx.findOne("Message", gone.uid)).labelUids ?? []).toEqual([]);
        });
    });


    describe("round 3: message whose folder is gone (R1-13)", () => {
        it("can still be edited in place with a full round-tripped object", async () => {
            const mine = await createMailbox(owner.uid);
            const missing = uuid.v4();
            await ctx.saveAcl({ uid: missing, parentUid: mine.uid, records: [{ userOrRoleId: owner.uid, actions: ["*"] }] });
            const message = await createMessage(mine, missing);
            const res = await auth(request(ctx.app()).put(url(`/messages/${message.uid}`)), owner).send({
                uid: message.uid,
                version: message.version,
                mailboxUid: mine.uid,
                flags: { read: true, flagged: true, answered: false, forwarded: false },
            });
            expect(res.status).toBe(200);
            expect((await ctx.findOne("Message", message.uid)).flags.flagged).toBe(true);
            const hijack = await auth(request(ctx.app()).put(url(`/messages/${message.uid}`)), owner).send({
                uid: message.uid,
                version: res.body.version,
                mailboxUid: "someone-else",
                subject: "Edited",
            });
            expect(hijack.status).toBe(200);
            expect((await ctx.findOne("Message", message.uid)).mailboxUid).toBe(mine.uid);
        });
    });


    describe("round 3: transport rules (R2-03, R2-04, R2-05)", () => {
        const rule = (fields: Record<string, any> = {}) => ({
            name: "Rule",
            enabled: true,
            sequence: 0,
            stopProcessingRules: false,
            conditions: { subjectContains: ["x"] },
            actions: [{ type: "add_header", headerName: "X-Tag", headerValue: "v" }],
            ...fields,
        });
        const post = (user: any, body: any) => auth(request(ctx.app()).post(url("/transport-rules")), user).send(body);

        it("writing a rule takes an elevated administrator", async () => {
            expect((await post(plainAdmin, rule())).status).toBe(403);
            expect(await ctx.count("TransportRule")).toBe(0);
            const ok = await post(admin, rule());
            expect(ok.status).toBe(200);
            expect((await auth(request(ctx.app()).put(url(`/transport-rules/${ok.body.uid}`)), plainAdmin).send({ uid: ok.body.uid, version: ok.body.version, enabled: false })).status).toBe(403);
            expect((await auth(request(ctx.app()).delete(url(`/transport-rules/${ok.body.uid}`)), plainAdmin)).status).toBe(403);
            expect(await ctx.count("TransportRule")).toBe(1);
            // Reading needs the trusted role only.
            expect((await auth(request(ctx.app()).get(url("/transport-rules")), plainAdmin)).status).toBe(200);
        });

        it("the bulk, property and truncate endpoints are guarded and audited like the single ones", async () => {
            const created = await post(admin, rule());
            expect(created.status).toBe(200);
            await ctx.save("TransportRule", { ...rule({ name: "Other" }) });
            expect((await auth(request(ctx.app()).delete(url("/transport-rules")), admin)).status).toBe(403);
            expect(await ctx.count("TransportRule")).toBe(2);
            expect((await auth(request(ctx.app()).put(url("/transport-rules")), plainAdmin).send([{ uid: created.body.uid, version: created.body.version, enabled: false }])).status).toBe(403);
            const bulk = await auth(request(ctx.app()).put(url("/transport-rules")), admin).send([{ uid: created.body.uid, version: created.body.version, enabled: false }]);
            expect(bulk.status).toBe(200);
            const property = await auth(request(ctx.app()).put(url(`/transport-rules/${created.body.uid}/actions`)), admin).send([{ type: "add_recipient", recipientAddress: "copy@example.net" }]);
            expect(property.status).toBe(200);
            const bad = await auth(request(ctx.app()).put(url(`/transport-rules/${created.body.uid}/actions`)), admin).send([{ type: "add_recipient", recipientAddress: "not an address" }]);
            expect(bad.status).toBe(400);
            const updates = (await ctx.findAll("AuditLogEntry")).filter((e) => e.action === "transport_rule.update");
            expect(updates).toHaveLength(2);
            expect(JSON.stringify(updates)).toContain("copy@example.net");
        });

        it("a rule inbound mail can't be evaluated against is refused when written", async () => {
            for (const body of [
                rule({ conditions: null }),
                rule({ conditions: { fromContains: "x" } }),
                rule({ conditions: { unknown: ["x"] } }),
                rule({ actions: null }),
                rule({ actions: [{ type: "nonsense" }] }),
                rule({ actions: [{ type: "add_header", headerName: "Authentication-Results", headerValue: "mx.example.com; dkim=pass header.d=victim.example" }] }),
                rule({ actions: [{ type: "add_header", headerName: "X-RapidMX-Key", headerValue: "v" }] }),
                rule({ actions: [{ type: "add_header", headerName: "X-Tag", headerValue: "a\r\nBcc: x@example.net" }] }),
                rule({ actions: [{ type: "add_recipient" }] }),
                rule({ sequence: "first" }),
            ]) {
                expect((await post(admin, body)).status).toBe(400);
            }
            expect(await ctx.count("TransportRule")).toBe(0);
        });

        it("a mail delivery goes on when a stored rule can't be read", async () => {
            const mine = await createMailbox(owner.uid);
            await ctx.save("TransportRule", { ...rule(), conditions: { fromContains: "x" } });
            const crlf = String.fromCharCode(13, 10);
            const res = await request(ctx.app())
                .post(url("/internal/mta/deliver"))
                .set("Authorization", `Bearer ${ctx.ingestSecret}`)
                .set("X-Envelope-From", "sender@example.net")
                .set("X-Envelope-To", mine.primarySmtpAddress)
                .set("Content-Type", "message/rfc822")
                .send(Buffer.from(["From: sender@example.net", `To: ${mine.primarySmtpAddress}`, "Subject: hello", "", "Hi", ""].join(crlf)));
            expect(res.status).toBe(202);
            expect(await ctx.count("IngestQueueEntry")).toBe(1);
        });
    });


    describe("round 3: distribution list endpoints (R2-03)", () => {
        it("the bulk, property and truncate endpoints can't skip the address checks or the audit entry", async () => {
            const taken = await createMailbox(other.uid, { primarySmtpAddress: "taken@example.com" });
            const list = await ctx.save("DistributionList", { name: "Team", primarySmtpAddress: "team@example.com", aliasAddresses: [], memberAddresses: [] });
            const prop = await auth(request(ctx.app()).put(url(`/distribution-lists/${list.uid}/primarySmtpAddress`)), admin)
                .set("Content-Type", "application/json")
                .send(JSON.stringify(taken.primarySmtpAddress));
            expect(prop.status).toBe(409);
            const bulk = await auth(request(ctx.app()).put(url("/distribution-lists")), admin).send([{ uid: list.uid, version: list.version, primarySmtpAddress: taken.primarySmtpAddress }]);
            expect(bulk.status).toBe(409);
            expect((await ctx.findOne("DistributionList", list.uid)).primarySmtpAddress).toBe("team@example.com");
            expect((await auth(request(ctx.app()).delete(url("/distribution-lists")), admin)).status).toBe(403);
            expect(await ctx.count("DistributionList")).toBe(1);
            const ok = await auth(request(ctx.app()).put(url(`/distribution-lists/${list.uid}/name`)), admin).set("Content-Type", "application/json").send('"Renamed"');
            expect(ok.status).toBe(200);
            expect((await ctx.findAll("AuditLogEntry")).filter((e) => e.action === "distribution_list.update")).toHaveLength(1);
        });
    });


    describe("round 3: share link bounds (R2-09)", () => {
        it("repeated actions are folded, a link can't outlive the bound or be made permanent, and a calendar has a bounded number of links", async () => {
            const mine = await createMailbox(owner.uid);
            const calendar = await createFolder(mine.uid, FolderType.CALENDAR);
            await ctx.saveAcl({ uid: calendar.uid, parentUid: mine.uid, records: [] });
            const post = (body: any) => auth(request(ctx.app()).post(url("/calendar-share-links")), owner).send({ folderUid: calendar.uid, ...body });
            const crowd = await post({ permittedActions: Array.from({ length: 100 }, () => "read").concat(["list", "count", "exists", "freebusy", "read"]) });
            expect(crowd.status).toBe(200);
            expect((await ctx.findOne("CalendarShareLink", crowd.body.uid)).permittedActions).toEqual(["read", "list", "count", "exists", "freebusy"]);
            expect((await post({ permittedActions: ["read", "list", "count", "exists", "freebusy", "update"] })).status).toBe(400);
            const folded = await post({ permittedActions: ["read", "read", "list", "read"] });
            expect(folded.status).toBe(200);
            expect((await ctx.findOne("CalendarShareLink", folded.body.uid)).permittedActions).toEqual(["read", "list"]);
            const far = new Date(Date.now() + 5 * 366 * 24 * 60 * 60 * 1000).toISOString();
            expect((await post({ permittedActions: ["read"], expiresAt: far })).status).toBe(400);
            const put = (fields: any) =>
                auth(request(ctx.app()).put(url(`/calendar-share-links/${folded.body.uid}`)), owner).send({ uid: folded.body.uid, version: folded.body.version, ...fields });
            expect((await put({ expiresAt: null })).status).toBe(400);
            expect((await put({ expiresAt: far })).status).toBe(400);
            expect((await put({ expiresAt: folded.body.expiresAt })).status).toBe(200);
            for (let i = 0; i < 48; i++) {
                await ctx.save("CalendarShareLink", { folderUid: calendar.uid, token: `token-${i}`, permittedActions: ["read"], createdByUserUid: owner.uid, expiresAt: new Date(Date.now() + 1000000) });
            }
            expect((await post({ permittedActions: ["read"] })).status).toBe(400);
        });
    });


    describe("round 3: matter review (R2-10)", () => {
        const setupMatter = async () => {
            const scope = await ctx.save("EscrowScope", {
                name: "legal",
                publicKey: { publicKey: "base64cert", type: "x509", fingerprint: "abc123", notBefore: 1000, notAfter: 2000 },
                holderUserUids: [owner.uid],
                requiredHolders: 1,
                notifySubjectOnAccess: false,
            });
            const custodian = await createMailbox(other.uid, { escrowScopeId: scope.uid });
            const matter = await ctx.save("Matter", {
                name: "Investigation",
                escrowScopeId: scope.uid,
                custodianMailboxUids: [custodian.uid],
                dateRangeStart: new Date("2026-01-01"),
                dateRangeEnd: new Date("2026-06-01"),
            });
            return { scope, custodian, matter };
        };

        it("a review search is audited with the matter and a digest of the query, not its text", async () => {
            const { custodian, matter } = await setupMatter();
            const res = await auth(request(ctx.app()).get(url(`/matter-search?matterId=${matter.uid}&q=secretplan&limit=abc`)), owner);
            expect(res.status).toBe(200);
            expect(Object.keys(res.body)).toEqual([custodian.uid]);
            const entries = (await ctx.findAll("AuditLogEntry")).filter((e) => e.action === "matter.search");
            expect(entries).toHaveLength(1);
            expect(entries[0]).toMatchObject({ targetType: "Matter", targetUid: matter.uid, actorUserUid: owner.uid });
            expect(entries[0].details.custodianCount).toBe(1);
            expect(JSON.stringify(entries[0])).not.toContain("secretplan");
        });

        it("only one export of a matter is in progress at a time, and a download is audited", async () => {
            const { matter } = await setupMatter();
            const first = await auth(request(ctx.app()).post(url("/matter-export-requests")), owner).send({ matterId: matter.uid });
            expect(first.status).toBe(200);
            expect((await auth(request(ctx.app()).post(url("/matter-export-requests")), owner).send({ matterId: matter.uid })).status).toBe(409);
            expect(await ctx.count("MatterExportRequest")).toBe(1);

            await ctx.update("MatterExportRequest", first.body.uid, { status: "ready", blobKey: "exports/one" });
            await ctx.blobStore().put("exports/one", Buffer.from("{}\n"));
            const download = await auth(request(ctx.app()).get(url(`/matter-export-requests/${first.body.uid}/download`)), owner);
            expect(download.status).toBe(200);
            const entries = (await ctx.findAll("AuditLogEntry")).filter((e) => e.action === "matter_export.downloaded");
            expect(entries).toHaveLength(1);
            expect(entries[0]).toMatchObject({ targetUid: first.body.uid, actorUserUid: owner.uid });
            // A finished one no longer blocks the next.
            expect((await auth(request(ctx.app()).post(url("/matter-export-requests")), owner).send({ matterId: matter.uid })).status).toBe(200);
        });
    });


    describe("round 3: branding injection (R2-11)", () => {
        it("refuses asset URLs that aren't a path on this server or an https URL, and keeps a style that overlays the page out of the header", async () => {
            const put = (body: any) => auth(request(ctx.app()).put(url("/branding")), admin).send(body);
            for (const logoUrl of ["http://tracker.example/logo.png", "javascript:alert(1)", "data:image/png;base64,AAAA", "//evil.example/x.png", "https://user:pw@evil.example/x.png", "/x y"]) {
                expect((await put({ companyName: "Acme", title: "Mail", logoUrl })).status).toBe(400);
            }
            expect((await put({ companyName: "Acme", title: "Mail", logoUrl: "https://cdn.example/logo.png", stylesheetUrl: "/branding/stylesheet" })).status).toBe(200);
            const header =
                '<div style="position:fixed;top:0;left:0;width:100%;height:100%;color:red;background:url(https://evil.example/b.png)">Hi</div><img src="http://evil.example/p.gif"><img src="https://cdn.example/ok.png">';
            const res = await put({ companyName: "Acme", title: "Mail", headerHtml: header });
            expect(res.status).toBe(200);
            expect(res.body.headerHtml).not.toMatch(/position|url\(|background:|http:\/\/evil/);
            expect(res.body.headerHtml).toContain("color:red");
            expect(res.body.headerHtml).toContain("https://cdn.example/ok.png");
        });

        it("an uploaded stylesheet loses its imports and its references to other hosts", async () => {
            const css = '@import url("https://evil.example/x.css");\nbody { background: url(https://evil.example/b.png); }\n.logo { background: url(/branding/logo); }\n.e { background: u\\72l(//evil.example/c.png); }';
            const uploaded = await auth(request(ctx.app()).post(url("/branding/stylesheet")), admin).set("Content-Type", "text/css").send(Buffer.from(css));
            expect(uploaded.status).toBe(200);
            const served = await request(ctx.app()).get(url("/branding/stylesheet"));
            expect(served.status).toBe(200);
            const text: string = served.text ?? Buffer.from(served.body).toString();
            expect(text).not.toMatch(/@import|evil\.example/);
            expect(text).toContain("url(/branding/logo)");
        });
    });


    describe("round 3: domain names (R2-12)", () => {
        it("stores the normalized name, and refuses one that isn't a host name", async () => {
            const post = (name: any) => auth(request(ctx.app()).post(url("/domains")), admin).send({ name });
            const created = await post("  Mail.Example.COM ");
            expect(created.status).toBe(200);
            expect(created.body.name).toBe("mail.example.com");
            expect(created.body.uid).toBe("mail.example.com");
            for (const name of ["exa mple.com", "../etc/passwd", "a/b.example.com", "-bad.example.com", "bad..example.com", "x@example.com", 5, "", "a".repeat(64) + ".com"]) {
                expect((await post(name)).status).toBe(400);
            }
            expect(await ctx.count("Domain")).toBe(1);
        });
    });


    describe("round 3: retention floor (X2-12)", () => {
        it("a stored period below the floor can stay while the other one changes, and only a changed value is judged", async () => {
            await ctx.save("RetentionPolicy", { uid: "retention-policy", messageRetentionDays: 7, auditLogRetentionDays: 400 });
            const put = (body: any) => auth(request(ctx.app()).put(url("/retention-policy")), admin).send(body);
            const roundTrip = await put({ messageRetentionDays: 7, auditLogRetentionDays: 3000 });
            expect(roundTrip.status).toBe(200);
            expect(roundTrip.body).toMatchObject({ messageRetentionDays: 7, auditLogRetentionDays: 3000 });
            expect((await put({ messageRetentionDays: 5 })).status).toBe(400);
            expect((await put({ messageRetentionDays: 45 })).status).toBe(200);
            expect((await put({ messageRetentionDays: 7 })).status).toBe(400);
        });
    });


    describe("round 3: search parameters (R4-10)", () => {
        it("every filter must be a single string: a repeated or nested one is a 400, not a 500", async () => {
            const mine = await createMailbox(owner.uid);
            for (const query of ["q=a&q=b", "from=a&from=b", "to=a&to=b", "cc=a&cc=b", "subject=a&subject=b", "in=a&in=b", "q[x]=1", "limit=1&limit=2", "q=a&before=1&before=2"]) {
                const res = await auth(request(ctx.app()).get(url(`/search?mailboxUid=${mine.uid}&${query}`)), owner);
                expect(res.status, query).toBe(400);
            }
            const candidates = await auth(request(ctx.app()).get(url(`/search/candidates?mailboxUid=${mine.uid}&in=a&in=b`)), owner);
            expect(candidates.status).toBe(400);
            expect((await auth(request(ctx.app()).get(url(`/search?mailboxUid=${mine.uid}&q=hello`)), owner)).status).toBe(200);
        });
    });
}
