///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Round-6 review fixes (part B) for well-known folder ACLs, attachment truncates and mailbox owner changes/display names,
// identical on both backends. `test/routes/{mongo,sql}/RoutesKeysRound6.test.ts` supply a started server, raw row helpers
// (the same context as `mailAuthzRound4Suite.ts`), the object factory and the backend's `Folder` class.
import { request } from "@rapidrest/service-core/test";
import { ApiError } from "@rapidrest/core";
import { ACLAction, ACLUtils, CRUDRoute, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import * as uuid from "uuid";
import { FolderType, MessageImportance, RecipientType } from "../../src/models/types.js";
import { BaseAttachmentRoute } from "../../src/routes/BaseAttachmentRoute.js";
import { findOrCreateWellKnownFolder, wellKnownFolderUid } from "../../src/util/FolderUtils.js";
import type { MailAuthzRound4SuiteContext } from "./mailAuthzRound4Suite.js";

export interface RoutesKeysRound6SuiteContext extends MailAuthzRound4SuiteContext {
    objectFactory: () => ObjectFactory;
    folderClass: any;
}

export function routesKeysRound6Suite(ctx: RoutesKeysRound6SuiteContext): void {
    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const other: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const viewer: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
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
    const aclUtils = (): ACLUtils => ctx.objectFactory().getInstance<ACLUtils>(ACLUtils)!;
    const folderRepo = async (): Promise<RepoUtils<any>> =>
        await ctx.objectFactory().newInstance(RepoUtils, { name: ctx.folderClass.name, args: [ctx.folderClass] });
    const members = async (mailboxUid: string): Promise<string[]> =>
        ((await ctx.findAcl(mailboxUid))?.records ?? []).map((record: any) => record.userOrRoleId).sort();

    describe("well-known folder ACLs (findings 1 and 2)", () => {
        it("a create that loses the uid race after the winner reused its freshly claimed ACL leaves the winner with a working ACL", async () => {
            const mailbox = await createMailbox(owner.uid);
            const uid: string = wellKnownFolderUid(mailbox.uid, FolderType.INBOX);
            const repo: RepoUtils<any> = await folderRepo();
            let winner: any;
            // Replica A: claims a fresh ACL, then - before its insert - replica B runs the whole find-or-create, sees A's
            // ACL, reuses it and wins the uid. A's insert then fails on the unique index and RepoUtils.create() removes the
            // ACL it claimed, which is the only ACL B's folder has.
            const createSpy = vi.spyOn(repo, "create").mockImplementationOnce(async (instance: any) => {
                await aclUtils().saveACL({ uid: instance.uid, parentUid: mailbox.uid, records: [] }, { createOnly: true });
                winner = await findOrCreateWellKnownFolder(repo, ctx.folderClass, mailbox.uid, FolderType.INBOX);
                await aclUtils().removeACL(instance.uid);
                throw new ApiError("IDENTIFIER_EXISTS", 400, "Identifier exists");
            });
            try {
                const loser = await findOrCreateWellKnownFolder(repo, ctx.folderClass, mailbox.uid, FolderType.INBOX);
                expect(loser.uid).toBe(uid);
                expect(winner.uid).toBe(uid);
            } finally {
                createSpy.mockRestore();
            }
            expect(await ctx.findAcl(uid)).toEqual(expect.objectContaining({ uid, parentUid: mailbox.uid }));
            expect(await aclUtils().hasPermission(owner, uid, ACLAction.READ)).toBe(true);
            expect(await aclUtils().hasPermission(other, uid, ACLAction.READ)).toBe(false);

            // A folder already left without its ACL is repaired the next time it is looked up.
            await aclUtils().removeACL(uid);
            expect((await findOrCreateWellKnownFolder(repo, ctx.folderClass, mailbox.uid, FolderType.INBOX)).uid).toBe(uid);
            expect(await aclUtils().hasPermission(owner, uid, ACLAction.READ)).toBe(true);
        });

        it("resetting a leftover ACL removes only its stale records and keeps a share granted right after the insert", async () => {
            const mailbox = await createMailbox(owner.uid);
            const uid: string = wellKnownFolderUid(mailbox.uid, FolderType.CALENDAR);
            // Left behind by an earlier incarnation of the folder: a stale grant and another parent.
            await ctx.saveAcl({ uid, parentUid: "Folder", records: [{ userOrRoleId: other.uid, actions: ["read", "list"] }] });
            const repo: RepoUtils<any> = await folderRepo();
            const originalCreate = repo.create.bind(repo);
            const createSpy = vi.spyOn(repo, "create").mockImplementationOnce(async (instance: any, options: any) => {
                const created = await originalCreate(instance, options);
                // A share granted between the insert and the reset.
                const acl = (await aclUtils().findACL(uid, [], { skipCache: true, skipParents: true }))!;
                acl.records = [...acl.records, { userOrRoleId: viewer.uid, actions: ["read", "freebusy"] }];
                await aclUtils().saveACL(acl);
                return created;
            });
            try {
                await findOrCreateWellKnownFolder(repo, ctx.folderClass, mailbox.uid, FolderType.CALENDAR);
            } finally {
                createSpy.mockRestore();
            }
            const acl = await ctx.findAcl(uid);
            expect(acl.parentUid).toBe(mailbox.uid);
            expect(acl.records.map((record: any) => record.userOrRoleId)).toEqual([viewer.uid]);
            expect(await aclUtils().hasPermission(owner, uid, ACLAction.READ)).toBe(true);
            expect(await aclUtils().hasPermission(other, uid, ACLAction.READ)).toBe(false);
        });
    });

    describe("attachment truncate re-stamping (finding 3)", () => {
        const attachmentRoute = (): BaseAttachmentRoute<any> =>
            [...((ctx.objectFactory() as any).instances as Map<string, any>).values()].find((instance) => instance instanceof BaseAttachmentRoute);

        it("re-stamps every stale attachment across several pages before truncating, so none of a moved message's attachments is deleted", async () => {
            const mailbox = await createMailbox(owner.uid);
            // `viewer` may do anything in Drafts, but can't even read Sent Items.
            const drafts = await createFolder(mailbox.uid, FolderType.DRAFTS, [{ userOrRoleId: viewer.uid, actions: ["*"] }]);
            const sent = await createFolder(mailbox.uid, FolderType.SENT_ITEMS);
            const sentMessage = await createMessage(mailbox, sent.uid);
            const draftMessage = await createMessage(mailbox, drafts.uid);
            const save = (message: any, folderUid: string) =>
                ctx.save("Attachment", {
                    messageUid: message.uid,
                    folderUid,
                    mailboxUid: mailbox.uid,
                    filename: "a.txt",
                    mimeType: "text/plain",
                    sizeBytes: 1,
                    blobKey: `attachments/${uuid.v4()}`,
                    isInline: false,
                });
            // Seven attachments still stamped Drafts whose message was sent, and two that really are in Drafts.
            const stale: any[] = [];
            for (let i = 0; i < 7; i++) {
                stale.push(await save(sentMessage, drafts.uid));
            }
            const inDrafts = [await save(draftMessage, drafts.uid), await save(draftMessage, drafts.uid)];

            const route = attachmentRoute();
            const pageSize: number = (route as any).folderScanPageSize;
            (route as any).folderScanPageSize = 2;
            try {
                const result = await auth(request(ctx.app()).delete(url(`/attachments?folderUid=${drafts.uid}`)), viewer);
                expect([200, 204]).toContain(result.status);
            } finally {
                (route as any).folderScanPageSize = pageSize;
            }

            for (const attachment of stale) {
                const stored = await ctx.findOne("Attachment", attachment.uid);
                expect(stored, attachment.uid).toBeDefined();
                expect(stored.folderUid).toBe(sent.uid);
            }
            for (const attachment of inDrafts) {
                expect(await ctx.findOne("Attachment", attachment.uid)).toBeUndefined();
            }
        });
    });

    describe("owner change rollbacks (finding 4)", () => {
        it("undoes the moves of a failed bulk update naming the same mailbox twice newest first, restoring the original owner grant", async () => {
            const mailbox = await createMailbox(owner.uid);
            const result = await auth(request(ctx.app()).put(url("/mailboxes")), admin).send([
                { uid: mailbox.uid, version: Number(mailbox.version) + 5, ownerUserUid: other.uid },
                { uid: mailbox.uid, version: Number(mailbox.version) + 5, ownerUserUid: viewer.uid },
            ]);
            expect(result.status).not.toBe(200);
            expect((await ctx.findOne("Mailbox", mailbox.uid)).ownerUserUid).toBe(owner.uid);
            const records = (await ctx.findAcl(mailbox.uid)).records;
            expect(records.map((record: any) => record.userOrRoleId)).toEqual([owner.uid]);
            expect(records[0].actions).toEqual(["*"]);
        });

        it("doesn't replay its snapshot over an ACL another owner change rewrote after it", async () => {
            const mailbox = await createMailbox(owner.uid);
            const update = vi.spyOn(CRUDRoute.prototype, "update").mockImplementationOnce(async () => {
                // Meanwhile, another request moves the grant to `viewer`.
                await ctx.saveAcl({ uid: mailbox.uid, parentUid: "Mailbox", records: [{ userOrRoleId: viewer.uid, actions: [ACLAction.FULL] }] });
                throw new ApiError("IDENTIFIER_EXISTS", 409, "conflict");
            });
            try {
                const result = await auth(request(ctx.app()).put(url(`/mailboxes/${mailbox.uid}`)), admin).send({
                    uid: mailbox.uid,
                    version: mailbox.version,
                    ownerUserUid: other.uid,
                });
                expect(result.status).toBe(409);
            } finally {
                update.mockRestore();
            }
            expect(await members(mailbox.uid)).toEqual([viewer.uid]);
        });
    });

    describe("mailbox display names (finding 5)", () => {
        it("refuses fullwidth and small commercial at, and encoded words showing an @, but accepts ordinary names", async () => {
            const mailbox = await createMailbox(owner.uid);
            for (const displayName of ["support＠example.com", "support﹫example.com", "=?utf-8?q?ceo=40example.com?=", "=?UTF-8?B?Y2VvQGV4YW1wbGUuY29t?="]) {
                const result = await auth(request(ctx.app()).put(url(`/mailboxes/${mailbox.uid}/displayName`)), owner).send(displayName);
                expect(result.status, displayName).toBe(400);
                expect(result.body.message).toMatch(/'displayName' must be text without '@' or line breaks/);
            }
            expect((await ctx.findOne("Mailbox", mailbox.uid)).displayName).toBe("Test Mailbox");
            const created = await auth(request(ctx.app()).post(url("/mailboxes")), admin).send({
                primarySmtpAddress: `${uuid.v4()}@example.com`,
                displayName: "help＠example.com",
                timezone: "UTC",
            });
            expect(created.status).toBe(400);

            for (const displayName of ["Café Team", "O'Brien, Pat (EU)", 'The "Support" Desk', "東京オフィス", "Back\\slash"]) {
                const result = await auth(request(ctx.app()).put(url(`/mailboxes/${mailbox.uid}/displayName`)), owner).send(displayName);
                expect(result.status, displayName).toBe(200);
                expect(result.body.displayName).toBe(displayName);
            }
        });
    });
}
