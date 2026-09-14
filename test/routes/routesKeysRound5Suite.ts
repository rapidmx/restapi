///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Round-5 review fixes for the mailbox and attachment routes, identical on both backends.
// `test/routes/{mongo,sql}/RoutesKeysRound5.test.ts` supply a started server and raw row helpers (the same context as
// `mailAuthzRound4Suite.ts`); everything under test goes through HTTP. The key-vault fixes are in
// `keyVaultRound5Suite.ts`.
import { request } from "@rapidrest/service-core/test";
import { ACLUtils } from "@rapidrest/service-core";
import * as uuid from "uuid";
import { FolderType, MessageImportance, RecipientType } from "../../src/models/types.js";
import type { MailAuthzRound4SuiteContext } from "./mailAuthzRound4Suite.js";

export type RoutesKeysRound5SuiteContext = MailAuthzRound4SuiteContext;

export function routesKeysRound5Suite(ctx: RoutesKeysRound5SuiteContext): void {
    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const other: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const viewer: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const auth = (req: any, user: any) => req.set("Authorization", "jwt " + ctx.tokenFor(user));
    const url = (path: string) => `${ctx.prefix}${path}`;
    const readOnly: string[] = ["read", "list", "exists", "count"];

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
    const createFolder = async (mailboxUid: string, type: FolderType, records: { userOrRoleId: string; actions: string[] }[] = []) => {
        const folder = await ctx.save("Folder", { mailboxUid, name: type, type, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 });
        await ctx.saveAcl({ uid: folder.uid, parentUid: mailboxUid, records });
        return folder;
    };
    const createMessage = (mailbox: any, folderUid: string) =>
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
        });
    const members = async (mailboxUid: string): Promise<string[]> =>
        ((await ctx.findAcl(mailboxUid))?.records ?? []).map((record: any) => record.userOrRoleId);

    describe("primary address renames (finding 1)", () => {
        it("are refused to the owner (no usernames here) on every update path, and allowed to an admin", async () => {
            const mailbox = await createMailbox(owner.uid);
            const target = `ceo-${uuid.v4()}@example.com`;
            const put = await auth(request(ctx.app()).put(url(`/mailboxes/${mailbox.uid}`)), owner).send({
                uid: mailbox.uid,
                version: mailbox.version,
                primarySmtpAddress: target,
            });
            expect(put.status).toBe(403);
            expect((await auth(request(ctx.app()).put(url(`/mailboxes/${mailbox.uid}/primarySmtpAddress`)), owner).send(target)).status).toBe(403);
            const bulk = await auth(request(ctx.app()).put(url("/mailboxes")), owner).send([{ uid: mailbox.uid, version: mailbox.version, primarySmtpAddress: target }]);
            expect(bulk.status).not.toBe(200);
            expect((await ctx.findOne("Mailbox", mailbox.uid)).primarySmtpAddress).toBe(mailbox.primarySmtpAddress);

            const renamed = await auth(request(ctx.app()).put(url(`/mailboxes/${mailbox.uid}/primarySmtpAddress`)), admin).send(target);
            expect(renamed.status).toBe(200);
            expect(renamed.body.primarySmtpAddress).toBe(target);
        });
    });

    describe("owner ACL moves (finding 2)", () => {
        it("a failed owner change leaves the old owner's grant in place, and retrying it completes the move", async () => {
            const mailbox = await createMailbox(owner.uid);
            await ctx.saveAcl({
                uid: mailbox.uid,
                parentUid: "Mailbox",
                records: [
                    { userOrRoleId: owner.uid, actions: ["*"] },
                    { userOrRoleId: viewer.uid, actions: readOnly },
                ],
            });

            // The ACL store fails (every retry): nothing is committed.
            const saveACL = vi.spyOn(ACLUtils.prototype, "saveACL").mockRejectedValue(new Error("acl store down"));
            try {
                const failed = await auth(request(ctx.app()).put(url(`/mailboxes/${mailbox.uid}`)), admin).send({
                    uid: mailbox.uid,
                    version: mailbox.version,
                    ownerUserUid: other.uid,
                });
                expect(failed.status).toBeGreaterThanOrEqual(500);
            } finally {
                saveACL.mockRestore();
            }
            expect((await ctx.findOne("Mailbox", mailbox.uid)).ownerUserUid).toBe(owner.uid);
            expect(await members(mailbox.uid)).toEqual(expect.arrayContaining([owner.uid, viewer.uid]));
            expect(await members(mailbox.uid)).not.toContain(other.uid);

            // The update itself fails after the ACL moved (a stale version): the move is undone.
            const stale = await auth(request(ctx.app()).put(url(`/mailboxes/${mailbox.uid}`)), admin).send({
                uid: mailbox.uid,
                version: Number(mailbox.version) + 5,
                ownerUserUid: other.uid,
            });
            expect(stale.status).toBe(409);
            expect((await ctx.findOne("Mailbox", mailbox.uid)).ownerUserUid).toBe(owner.uid);
            const afterStale = (await ctx.findAcl(mailbox.uid)).records;
            expect(afterStale).toEqual(expect.arrayContaining([expect.objectContaining({ userOrRoleId: owner.uid, actions: ["*"] })]));
            expect(afterStale.map((record: any) => record.userOrRoleId)).not.toContain(other.uid);

            // Retrying completes it: the ex-owner has no access left, delegates are untouched.
            const retried = await auth(request(ctx.app()).put(url(`/mailboxes/${mailbox.uid}/ownerUserUid`)), admin).send(other.uid);
            expect(retried.status).toBe(200);
            expect(await members(mailbox.uid)).toEqual(expect.arrayContaining([other.uid, viewer.uid]));
            expect(await members(mailbox.uid)).not.toContain(owner.uid);
            expect((await auth(request(ctx.app()).get(url(`/mailboxes/${mailbox.uid}`)), owner)).status).not.toBe(200);
        });

        it("a bulk update that fails partway keeps the moves it committed and undoes the rest", async () => {
            const first = await createMailbox(owner.uid);
            const second = await createMailbox(owner.uid);
            const result = await auth(request(ctx.app()).put(url("/mailboxes")), admin).send([
                { uid: first.uid, version: first.version, ownerUserUid: other.uid },
                { uid: second.uid, version: Number(second.version) + 5, ownerUserUid: other.uid },
            ]);
            expect(result.status).not.toBe(200);
            const firstOwner: string = (await ctx.findOne("Mailbox", first.uid)).ownerUserUid;
            // Whether the first row committed depends on the backend's bulk update; its ACL must follow its stored owner.
            expect(await members(first.uid)).toContain(firstOwner);
            expect(await members(first.uid)).not.toContain(firstOwner === owner.uid ? other.uid : owner.uid);
            expect((await ctx.findOne("Mailbox", second.uid)).ownerUserUid).toBe(owner.uid);
            expect(await members(second.uid)).toEqual([owner.uid]);
        });
    });

    describe("owner ACL moves, clearing the owner (finding 2)", () => {
        it("clearing the owner by property or bulk update removes the old owner's grant", async () => {
            const first = await createMailbox(owner.uid);
            const cleared = await auth(request(ctx.app()).put(url(`/mailboxes/${first.uid}/ownerUserUid`)), admin).send("");
            expect(cleared.status).toBe(200);
            expect(await members(first.uid)).not.toContain(owner.uid);

            const second = await createMailbox(owner.uid);
            const bulk = await auth(request(ctx.app()).put(url("/mailboxes")), admin).send([{ uid: second.uid, version: second.version, ownerUserUid: null }]);
            expect(bulk.status).toBe(200);
            expect(await members(second.uid)).not.toContain(owner.uid);
        });
    });

    describe("mailbox display names (finding 7)", () => {
        it("refuses '@' and line breaks on create, update, bulk update and property update, but keeps a stored name round-tripping", async () => {
            const created = await auth(request(ctx.app()).post(url("/mailboxes")), admin).send({
                primarySmtpAddress: `${uuid.v4()}@example.com`,
                displayName: "support@example.com",
                timezone: "UTC",
                ownerUserUid: owner.uid,
            });
            expect(created.status).toBe(400);
            expect(created.body.message).toMatch(/'displayName' must be text without '@' or line breaks/);
            const bulkCreated = await auth(request(ctx.app()).post(url("/mailboxes")), admin).send([
                { primarySmtpAddress: `${uuid.v4()}@example.com`, displayName: "Fine", timezone: "UTC" },
                { primarySmtpAddress: `${uuid.v4()}@example.com`, displayName: "Line\nBreak", timezone: "UTC" },
            ]);
            expect(bulkCreated.status).toBe(400);

            const mailbox = await createMailbox(owner.uid);
            for (const displayName of ["ceo@example.com", "Evil\r\nBcc: x", "Two\nLines", 42]) {
                const put = await auth(request(ctx.app()).put(url(`/mailboxes/${mailbox.uid}`)), owner).send({ uid: mailbox.uid, version: mailbox.version, displayName });
                expect(put.status).toBe(400);
            }
            expect((await auth(request(ctx.app()).put(url(`/mailboxes/${mailbox.uid}/displayName`)), owner).send("a@b")).status).toBe(400);
            expect((await auth(request(ctx.app()).put(url("/mailboxes")), owner).send([{ uid: mailbox.uid, version: mailbox.version, displayName: "a@b" }])).status).toBe(400);
            expect((await ctx.findOne("Mailbox", mailbox.uid)).displayName).toBe("Test Mailbox");

            const renamed = await auth(request(ctx.app()).put(url(`/mailboxes/${mailbox.uid}/displayName`)), owner).send("Support Team");
            expect(renamed.status).toBe(200);
            expect(renamed.body.displayName).toBe("Support Team");

            // A name stored before the check can be sent back unchanged while other settings are edited.
            await ctx.update("Mailbox", mailbox.uid, { displayName: "legacy@example.com" });
            const legacy = await ctx.findOne("Mailbox", mailbox.uid);
            const roundTrip = await auth(request(ctx.app()).put(url(`/mailboxes/${mailbox.uid}`)), owner).send({
                uid: mailbox.uid,
                version: legacy.version,
                displayName: "legacy@example.com",
                timezone: "Europe/Paris",
            });
            expect(roundTrip.status).toBe(200);
            expect(roundTrip.body.timezone).toBe("Europe/Paris");

            // No display name at all isn't refused by this check, and a missing mailbox is still a 404.
            const cleared = await auth(request(ctx.app()).put(url(`/mailboxes/${mailbox.uid}`)), owner).send({ uid: mailbox.uid, version: roundTrip.body.version, displayName: null });
            expect(cleared.body?.message ?? "").not.toMatch(/'displayName' must be text/);
            const missing = `${uuid.v4()}@example.com`;
            expect((await auth(request(ctx.app()).put(url(`/mailboxes/${missing}`)), admin).send({ uid: missing, version: 0, displayName: "Name" })).status).toBe(404);
        });
    });

    describe("attachments follow their message's current folder (finding 3)", () => {
        const setup = async (viewerDraftsActions: string[] = readOnly) => {
            const mailbox = await createMailbox(owner.uid);
            // `other` can read Sent Items only; `viewer` can read (or, for the write test, do anything in) Drafts only.
            const drafts = await createFolder(mailbox.uid, FolderType.DRAFTS, [{ userOrRoleId: viewer.uid, actions: viewerDraftsActions }]);
            const sent = await createFolder(mailbox.uid, FolderType.SENT_ITEMS, [{ userOrRoleId: other.uid, actions: readOnly }]);
            const message = await createMessage(mailbox, drafts.uid);
            const upload = await auth(request(ctx.app()).post(url(`/attachments/upload?messageUid=${message.uid}&filename=a.txt&mimeType=text/plain`)), owner)
                .set("Content-Type", "application/octet-stream")
                .send(Buffer.from("hello"));
            expect(upload.status).toBe(200);
            expect(upload.body.folderUid).toBe(drafts.uid);
            // Sent: the message moves and nothing re-stamps the attachment.
            await ctx.update("Message", message.uid, { folderUid: sent.uid });
            return { mailbox, drafts, sent, message, attachment: upload.body };
        };
        const list = (user: any, query: string) => auth(request(ctx.app()).get(url(`/attachments?${query}`)), user);
        const count = async (user: any, query: string) => Number((await auth(request(ctx.app()).head(url(`/attachments?${query}`)), user)).headers["content-length"]);
        const uids = (result: any): string[] => (result.body ?? []).map((row: any) => row.uid);

        it("lists and downloads a sent message's attachments for its owner and a Sent Items delegate, by messageUid (with or without a stale folderUid)", async () => {
            const { drafts, sent, message, attachment } = await setup();

            for (const query of [`messageUid=${message.uid}`, `messageUid=${message.uid}&folderUid=${drafts.uid}`, `messageUid=${message.uid}&folderUid=${sent.uid}`]) {
                const mine = await list(owner, query);
                expect(mine.status).toBe(200);
                expect(uids(mine)).toEqual([attachment.uid]);
                expect(mine.body[0].folderUid).toBe(sent.uid);
            }
            expect(uids(await list(other, `messageUid=${message.uid}&folderUid=${drafts.uid}`))).toEqual([attachment.uid]);
            expect(await count(other, `messageUid=${message.uid}`)).toBe(1);

            const download = await auth(request(ctx.app()).get(url(`/attachments/${attachment.uid}/content`)), other);
            expect(download.status).toBe(200);
            const byId = await auth(request(ctx.app()).get(url(`/attachments/${attachment.uid}`)), other);
            expect(byId.status).toBe(200);
            expect(byId.body.folderUid).toBe(sent.uid);
            expect((await auth(request(ctx.app()).head(url(`/attachments/${attachment.uid}`)), other)).status).toBe(200);
        });

        it("never shows a moved message's attachments to someone who can only read the folder it left", async () => {
            const { drafts, message, attachment } = await setup();

            expect(uids(await list(viewer, `messageUid=${message.uid}`))).toEqual([]);
            expect(await count(viewer, `messageUid=${message.uid}`)).toBe(0);
            expect(uids(await list(viewer, `folderUid=${drafts.uid}`))).toEqual([]);
            expect(await count(viewer, `folderUid=${drafts.uid}`)).toBe(0);
            // Not even the owner sees it under the folder it left.
            expect(uids(await list(owner, `folderUid=${drafts.uid}`))).toEqual([]);
            expect((await auth(request(ctx.app()).get(url(`/attachments/${attachment.uid}/content`)), viewer)).status).toBe(404);
            expect((await auth(request(ctx.app()).get(url(`/attachments/${attachment.uid}`)), viewer)).status).toBe(404);
            expect((await auth(request(ctx.app()).head(url(`/attachments/${attachment.uid}`)), viewer)).status).toBe(404);
            // A repeated messageUid names no single message.
            expect((await list(owner, `messageUid=${message.uid}&messageUid=${message.uid}`)).status).toBe(400);
        });

        it("lists by messageUid with the client's other filters (minus operators), keeps a message's attachments together in its folder, and falls back to the stored folder for an orphan", async () => {
            const { mailbox, drafts, sent, message, attachment } = await setup();
            const second = await auth(request(ctx.app()).post(url(`/attachments/upload?messageUid=${message.uid}&filename=b.txt&mimeType=text/plain`)), owner)
                .set("Content-Type", "application/octet-stream")
                .send(Buffer.from("world"));
            expect(second.status).toBe(200);
            expect(second.body.folderUid).toBe(sent.uid);

            const filtered = await list(owner, `messageUid=${message.uid}&filename=b.txt&deleted=true&mailboxUid=${mailbox.uid}&$or=x`);
            expect(filtered.status).toBe(200);
            expect(uids(filtered)).toEqual([second.body.uid]);
            // Folder-only, both of the message's attachments at once (one stamped Drafts, now re-listed by Sent Items).
            await ctx.update("Attachment", second.body.uid, { folderUid: drafts.uid });
            await ctx.update("Message", message.uid, { folderUid: drafts.uid });
            expect(uids(await list(owner, `folderUid=${drafts.uid}`)).sort()).toEqual([attachment.uid, second.body.uid].sort());
            expect(await count(owner, `folderUid=${drafts.uid}`)).toBe(2);

            // An attachment whose message is gone keeps its stored location.
            const orphan = await ctx.save("Attachment", {
                messageUid: uuid.v4(),
                folderUid: sent.uid,
                mailboxUid: mailbox.uid,
                filename: "orphan.txt",
                mimeType: "text/plain",
                sizeBytes: 1,
                blobKey: `attachments/${uuid.v4()}`,
                isInline: false,
            });
            expect((await auth(request(ctx.app()).get(url(`/attachments/${orphan.uid}`)), other)).status).toBe(200);
            expect((await auth(request(ctx.app()).get(url(`/attachments/${orphan.uid}`)), viewer)).status).toBe(404);
            expect(uids(await list(owner, `messageUid=${uuid.v4()}`))).toEqual([]);
            expect(await count(owner, `messageUid=${uuid.v4()}`)).toBe(0);

            // Folder-only counts still need COUNT on the folder, and a scope.
            expect(await count(viewer, `folderUid=${sent.uid}`)).toBe(0);
            expect((await auth(request(ctx.app()).head(url("/attachments")), owner)).status).toBe(400);
        });

        it("gates writes on the current folder: a Drafts-only writer can't delete or truncate it; the owner's writes re-stamp it", async () => {
            const { drafts, sent, message, attachment } = await setup(["*"]);

            // The owner's write, with the version they were given at upload.
            const renamed = await auth(request(ctx.app()).put(url(`/attachments/${attachment.uid}`)), owner).send({
                uid: attachment.uid,
                version: attachment.version,
                folderUid: drafts.uid,
                filename: "renamed.txt",
            });
            expect(renamed.status).toBe(200);
            expect(renamed.body.filename).toBe("renamed.txt");
            expect(renamed.body.folderUid).toBe(sent.uid);
            expect((await ctx.findOne("Attachment", attachment.uid)).folderUid).toBe(sent.uid);

            await ctx.update("Attachment", attachment.uid, { folderUid: drafts.uid });
            const staleAgain = await ctx.findOne("Attachment", attachment.uid);
            expect((await auth(request(ctx.app()).delete(url(`/attachments/${attachment.uid}`)), viewer)).status).toBe(403);
            expect((await auth(request(ctx.app()).put(url(`/attachments/${attachment.uid}`)), viewer).send({ uid: attachment.uid, version: staleAgain.version, filename: "x" })).status).toBe(403);
            // A refused caller's attempt re-stamps nothing.
            expect((await ctx.findOne("Attachment", attachment.uid)).folderUid).toBe(drafts.uid);
            await auth(request(ctx.app()).delete(url(`/attachments?folderUid=${drafts.uid}`)), viewer);
            expect(await ctx.findOne("Attachment", attachment.uid)).toBeDefined();
            expect((await ctx.findOne("Attachment", attachment.uid)).filename).toBe("renamed.txt");

            // The inherited checks still answer the usual way.
            expect((await auth(request(ctx.app()).put(url(`/attachments/${attachment.uid}`)), owner).send([{ filename: "x" }])).status).toBe(400);
            expect((await auth(request(ctx.app()).put(url(`/attachments/${uuid.v4()}`)), owner).send({ filename: "x" })).status).toBe(404);
            expect((await auth(request(ctx.app()).put(url(`/attachments/${attachment.uid}`)), owner).send({ uid: attachment.uid, version: 999, filename: "x" })).status).toBe(409);
            expect((await auth(request(ctx.app()).delete(url(`/attachments/${uuid.v4()}`)), owner)).status).toBe(404);
            expect((await auth(request(ctx.app()).delete(url("/attachments")), owner)).status).toBe(403);
            expect((await auth(request(ctx.app()).delete(url(`/attachments?folderUid=${sent.uid}`)), viewer)).status).toBe(403);

            const current = await ctx.findOne("Attachment", attachment.uid);
            expect([200, 204]).toContain((await auth(request(ctx.app()).delete(url(`/attachments/${attachment.uid}?version=${current.version}`)), owner)).status);
            expect(await ctx.findOne("Attachment", attachment.uid)).toBeUndefined();
            expect((await ctx.findOne("Message", message.uid)).hasAttachments).toBe(false);
        });
    });
}
