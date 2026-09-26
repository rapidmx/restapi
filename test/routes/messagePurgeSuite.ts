///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Permanent deletion of messages (`DELETE /messages/:id?purge=true` and `DELETE /messages?folderUid=`): their attachments and blobs go
// with them unless another row still references a blob, a truncate is audited, and a legal hold's refusal does not name matters to
// callers who may not see them - identical on both backends. `test/routes/{mongo,sql}/MessagePurge.test.ts` supply a started server
// and raw row helpers.
import { request } from "@rapidrest/service-core/test";
import { ACLAction, RepoUtils } from "@rapidrest/service-core";
import * as uuid from "uuid";
import { AuditAction, FolderType, IngestStatus, MessageImportance, QuarantineReason, RecipientType } from "../../src/models/types.js";
import type { InMemoryBlobStore } from "../testDoubles.js";

export interface MessagePurgeSuiteContext {
    app: () => any;
    baseUrl: string;
    tokenFor: (user: any) => string;
    /** Saves a mailbox with an ACL giving `ownerUid` every action plus `records`. */
    saveMailbox: (ownerUid: string, records?: { userOrRoleId: string; actions: string[] }[]) => Promise<any>;
    /** Saves a folder with an ACL under its mailbox carrying `records`. */
    saveFolder: (mailboxUid: string, type: FolderType, records?: { userOrRoleId: string; actions: string[] }[]) => Promise<any>;
    saveMessage: (fields: Record<string, any>) => Promise<any>;
    findMessage: (uid: string) => Promise<any>;
    saveAttachment: (fields: Record<string, any>) => Promise<any>;
    findAttachments: (messageUid: string) => Promise<any[]>;
    saveQuarantine: (fields: Record<string, any>) => Promise<any>;
    saveIngest: (fields: Record<string, any>) => Promise<any>;
    saveMatter: (fields: Record<string, any>) => Promise<any>;
    /** Every audit log entry with `action`. */
    auditEntries: (action: string) => Promise<any[]>;
    blobStore: () => InMemoryBlobStore;
}

export function messagePurgeSuite(ctx: MessagePurgeSuiteContext): void {
    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const auth = (user: any): string => "jwt " + ctx.tokenFor(user);

    /** A mailbox (owner: everything; admin: a full grant, since a trusted role is none) with an Inbox. */
    const world = async () => {
        const records = [{ userOrRoleId: admin.uid, actions: [ACLAction.FULL] }];
        const mailbox = await ctx.saveMailbox(owner.uid, records);
        const folder = await ctx.saveFolder(mailbox.uid, FolderType.INBOX, records);
        return { mailbox, folder, records };
    };
    let counter = 0;
    /** Puts `content` in the blob store under a fresh key with `prefix` and returns the key. */
    const blob = async (prefix: string): Promise<string> => {
        const key = `${prefix}/${uuid.v4()}`;
        await ctx.blobStore().put(key, Buffer.from(`content ${++counter}`));
        return key;
    };
    const exists = (key: string): Promise<boolean> => ctx.blobStore().exists(key);

    /** A message in `folder` with its own blobs (raw, sanitized HTML), `attachments` attachments each with content and extracted text. */
    const seed = async (w: { mailbox: any; folder: any }, options: { attachments?: number; fields?: Record<string, any> } = {}) => {
        const bodyBlobKey = await blob("bodies");
        const sanitizedHtmlBlobKey = await blob("sanitized");
        const message = await ctx.saveMessage({
            mailboxUid: w.mailbox.uid,
            folderUid: w.folder.uid,
            messageId: `${uuid.v4()}@example.com`,
            subject: "Doomed",
            from: { address: "sender@example.com", type: RecipientType.TO },
            recipients: [{ address: "owner@example.com", type: RecipientType.TO }],
            sentDate: new Date("2025-06-01"),
            receivedDate: new Date("2025-06-01"),
            bodyBlobKey,
            sanitizedHtmlBlobKey,
            bodyPreview: "Doomed",
            flags: { read: false, flagged: false, answered: false, forwarded: false },
            importance: MessageImportance.NORMAL,
            references: [],
            hasAttachments: (options.attachments ?? 0) > 0,
            ...options.fields,
        });
        const attachments: any[] = [];
        for (let i = 0; i < (options.attachments ?? 0); i++) {
            attachments.push(
                await ctx.saveAttachment({
                    messageUid: message.uid,
                    folderUid: w.folder.uid,
                    mailboxUid: w.mailbox.uid,
                    filename: `file${i}.txt`,
                    mimeType: "text/plain",
                    sizeBytes: 9,
                    blobKey: await blob("attachments"),
                    extractedTextBlobKey: await blob("extracted"),
                }),
            );
        }
        return { message, attachments, blobKeys: [bodyBlobKey, sanitizedHtmlBlobKey, ...attachments.flatMap((a) => [a.blobKey, a.extractedTextBlobKey])] };
    };
    /** A second message row sharing `message`'s body and HTML blobs, in the same folder. */
    const copyOf = (message: any) =>
        ctx.saveMessage({
            mailboxUid: message.mailboxUid,
            folderUid: message.folderUid,
            messageId: `${uuid.v4()}@example.com`,
            subject: message.subject,
            from: { address: "sender@example.com", type: RecipientType.TO },
            recipients: [],
            sentDate: message.sentDate,
            receivedDate: message.receivedDate,
            bodyBlobKey: message.bodyBlobKey,
            sanitizedHtmlBlobKey: message.sanitizedHtmlBlobKey,
            bodyPreview: "",
            flags: { read: false, flagged: false, answered: false, forwarded: false },
            importance: MessageImportance.NORMAL,
            references: [],
            hasAttachments: message.hasAttachments,
        });
    /** A second attachment row sharing `attachment`'s content blobs, belonging to `messageUid` in `folderUid`. */
    const copyOfAttachment = (attachment: any, messageUid: string, folderUid: string) =>
        ctx.saveAttachment({
            messageUid,
            folderUid,
            mailboxUid: attachment.mailboxUid,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            blobKey: attachment.blobKey,
            extractedTextBlobKey: attachment.extractedTextBlobKey,
        });
    const purge = (uid: string, user: any = owner) => request(ctx.app()).delete(`${ctx.baseUrl}/${uid}?purge=true`).set("Authorization", auth(user));
    const truncate = (folderUid: string, user: any = owner) => request(ctx.app()).delete(`${ctx.baseUrl}?folderUid=${folderUid}`).set("Authorization", auth(user));

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("DELETE /:id?purge=true", () => {
        it("Deletes the message's attachments and every blob it and they name - the raw message, sanitized HTML, attachment content and extracted text.", async () => {
            const w = await world();
            const { message, attachments, blobKeys } = await seed(w, { attachments: 2 });

            const res = await purge(message.uid);

            expect(res.status).toBeLessThan(300);
            expect(await ctx.findMessage(message.uid)).toBeFalsy();
            expect(await ctx.findAttachments(message.uid)).toHaveLength(0);
            expect(attachments).toHaveLength(2);
            for (const key of blobKeys) {
                expect(await exists(key), key).toBe(false);
            }
        });

        it("Leaves the attachments and blobs of a message that is only soft-deleted, which stays recoverable.", async () => {
            const w = await world();
            const { message, blobKeys } = await seed(w, { attachments: 1 });

            const res = await request(ctx.app()).delete(`${ctx.baseUrl}/${message.uid}`).set("Authorization", auth(owner));

            expect(res.status).toBeLessThan(300);
            expect(await ctx.findAttachments(message.uid)).toHaveLength(1);
            for (const key of blobKeys) {
                expect(await exists(key), key).toBe(true);
            }
        });

        it("Keeps a blob another message still references - a mail filter rule's copy shares the raw message, HTML and attachments - until the last of them goes.", async () => {
            const w = await world();
            const original = await seed(w, { attachments: 1 });
            const copy = await copyOf(original.message);
            await copyOfAttachment(original.attachments[0], copy.uid, w.folder.uid);

            await purge(original.message.uid);
            for (const key of original.blobKeys) {
                expect(await exists(key), `shared ${key}`).toBe(true);
            }
            expect(await ctx.findAttachments(original.message.uid)).toHaveLength(0);
            expect(await ctx.findAttachments(copy.uid)).toHaveLength(1);

            await purge(copy.uid);
            for (const key of original.blobKeys) {
                expect(await exists(key), `last ${key}`).toBe(false);
            }
        });

        it("Keeps a blob a soft-deleted message still references (it is recoverable).", async () => {
            const w = await world();
            const { message } = await seed(w);
            await ctx.saveMessage({
                mailboxUid: w.mailbox.uid,
                folderUid: w.folder.uid,
                messageId: `${uuid.v4()}@example.com`,
                subject: "Trashed",
                from: { address: "sender@example.com", type: RecipientType.TO },
                recipients: [],
                sentDate: new Date("2025-06-01"),
                receivedDate: new Date("2025-06-01"),
                bodyBlobKey: message.bodyBlobKey,
                bodyPreview: "",
                flags: { read: false, flagged: false, answered: false, forwarded: false },
                importance: MessageImportance.NORMAL,
                references: [],
                hasAttachments: false,
                deleted: true,
            });

            await purge(message.uid);

            expect(await exists(message.bodyBlobKey)).toBe(true);
            expect(await exists(message.sanitizedHtmlBlobKey)).toBe(false);
        });

        it("Keeps the raw message while a recipient's queued (not yet delivered) ingest entry or a quarantine entry still points at it, and deletes it once the entry is delivered.", async () => {
            const w = await world();
            const queued = await seed(w);
            await ctx.saveIngest({ mailboxUid: w.mailbox.uid, envelopeFrom: "a@x.example", envelopeTo: ["b@y.example"], rawBlobKey: queued.message.bodyBlobKey, status: IngestStatus.PENDING });
            const held = await seed(w);
            await ctx.saveQuarantine({ mailboxUid: w.mailbox.uid, reason: QuarantineReason.SPAM_POLICY, scanResultUid: uuid.v4(), rawBlobKey: held.message.bodyBlobKey });
            const delivered = await seed(w);
            await ctx.saveIngest({ mailboxUid: w.mailbox.uid, envelopeFrom: "a@x.example", envelopeTo: ["b@y.example"], rawBlobKey: delivered.message.bodyBlobKey, status: IngestStatus.DELIVERED });

            await purge(queued.message.uid);
            await purge(held.message.uid);
            await purge(delivered.message.uid);

            expect(await exists(queued.message.bodyBlobKey)).toBe(true);
            expect(await exists(held.message.bodyBlobKey)).toBe(true);
            expect(await exists(delivered.message.bodyBlobKey)).toBe(false);
            // Their own sanitized HTML is nobody else's.
            expect(await exists(queued.message.sanitizedHtmlBlobKey)).toBe(false);
        });

        it("Still deletes the message when a blob cannot be deleted, or an attachment row cannot - each is logged, never an error.", async () => {
            const w = await world();
            const { message } = await seed(w, { attachments: 2 });
            const originalDelete = RepoUtils.prototype.delete;
            let failed = false;
            vi.spyOn(RepoUtils.prototype, "delete").mockImplementation(async function (this: any, ...args: any[]) {
                if (!failed && String(this.modelClass?.name).startsWith("Attachment")) {
                    failed = true;
                    throw new Error("attachment row failure");
                }
                return await (originalDelete as any).apply(this, args);
            });
            vi.spyOn(ctx.blobStore(), "delete").mockRejectedValue(new Error("blob store down"));

            const res = await purge(message.uid);

            expect(res.status).toBeLessThan(300);
            expect(await ctx.findMessage(message.uid)).toBeFalsy();
            expect(await ctx.findAttachments(message.uid)).toHaveLength(1);
        });

        it("Writes the existing message.delete audit entry as before.", async () => {
            const w = await world();
            const { message } = await seed(w);

            await purge(message.uid);

            const entries = (await ctx.auditEntries(AuditAction.MESSAGE_DELETE)).filter((entry) => entry.targetUid === message.uid);
            expect(entries).toHaveLength(1);
        });
    });

    describe("DELETE /?folderUid=", () => {
        it("Deletes every message's attachments and blobs, keeps what messages elsewhere still reference, and audits it once.", async () => {
            const w = await world();
            const other = await ctx.saveFolder(w.mailbox.uid, FolderType.ARCHIVE, w.records);
            const a = await seed(w, { attachments: 1 });
            const b = await seed(w, { attachments: 2 });
            // A message in another folder shares `a`'s raw message and attachment blob.
            const survivor = await seed({ mailbox: w.mailbox, folder: other }, { fields: { bodyBlobKey: a.message.bodyBlobKey } });
            await copyOfAttachment(a.attachments[0], survivor.message.uid, other.uid);

            const res = await truncate(w.folder.uid);

            expect(res.status).toBeLessThan(300);
            expect(await ctx.findMessage(a.message.uid)).toBeFalsy();
            expect(await ctx.findMessage(b.message.uid)).toBeFalsy();
            expect(await ctx.findMessage(survivor.message.uid)).toBeTruthy();
            expect(await ctx.findAttachments(a.message.uid)).toHaveLength(0);
            expect(await ctx.findAttachments(b.message.uid)).toHaveLength(0);
            expect(await ctx.findAttachments(survivor.message.uid)).toHaveLength(1);
            for (const key of b.blobKeys) {
                expect(await exists(key), `b ${key}`).toBe(false);
            }
            expect(await exists(a.message.bodyBlobKey)).toBe(true);
            expect(await exists(a.attachments[0].blobKey)).toBe(true);
            expect(await exists(a.message.sanitizedHtmlBlobKey)).toBe(false);

            const entries = await ctx.auditEntries(AuditAction.MESSAGE_TRUNCATE);
            expect(entries).toHaveLength(1);
            expect(entries[0]).toMatchObject({ targetType: "Folder", targetUid: w.folder.uid, mailboxUid: w.mailbox.uid, actorUserUid: owner.uid });
            expect(entries[0].details).toEqual({ folderUid: w.folder.uid, count: 2 });
        });

        it("Deletes the blobs two messages of the same truncate share, since neither is left to reference them.", async () => {
            const w = await world();
            const first = await seed(w, { attachments: 1 });
            const twin = await copyOf(first.message);
            await copyOfAttachment(first.attachments[0], twin.uid, w.folder.uid);

            await truncate(w.folder.uid);

            for (const key of first.blobKeys) {
                expect(await exists(key), key).toBe(false);
            }
        });

        it("Writes no audit entry for an empty folder.", async () => {
            const w = await world();

            const res = await truncate(w.folder.uid);

            expect(res.status).toBeLessThan(300);
            expect(await ctx.auditEntries(AuditAction.MESSAGE_TRUNCATE)).toHaveLength(0);
        });

        it("Is refused (409) by a legal hold - nothing is deleted - and audits the refusal as legal_hold.blocked_delete with details.truncate.", async () => {
            const w = await world();
            const { message, blobKeys } = await seed(w, { attachments: 1 });
            await ctx.saveMatter({ name: "Investigation", escrowScopeId: uuid.v4(), custodianMailboxUids: [w.mailbox.uid], dateRangeStart: new Date("2020-01-01"), dateRangeEnd: new Date("2030-01-01") });

            const res = await truncate(w.folder.uid);

            expect(res.status).toBe(409);
            expect(await ctx.findMessage(message.uid)).toBeTruthy();
            for (const key of blobKeys) {
                expect(await exists(key), key).toBe(true);
            }
            const entries = (await ctx.auditEntries(AuditAction.LEGAL_HOLD_BLOCKED_DELETE)).filter((entry) => entry.targetUid === w.folder.uid);
            expect(entries).toHaveLength(1);
            expect(entries[0]).toMatchObject({ targetType: "Folder", mailboxUid: w.mailbox.uid, actorUserUid: owner.uid });
            expect(entries[0].details).toEqual({ folderUid: w.folder.uid, truncate: true, count: 1 });
            expect(await ctx.auditEntries(AuditAction.MESSAGE_TRUNCATE)).toHaveLength(0);
        });
    });

    describe("The legal hold's refusal text", () => {
        it("Does not name the matters to an ordinary mailbox user, on a purge or a truncate - the status and code stay the same.", async () => {
            const w = await world();
            const { message } = await seed(w);
            const matter = await ctx.saveMatter({ name: "Investigation", escrowScopeId: uuid.v4(), custodianMailboxUids: [w.mailbox.uid], dateRangeStart: new Date("2020-01-01"), dateRangeEnd: new Date("2030-01-01") });

            const single = await purge(message.uid);
            const bulk = await truncate(w.folder.uid);

            for (const res of [single, bulk]) {
                expect(res.status).toBe(409);
                expect(res.body.message).toBe("This action is blocked by an active legal hold.");
                expect(JSON.stringify(res.body)).not.toContain(matter.uid);
            }
            expect(single.body.code).toBe(bulk.body.code);
        });

        it("Still names them to a caller with a trusted role.", async () => {
            const w = await world();
            const { message } = await seed(w);
            const matter = await ctx.saveMatter({ name: "Investigation", escrowScopeId: uuid.v4(), custodianMailboxUids: [w.mailbox.uid], dateRangeStart: new Date("2020-01-01"), dateRangeEnd: new Date("2030-01-01") });

            const single = await purge(message.uid, admin);
            const bulk = await truncate(w.folder.uid, admin);

            for (const res of [single, bulk]) {
                expect(res.status).toBe(409);
                expect(res.body.message).toContain(matter.uid);
            }
        });
    });
}
