///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// (f) of the access matrix, and what an administrator (trusted + elevated) may still do to a mailbox they hold no grant on:
// `?scope=admin` shows administrative metadata only and is audited; management writes reach only the administrative fields
// and are audited; the Sharing action is the one explicit, audited way to reach a mailbox (an ownerless one, for oneself);
// the compliance data export is its own workflow. Identical on both backends - see `mailAccessMatrixSuite.ts`.
import { request } from "@rapidrest/service-core/test";
import * as uuid from "uuid";
import { FolderType, QuarantineReason } from "../../src/models/types.js";
import type { MailAccessMatrixContext } from "./mailAccessMatrixSuite.js";

export function mailAdminScopeSuite(ctx: MailAccessMatrixContext): void {
    const person = (roles: string[] = [], elevated: number = Date.now()): any => ({ uid: uuid.v4(), roles, scopes: [], elevated });
    const owner = person();
    const delegate = person();
    const stranger = person();
    const admin = person(["admin"]);
    const unelevatedAdmin = { ...admin, elevated: undefined };
    const auth = (req: any, user: any) => req.set("Authorization", "jwt " + ctx.token(user));
    const url = (path: string) => `${ctx.prefix}${path}`;
    const audit = async (action: string, where: Record<string, any> = {}): Promise<any[]> => await ctx.store().find("AuditLogEntry", { action, ...where });

    /** A mailbox (owned by `owner`, or ownerless) with the owner's - or nobody's - full grant, a delegate's read grant and an Inbox. */
    const mailbox = async (owned: boolean = true, fields: Record<string, any> = {}): Promise<{ mailbox: any; inbox: any }> => {
        const store = ctx.store();
        const marker: string = `admin-${uuid.v4()}`;
        const created = await store.save("Mailbox", {
            ...(owned ? { ownerUserUid: owner.uid } : {}),
            primarySmtpAddress: `${marker}@example.com`,
            aliasAddresses: [],
            displayName: `Name ${marker}`,
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
            oofMessage: `Away ${marker}`,
            ...fields,
        });
        await store.saveAcl(created.uid, "Mailbox", [
            ...(owned ? [{ userOrRoleId: owner.uid, actions: ["*"] }] : []),
            { userOrRoleId: delegate.uid, actions: ["read", "list", "count", "exists", "update"] },
        ]);
        const inbox = await store.save("Folder", { mailboxUid: created.uid, name: "Inbox", type: FolderType.INBOX, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 });
        await store.saveAcl(inbox.uid, created.uid, []);
        return { mailbox: created, inbox };
    };
    const stored = async (uid: string): Promise<any> => (await ctx.store().find("Mailbox", { uid }))[0];

    describe("Administration scope on mailboxes (?scope=admin)", () => {
        it("Lists every mailbox as metadata - filterable and sortable by that metadata only - with one audit entry per call.", async () => {
            const a = await mailbox(true, { isResource: false });
            const b = await mailbox(false);
            const before = (await audit("mailbox.admin-list")).length;

            const result = await auth(request(ctx.app()).get(url("/mailboxes?scope=admin&sort=-dateCreated&limit=1000")), admin);
            expect(result.status).toBe(200);
            const uids = result.body.map((row: any) => row.uid);
            expect(uids).toEqual(expect.arrayContaining([a.mailbox.uid, b.mailbox.uid]));
            const shared = result.body.find((row: any) => row.uid === b.mailbox.uid);
            expect(shared).toMatchObject({ primarySmtpAddress: b.mailbox.primarySmtpAddress, shared: true, quotaBytes: 1_000_000_000 });
            const personal = result.body.find((row: any) => row.uid === a.mailbox.uid);
            expect(personal).toMatchObject({ ownerUserUid: owner.uid, shared: false });
            expect(Object.keys(personal).sort()).not.toContain("oofMessage");
            expect(Object.keys(personal).sort()).not.toContain("keys");
            expect((await audit("mailbox.admin-list")).length).toBe(before + 1);

            // A sort by a hidden field is dropped, a filter on one is ignored, a known one applies.
            expect((await auth(request(ctx.app()).get(url("/mailboxes?scope=admin&sort=oofMessage")), admin)).status).toBe(200);
            const filtered = await auth(request(ctx.app()).get(url(`/mailboxes?scope=admin&primarySmtpAddress=${encodeURIComponent(a.mailbox.primarySmtpAddress)}`)), admin);
            expect(filtered.body.map((row: any) => row.uid)).toEqual([a.mailbox.uid]);
        });

        it("Counts and checks existence for the administration scope only - a plain call is the caller's own mailboxes.", async () => {
            const { mailbox: m } = await mailbox();
            const count = await auth(request(ctx.app()).head(url("/mailboxes?scope=admin")), admin);
            expect(Number(count.headers["content-length"])).toBeGreaterThanOrEqual(1);
            expect((await auth(request(ctx.app()).head(url(`/mailboxes/${m.uid}?scope=admin`)), admin)).status).toBe(200);
            expect((await auth(request(ctx.app()).head(url(`/mailboxes/${m.uid}`)), admin)).status).toBe(404);
            expect((await auth(request(ctx.app()).head(url(`/mailboxes/${m.uid}?scope=admin`)), owner)).status).toBe(403);
            expect((await auth(request(ctx.app()).get(url(`/mailboxes/${uuid.v4()}?scope=admin`)), admin)).status).toBe(404);
        });

        it("Is refused to an unelevated administrator (403 api-104) and an ordinary caller (403 api-103); an anonymous one gets nothing.", async () => {
            const { mailbox: m } = await mailbox();
            const unelevated = await auth(request(ctx.app()).get(url(`/mailboxes/${m.uid}?scope=admin`)), unelevatedAdmin);
            expect([unelevated.status, unelevated.body.code]).toEqual([403, "api-104"]);
            const ordinary = await auth(request(ctx.app()).get(url("/mailboxes?scope=admin")), stranger);
            expect([ordinary.status, ordinary.body.code]).toEqual([403, "api-103"]);
            const anonymous = await request(ctx.app()).get(url("/mailboxes?scope=admin"));
            expect(anonymous.body).toEqual([]);
        });
    });

    describe("The administration scope on routes that don't offer it", () => {
        it("Is ignored: an administrator gets no more from folders, messages or contacts with ?scope=admin than without it.", async () => {
            const { mailbox: m, inbox } = await mailbox();
            for (const path of [`/folders?mailboxUid=${m.uid}`, `/messages?folderUid=${inbox.uid}`, `/contacts?folderUid=${inbox.uid}`, `/labels?mailboxUid=${m.uid}`]) {
                const result = await auth(request(ctx.app()).get(url(`${path}&scope=admin`)), admin);
                expect([path, result.status, result.body]).toEqual([path, 200, []]);
            }
            expect((await auth(request(ctx.app()).get(url(`/folders/${inbox.uid}?scope=admin`)), admin)).status).toBe(404);
        });
    });

    describe("An administrator managing a mailbox they hold no grant on", () => {
        it("Changes only its administrative settings, is answered with metadata, and leaves an audit entry naming the fields.", async () => {
            const { mailbox: m } = await mailbox();
            const before = (await audit("mailbox.admin-update", { mailboxUid: m.uid })).length;

            const put = await auth(request(ctx.app()).put(url(`/mailboxes/${m.uid}`)), admin).send({
                uid: m.uid,
                version: m.version,
                displayName: "Renamed by admin",
                quotaBytes: 5_000_000_000,
                oofMessage: "Hijacked",
                oofEnabled: true,
            });
            expect(put.status).toBe(200);
            expect(put.body).toMatchObject({ displayName: "Renamed by admin", quotaBytes: 5_000_000_000 });
            expect(put.body.oofMessage).toBeUndefined();
            const row = await stored(m.uid);
            expect([row.displayName, row.oofMessage, !!row.oofEnabled]).toEqual(["Renamed by admin", m.oofMessage, false]);
            const entries = await audit("mailbox.admin-update", { mailboxUid: m.uid });
            expect(entries.length).toBe(before + 1);
            expect(entries[entries.length - 1].details.fields.sort()).toEqual(["displayName", "quotaBytes"]);
        });

        it("Changes one administrative property, but not one of the owner's (403), and can move ownership.", async () => {
            const { mailbox: m, inbox } = await mailbox();
            const name = await auth(request(ctx.app()).put(url(`/mailboxes/${m.uid}/displayName`)), admin).send(JSON.stringify("By property")).set("Content-Type", "application/json");
            expect(name.status).toBe(200);
            expect(name.body.displayName).toBe("By property");
            const oof = await auth(request(ctx.app()).put(url(`/mailboxes/${m.uid}/oofMessage`)), admin).send(JSON.stringify("Hijacked")).set("Content-Type", "application/json");
            expect(oof.status).toBe(403);
            expect((await stored(m.uid)).oofMessage).toBe(m.oofMessage);

            // Ownership moves with its ACL grant: the new owner gets in, the old one no longer does - and the administrator never did.
            const successor = person();
            const moved = await auth(request(ctx.app()).put(url(`/mailboxes/${m.uid}/ownerUserUid`)), admin).send(JSON.stringify(successor.uid)).set("Content-Type", "application/json");
            expect(moved.status).toBe(200);
            expect((await auth(request(ctx.app()).get(url(`/mailboxes/${m.uid}`)), successor)).status).toBe(200);
            expect((await auth(request(ctx.app()).get(url(`/mailboxes/${m.uid}`)), owner)).status).toBe(404);
            expect((await auth(request(ctx.app()).get(url(`/mailboxes/${m.uid}`)), admin)).status).toBe(404);
            expect((await auth(request(ctx.app()).get(url(`/folders?mailboxUid=${m.uid}`)), admin)).body).toEqual([]);
            expect(inbox.uid).toBeDefined();
        });

        it("Changes several mailboxes in one bulk update, again to the administrative fields only, each audited.", async () => {
            const a = await mailbox();
            const b = await mailbox();
            const result = await auth(request(ctx.app()).put(url("/mailboxes")), admin).send([
                { uid: a.mailbox.uid, version: a.mailbox.version, displayName: "Bulk A", oofMessage: "no" },
                { uid: b.mailbox.uid, version: b.mailbox.version, displayName: "Bulk B" },
            ]);
            expect(result.status).toBe(200);
            expect(result.body.map((row: any) => row.displayName)).toEqual(["Bulk A", "Bulk B"]);
            expect(result.body.every((row: any) => row.oofMessage === undefined)).toBe(true);
            expect((await stored(a.mailbox.uid)).oofMessage).toBe(a.mailbox.oofMessage);
            expect((await audit("mailbox.admin-update", { mailboxUid: b.mailbox.uid })).length).toBe(1);
        });

        it("Answers the owner's own bulk update with the mailbox itself - the metadata is only for an administrator with no grant.", async () => {
            const { mailbox: m } = await mailbox();
            const result = await auth(request(ctx.app()).put(url("/mailboxes")), owner).send([{ uid: m.uid, version: m.version, oofMessage: "Back Monday" }]);
            expect(result.status).toBe(200);
            expect(result.body[0]).toMatchObject({ uid: m.uid, oofMessage: "Back Monday" });
            expect((await audit("mailbox.admin-update", { mailboxUid: m.uid })).length).toBe(0);
        });

        it("Does not store the computed accessRole a client echoes back - in a body, a bulk body or as a property (400).", async () => {
            const { mailbox: m } = await mailbox();
            const put = await auth(request(ctx.app()).put(url(`/mailboxes/${m.uid}`)), owner).send({ uid: m.uid, version: m.version, accessRole: "delegate", displayName: "Echo" });
            expect(put.status).toBe(200);
            expect(put.body.accessRole).toBeUndefined();
            const property = await auth(request(ctx.app()).put(url(`/mailboxes/${m.uid}/accessRole`)), owner).send(JSON.stringify("delegate")).set("Content-Type", "application/json");
            expect(property.status).toBe(400);
            const read = await auth(request(ctx.app()).get(url(`/mailboxes/${m.uid}`)), owner);
            expect(read.body).toMatchObject({ displayName: "Echo", accessRole: "owner" });
        });

        it("Deletes a mailbox, leaving an audit entry - and can't have a stranger do so (403).", async () => {
            const { mailbox: m } = await mailbox();
            expect((await auth(request(ctx.app()).delete(url(`/mailboxes/${m.uid}`)), stranger)).status).toBe(403);
            expect((await stored(m.uid))?.uid).toBe(m.uid);
            const result = await auth(request(ctx.app()).delete(url(`/mailboxes/${m.uid}`)), admin);
            expect(result.status).toBeLessThan(300);
            expect(await stored(m.uid)).toBeUndefined();
            expect((await audit("mailbox.admin-delete", { mailboxUid: m.uid })).length).toBe(1);
        });
    });

    describe("Sharing - the explicit, audited way an administrator reaches a mailbox", () => {
        const access = (uid: string, member: string = "") => url(`/mailboxes/${uid}/access${member ? `/${member}` : ""}`);

        it("Lets an administrator list a personal mailbox's members (audited) and revoke one - but never grant access to it (403).", async () => {
            const { mailbox: m } = await mailbox();
            const listed = await auth(request(ctx.app()).get(access(m.uid)), admin);
            expect(listed.status).toBe(200);
            expect(listed.body.map((member: any) => member.userOrRoleId)).toEqual([delegate.uid]);
            expect((await audit("mailbox_access.admin-list", { mailboxUid: m.uid })).length).toBe(1);

            for (const grantee of [admin.uid, stranger.uid]) {
                const grant = await auth(request(ctx.app()).put(access(m.uid, grantee)), admin).send({ role: "viewer" });
                expect(grant.status).toBe(403);
            }
            expect((await auth(request(ctx.app()).get(url(`/messages?folderUid=${(await ctx.store().find("Folder", { mailboxUid: m.uid }))[0].uid}`)), admin)).body).toEqual([]);

            const revoke = await auth(request(ctx.app()).delete(access(m.uid, delegate.uid)), admin);
            expect(revoke.status).toBe(204);
            expect((await audit("mailbox_access.revoke", { mailboxUid: m.uid })).length).toBe(1);
            expect((await auth(request(ctx.app()).get(url(`/mailboxes/${m.uid}`)), delegate)).status).toBe(404);
        });

        it("Is refused to an unelevated administrator (403 api-104) and an unrelated user (403), and answers 404 for an administrator only.", async () => {
            const { mailbox: m } = await mailbox();
            const unelevated = await auth(request(ctx.app()).get(access(m.uid)), unelevatedAdmin);
            expect([unelevated.status, unelevated.body.code]).toEqual([403, "api-104"]);
            expect((await auth(request(ctx.app()).get(access(m.uid)), stranger)).status).toBe(403);
            expect((await auth(request(ctx.app()).get(access(`${uuid.v4()}@example.com`)), stranger)).status).toBe(403);
            expect((await auth(request(ctx.app()).get(access(`${uuid.v4()}@example.com`)), admin)).status).toBe(404);
        });

        it("Lets an administrator add themselves to an OWNERLESS mailbox, which then is one of their own: listed, readable - and only theirs.", async () => {
            const { mailbox: m, inbox } = await mailbox(false);
            const before = await auth(request(ctx.app()).get(url("/mailboxes")), admin);
            expect(before.body.map((row: any) => row.uid)).not.toContain(m.uid);
            expect((await auth(request(ctx.app()).get(url(`/folders?mailboxUid=${m.uid}`)), admin)).body).toEqual([]);
            expect((await auth(request(ctx.app()).get(access(m.uid, "me")), admin)).body).toEqual({ canRead: false, canCreate: false, canUpdate: false, canDelete: false, canManage: false });

            const grant = await auth(request(ctx.app()).put(access(m.uid, admin.uid)), admin).send({ role: "manager" });
            expect(grant.status).toBe(200);
            expect((await audit("mailbox_access.grant", { mailboxUid: m.uid })).length).toBe(1);

            const after = await auth(request(ctx.app()).get(url("/mailboxes")), admin);
            expect(after.body.map((row: any) => row.uid)).toContain(m.uid);
            expect((await auth(request(ctx.app()).get(url(`/folders?mailboxUid=${m.uid}`)), admin)).body.map((f: any) => f.uid)).toContain(inbox.uid);
            expect((await auth(request(ctx.app()).get(access(m.uid, "me")), admin)).body).toMatchObject({ canRead: true, canManage: true });
            // ... and a stranger still can't add themselves to it.
            expect((await auth(request(ctx.app()).put(access(m.uid, stranger.uid)), stranger).send({ role: "viewer" })).status).toBe(403);
        });
    });

    describe("Quarantine and the ingest queue (administration scope, audited)", () => {
        it("Lets an administrator count, check, create and delete a mailbox's entries only with a trusted, elevated token - each call audited.", async () => {
            const { mailbox: m } = await mailbox();
            const entry = await ctx.store().save("QuarantineEntry", { mailboxUid: m.uid, reason: QuarantineReason.SPAM_POLICY, scanResultUid: uuid.v4(), rawBlobKey: "raw/x" });
            const base = url("/quarantine");

            expect(Number((await auth(request(ctx.app()).head(`${base}?mailboxUid=${m.uid}&scope=admin`), admin)).headers["content-length"])).toBe(1);
            expect((await auth(request(ctx.app()).head(`${base}?mailboxUid=${m.uid}`), admin)).headers["content-length"]).toBe("0");
            expect((await auth(request(ctx.app()).head(`${base}/${entry.uid}?scope=admin`), admin)).status).toBe(200);
            expect((await auth(request(ctx.app()).head(`${base}/${entry.uid}`), admin)).status).toBe(404);

            const created = await auth(request(ctx.app()).post(base), admin).send({ mailboxUid: m.uid, reason: QuarantineReason.SPAM_POLICY, scanResultUid: uuid.v4(), rawBlobKey: "raw/y" });
            expect(created.status).toBeLessThan(300);
            expect((await auth(request(ctx.app()).delete(`${base}/${created.body.uid}?purge=true`), admin)).status).toBeLessThan(300);
            // Without elevation the write is refused, and an ordinary user can't write at all.
            expect((await auth(request(ctx.app()).delete(`${base}/${entry.uid}?purge=true`), unelevatedAdmin)).status).toBe(403);
            expect((await auth(request(ctx.app()).delete(`${base}/${entry.uid}?purge=true`), owner)).status).toBe(403);
            expect((await ctx.store().find("QuarantineEntry", { uid: entry.uid })).length).toBe(1);

            const operations = (await audit("mail_queue.admin_access", { mailboxUid: m.uid })).map((e: any) => e.details.operation);
            expect(operations).toEqual(expect.arrayContaining(["count", "exists", "create", "delete"]));
        });
    });

    describe("Data export - the compliance workflow that is designed to cross mailboxes", () => {
        it("Lets a trusted caller request an export of any mailbox and download it; the download by somebody other than the owner is audited.", async () => {
            const { mailbox: m } = await mailbox();
            const requested = await auth(request(ctx.app()).post(url("/data-export-requests")), admin).send({ mailboxUid: m.uid, format: "json" });
            expect(requested.status).toBeLessThan(300);
            expect(requested.body.mailboxUid).toBe(m.uid);
            expect((await audit("data_export.requested", { mailboxUid: m.uid })).length).toBe(1);

            const blobKey: string = `exports/${uuid.v4()}`;
            await ctx.blobStore().put(blobKey, Buffer.from('{"exported":true}\n'));
            await ctx.store().update("DataExportRequest", requested.body.uid, { status: "ready", blobKey });
            const ownDownload = await auth(request(ctx.app()).get(url(`/data-export-requests/${requested.body.uid}/download`)), owner);
            expect(ownDownload.status).toBe(200);
            expect((await audit("data_export.downloaded", { mailboxUid: m.uid })).length).toBe(0);
            const adminDownload = await auth(request(ctx.app()).get(url(`/data-export-requests/${requested.body.uid}/download`)), admin);
            expect(adminDownload.status).toBe(200);
            const entries = await audit("data_export.downloaded", { mailboxUid: m.uid });
            expect(entries.map((e: any) => e.actorUserUid)).toEqual([admin.uid]);
        });
    });
}
