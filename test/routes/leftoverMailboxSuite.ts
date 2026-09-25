///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The data a deleted mailbox leaves behind, and an administrator erasing it - identical on both backends:
// `GET /mailboxes/leftover`, `POST /erasure-requests/leftover`, `DELETE /mailboxes/:id?erase=true`, the 409 on
// `POST /mailboxes` that names what to do, and `ErasureExecutionJob` finishing the job so the address can be used again.
// `test/routes/{mongo,sql}/LeftoverMailbox.test.ts` supply a started server, an `EntityStore` and a way to run the job.
import { request } from "@rapidrest/service-core/test";
import * as uuid from "uuid";
import { FolderType, MessageImportance, RecipientType } from "../../src/models/types.js";
import { LEFTOVER_LIMITS } from "../../src/util/LeftoverMailboxUtils.js";
import type { EntityStore } from "./entityStore.js";

export interface LeftoverMailboxSuiteContext {
    app: () => any;
    /** `"/mongo"` or `"/sql"`. */
    prefix: string;
    token: (user: any) => string;
    store: () => EntityStore;
    /** Runs `ErasureExecutionJob` once, against the server's own datastores. */
    runJob: () => Promise<void>;
    /** The `AccessControlList` at `uid`, if there is one. */
    findAcl: (uid: string) => Promise<any | undefined>;
}

export function leftoverMailboxSuite(ctx: LeftoverMailboxSuiteContext): void {
    const person = (roles: string[] = []): any => ({ uid: uuid.v4(), roles, scopes: [], elevated: Date.now() });
    const owner = person();
    const stranger = person();
    const admin = person(["admin"]);
    const unelevatedAdmin = { ...admin, elevated: undefined };
    const auth = (req: any, user: any) => req.set("Authorization", "jwt " + ctx.token(user));
    const url = (path: string) => `${ctx.prefix}${path}`;
    const store = () => ctx.store();
    const rows = async (kind: string, where: Record<string, any>): Promise<any[]> => await store().find(kind, where);

    /** Runs the job until it has nothing left (it takes one request per run). */
    const drain = async (): Promise<void> => {
        for (let i = 0; i < 5; i++) {
            await ctx.runJob();
        }
    };

    const newAddress = (label: string = "gone"): string => `${label}-${uuid.v4()}@example.com`;

    /** A mailbox created the way the console does (an administrator, through the API) - it gets its well-known folders. */
    const createMailbox = async (address: string, fields: Record<string, any> = {}): Promise<any> => {
        const created = await auth(request(ctx.app()).post(url("/mailboxes")), admin).send({
            primarySmtpAddress: address,
            aliasAddresses: [],
            displayName: "Old",
            timezone: "UTC",
            ownerUserUid: owner.uid,
            ...fields,
        });
        expect(created.status).toBe(200);
        return created.body;
    };

    const inboxOf = async (mailboxUid: string): Promise<any> => (await rows("Folder", { mailboxUid, type: FolderType.INBOX }))[0];

    const saveMessage = async (mailboxUid: string, folderUid: string, fields: Record<string, any> = {}): Promise<any> =>
        await store().save("Message", {
            mailboxUid,
            folderUid,
            messageId: `${uuid.v4()}@example.com`,
            subject: "Subject",
            from: { address: mailboxUid, type: RecipientType.TO },
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

    /** A deleted mailbox's remains, made without the routes: `folders` folders with ACLs parented to the uid, one message and one contact in the first. */
    const seedLeftover = async (mailboxUid: string, folders: number = 2): Promise<{ folderUids: string[]; messageUid: string; contactUid: string }> => {
        const folderUids: string[] = [];
        for (let i = 0; i < folders; i++) {
            const folder = await store().save("Folder", {
                mailboxUid,
                name: `Folder ${i}`,
                type: i === 0 ? FolderType.INBOX : FolderType.USER,
                unreadCount: 0,
                totalCount: 0,
                syncKeyVersion: 0,
            });
            await store().saveAcl(folder.uid, mailboxUid, []);
            folderUids.push(folder.uid);
        }
        const message = await saveMessage(mailboxUid, folderUids[0]);
        const contact = await store().save("Contact", { mailboxUid, folderUid: folderUids[0], displayName: "Orphan" });
        return { folderUids, messageUid: message.uid, contactUid: contact.uid };
    };

    const filed = async (mailboxUid: string): Promise<any[]> => await rows("DataSubjectErasureRequest", { mailboxUid });

    beforeEach(async () => {
        await store().clear("Folder", "Message", "Contact", "Mailbox", "DataSubjectErasureRequest", "Matter", "AuditLogEntry");
    });

    describe("The 409 on creating a mailbox at an address with leftover data", () => {
        it("Says what remains and, as a machine-readable reason, that erasing it is the way out.", async () => {
            const address = newAddress();
            const old = await createMailbox(address);
            expect((await auth(request(ctx.app()).delete(url(`/mailboxes/${old.uid}`)), admin)).status).toBeLessThan(300);

            const again = await auth(request(ctx.app()).post(url("/mailboxes")), admin).send({
                primarySmtpAddress: address,
                aliasAddresses: [],
                displayName: "New",
                timezone: "UTC",
            });

            expect(again.status).toBe(409);
            expect(again.body.reason).toBe("mailbox-data-remaining");
            expect(again.body.mailboxUid).toBe(address);
            expect(again.body.message).toMatch(/still has data from a deleted mailbox/);
        });

        it("Says the data is being erased, naming the request, while an approved erasure of the address has not finished - even once its folders are gone.", async () => {
            const address = newAddress();
            await store().save("DataSubjectErasureRequest", { mailboxUid: address, requestedByUserUid: admin.uid, status: "approved", leftoverOnly: true });
            const request1 = (await filed(address))[0];

            const again = await auth(request(ctx.app()).post(url("/mailboxes")), admin).send({
                primarySmtpAddress: address,
                aliasAddresses: [],
                displayName: "New",
                timezone: "UTC",
            });

            expect(again.status).toBe(409);
            expect(again.body.reason).toBe("mailbox-data-erasing");
            expect(again.body.erasure).toEqual({ uid: request1.uid, status: "approved" });
        });
    });

    describe("GET /mailboxes/leftover", () => {
        it("Is for a trusted AND elevated caller only.", async () => {
            const anonymous = await request(ctx.app()).get(url("/mailboxes/leftover"));
            expect([401, 403]).toContain(anonymous.status);
            const user = await auth(request(ctx.app()).get(url("/mailboxes/leftover")), stranger);
            expect([user.status, user.body.code]).toEqual([403, "api-103"]);
            const unelevated = await auth(request(ctx.app()).get(url("/mailboxes/leftover")), unelevatedAdmin);
            expect([unelevated.status, unelevated.body.code]).toEqual([403, "api-104"]);
        });

        it("Lists the mailbox uids that still have folders but no mailbox row - counts included, soft-deleted rows too - and leaves live mailboxes out.", async () => {
            const gone = newAddress("a-gone");
            const live = newAddress("b-live");
            const seeded = await seedLeftover(gone, 3);
            await store().update("Folder", seeded.folderUids[2], { deleted: true });
            await saveMessage(gone, seeded.folderUids[0], { deleted: true });
            await store().save("Mailbox", {
                uid: live,
                primarySmtpAddress: live,
                aliasAddresses: [],
                displayName: "Live",
                timezone: "UTC",
                quotaBytes: 1,
                usedBytes: 0,
            });
            await store().save("Folder", { mailboxUid: live, name: "Inbox", type: FolderType.INBOX, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 });

            const result = await auth(request(ctx.app()).get(url("/mailboxes/leftover")), admin);

            expect(result.status).toBe(200);
            expect(result.body.next).toBeUndefined();
            expect(result.body.items).toEqual([{ mailboxUid: gone, folderCount: 3, messageCount: 2 }]);
            const audited = await rows("AuditLogEntry", { action: "mailbox.admin-list" });
            expect(audited.some((entry) => entry.actorUserUid === admin.uid && entry.details?.leftover === true && entry.details?.count === 1)).toBe(true);
        });

        it("Shows the newest erasure request filed for each address.", async () => {
            const gone = newAddress();
            await seedLeftover(gone, 1);
            await store().save("DataSubjectErasureRequest", { mailboxUid: gone, requestedByUserUid: admin.uid, status: "denied", dateCreated: new Date("2020-01-01") });
            await store().save("DataSubjectErasureRequest", { mailboxUid: gone, requestedByUserUid: admin.uid, status: "approved" });

            const result = await auth(request(ctx.app()).get(url("/mailboxes/leftover")), admin);

            expect(result.body.items).toHaveLength(1);
            expect(result.body.items[0].erasure.status).toBe("approved");
            expect(typeof result.body.items[0].erasure.uid).toBe("string");
        });

        it("Pages by uid: ?limit= and ?after= continue where the last page ended, and a bad limit falls back to the default.", async () => {
            const uids = ["a", "b", "c"].map((prefix) => `${prefix}-${uuid.v4()}@example.com`);
            for (const uid of uids) {
                await seedLeftover(uid, 1);
            }

            const first = await auth(request(ctx.app()).get(url("/mailboxes/leftover?limit=2")), admin);
            expect(first.body.items.map((item: any) => item.mailboxUid)).toEqual([uids[0], uids[1]]);
            expect(first.body.next).toBe(uids[1]);

            const second = await auth(request(ctx.app()).get(url(`/mailboxes/leftover?limit=2&after=${encodeURIComponent(first.body.next)}`)), admin);
            expect(second.body.items.map((item: any) => item.mailboxUid)).toEqual([uids[2]]);
            expect(second.body.next).toBeUndefined();

            const bad = await auth(request(ctx.app()).get(url("/mailboxes/leftover?limit=nope&after=")), admin);
            expect(bad.body.items).toHaveLength(3);
            const huge = await auth(request(ctx.app()).get(url("/mailboxes/leftover?limit=100000")), admin);
            expect(huge.body.items).toHaveLength(3);
        });

        it("Reads a bounded number of uids per call and hands back a cursor when it stops before the end.", async () => {
            const originalPage = LEFTOVER_LIMITS.scanPageSize;
            const originalMax = LEFTOVER_LIMITS.maxScanned;
            try {
                const live = ["a", "b", "c"].map((prefix) => `${prefix}-${uuid.v4()}@example.com`);
                for (const uid of live) {
                    await store().save("Mailbox", { uid, primarySmtpAddress: uid, aliasAddresses: [], displayName: "Live", timezone: "UTC", quotaBytes: 1, usedBytes: 0 });
                    await store().save("Folder", { mailboxUid: uid, name: "Inbox", type: FolderType.INBOX, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 });
                }
                const gone = `d-${uuid.v4()}@example.com`;
                await seedLeftover(gone, 1);
                LEFTOVER_LIMITS.scanPageSize = 2;
                LEFTOVER_LIMITS.maxScanned = 2;

                const first = await auth(request(ctx.app()).get(url("/mailboxes/leftover")), admin);
                expect(first.body.items).toEqual([]);
                expect(first.body.next).toBe(live[1]);

                LEFTOVER_LIMITS.maxScanned = 5000;
                const rest = await auth(request(ctx.app()).get(url(`/mailboxes/leftover?after=${encodeURIComponent(first.body.next)}`)), admin);
                expect(rest.body.items.map((item: any) => item.mailboxUid)).toEqual([gone]);
                expect(rest.body.next).toBeUndefined();
            } finally {
                LEFTOVER_LIMITS.scanPageSize = originalPage;
                LEFTOVER_LIMITS.maxScanned = originalMax;
            }
        });
    });

    describe("POST /erasure-requests/leftover", () => {
        const post = (user: any, body: any) => auth(request(ctx.app()).post(url("/erasure-requests/leftover")), user).send(body);

        it("Is for a trusted AND elevated caller only.", async () => {
            const address = newAddress();
            await seedLeftover(address);
            expect((await request(ctx.app()).post(url("/erasure-requests/leftover")).send({ mailboxUid: address })).status).toBe(403);
            const user = await post(stranger, { mailboxUid: address });
            expect(user.status).toBe(403);
            const unelevated = await post(unelevatedAdmin, { mailboxUid: address });
            expect([unelevated.status, unelevated.body.code]).toEqual([403, "api-104"]);
            expect(await filed(address)).toEqual([]);
        });

        it("Refuses a missing or implausible mailbox uid (400).", async () => {
            for (const body of [undefined, {}, { mailboxUid: "" }, { mailboxUid: "   " }, { mailboxUid: 7 }, { mailboxUid: `${"a".repeat(400)}@example.com` }, { mailboxUid: "a\u0007b@example.com" }]) {
                const result = await post(admin, body ?? {});
                expect(result.status).toBe(400);
            }
        });

        it("Never erases an existing mailbox through this route (409 mailbox-exists), whatever data it has.", async () => {
            const address = newAddress();
            await createMailbox(address);

            const result = await post(admin, { mailboxUid: address });

            expect(result.status).toBe(409);
            expect(result.body.reason).toBe("mailbox-exists");
            expect(await filed(address)).toEqual([]);
            expect((await rows("Folder", { mailboxUid: address })).length).toBeGreaterThan(0);
        });

        it("Answers 404 when there is nothing left at the address.", async () => {
            const result = await post(admin, { mailboxUid: newAddress() });
            expect(result.status).toBe(404);
        });

        it("Is refused while a legal hold covers the address - nothing is filed, and the address stays taken.", async () => {
            const address = newAddress();
            await seedLeftover(address);
            await store().save("Matter", {
                name: "Hold",
                escrowScopeId: uuid.v4(),
                custodianMailboxUids: [address],
                dateRangeStart: new Date("2020-01-01"),
                dateRangeEnd: new Date("2035-01-01"),
            });

            const result = await post(admin, { mailboxUid: address });

            expect(result.status).toBe(409);
            expect(result.body.message).toMatch(/legal hold/);
            expect(await filed(address)).toEqual([]);
        });

        it("Files an approved request, audited as created and approved - and the same one again for a repeat, without a second.", async () => {
            const address = newAddress();
            await seedLeftover(address);

            const first = await post(admin, { mailboxUid: address.toUpperCase() });
            const second = await post(admin, { mailboxUid: ` ${address} ` });

            expect(first.status).toBeLessThan(300);
            expect(first.body).toMatchObject({ mailboxUid: address, status: "approved", leftoverOnly: true, requestedByUserUid: admin.uid, reviewedByUserUid: admin.uid });
            expect(second.body.uid).toBe(first.body.uid);
            expect(await filed(address)).toHaveLength(1);
            for (const action of ["erasure_request.created", "erasure_request.approved"]) {
                const entries = await rows("AuditLogEntry", { action, targetUid: first.body.uid });
                expect(entries).toHaveLength(1);
                expect(entries[0].details).toMatchObject({ leftover: true });
                expect(entries[0].actorUserUid).toBe(admin.uid);
            }
            // The administrator can read it back.
            const read = await auth(request(ctx.app()).get(url(`/erasure-requests/${first.body.uid}`)), admin);
            expect(read.status).toBe(200);
            expect(read.body.status).toBe("approved");
        });

        it("Approves a still-pending request for the address (a former owner's own) instead of adding a second.", async () => {
            const address = newAddress();
            await seedLeftover(address);
            const pending = await store().save("DataSubjectErasureRequest", { mailboxUid: address, requestedByUserUid: owner.uid, status: "pending" });

            const result = await post(admin, { mailboxUid: address });

            expect(result.body).toMatchObject({ uid: pending.uid, status: "approved", leftoverOnly: true, reviewedByUserUid: admin.uid });
            expect(await filed(address)).toHaveLength(1);
            expect(await rows("AuditLogEntry", { action: "erasure_request.approved", targetUid: pending.uid })).toHaveLength(1);
            expect(await rows("AuditLogEntry", { action: "erasure_request.created", targetUid: pending.uid })).toHaveLength(0);
        });

        it("Returns a request that is already running as it is.", async () => {
            const address = newAddress();
            await seedLeftover(address);
            const running = await store().save("DataSubjectErasureRequest", { mailboxUid: address, requestedByUserUid: admin.uid, status: "in_progress" });

            const result = await post(admin, { mailboxUid: address });

            expect(result.body.uid).toBe(running.uid);
            expect(result.body.status).toBe("in_progress");
            expect(await filed(address)).toHaveLength(1);
        });

        it("Erases everything under the exact uid - folders, content, their ACLs and the mailbox's own - and only that, then frees the address.", async () => {
            const address = newAddress("target");
            const old = await createMailbox(address);
            const inbox = await inboxOf(address);
            const message = await saveMessage(address, inbox.uid);
            const contact = await store().save("Contact", { mailboxUid: address, folderUid: inbox.uid, displayName: "Old contact" });
            await store().save("Label", { mailboxUid: address, name: "Old label" });
            const folderCount = (await rows("Folder", { mailboxUid: address })).length;
            expect(folderCount).toBeGreaterThan(1);
            expect(await ctx.findAcl(inbox.uid)).toBeDefined();
            // Neighbours a pattern or a prefix match would also take: same local part, another domain; a longer address; one with LIKE wildcards.
            const [local, domain] = address.split("@");
            const neighbours = [`${local}@example.org`, `x${local}@${domain}`, `${local}x@${domain}`, `${local.replace(/-/g, "_")}@${domain}`, `${local.slice(0, 6)}%@${domain}`];
            const neighbourFolders: string[] = [];
            for (const neighbour of neighbours) {
                const seeded = await seedLeftover(neighbour, 1);
                neighbourFolders.push(seeded.folderUids[0]);
            }
            const live = newAddress("live");
            const liveMailbox = await createMailbox(live);
            const liveInbox = await inboxOf(live);
            await saveMessage(live, liveInbox.uid);

            const deleted = await auth(request(ctx.app()).delete(url(`/mailboxes/${old.uid}`)), admin);
            expect(deleted.status).toBeLessThan(300);
            expect(deleted.headers["x-mailbox-data"]).toBe("kept");
            const queued = await post(admin, { mailboxUid: address });
            expect(queued.status).toBeLessThan(300);
            await drain();

            const done = (await filed(address))[0];
            expect(done.status).toBe("completed");
            expect(done.purgedCount).toBeGreaterThanOrEqual(folderCount + 3);
            expect(await rows("Folder", { mailboxUid: address })).toEqual([]);
            expect(await rows("Message", { uid: message.uid })).toEqual([]);
            expect(await rows("Contact", { uid: contact.uid })).toEqual([]);
            expect(await rows("Label", { mailboxUid: address })).toEqual([]);
            expect(await ctx.findAcl(inbox.uid)).toBeUndefined();
            expect(await ctx.findAcl(address)).toBeUndefined();
            expect((await rows("AuditLogEntry", { action: "erasure_request.completed", targetUid: done.uid })).length).toBe(1);
            // Only that uid.
            for (const neighbour of neighbours) {
                expect((await rows("Folder", { mailboxUid: neighbour })).length).toBe(1);
                expect((await rows("Message", { mailboxUid: neighbour })).length).toBe(1);
                expect((await rows("Contact", { mailboxUid: neighbour })).length).toBe(1);
            }
            expect(neighbourFolders.length).toBe(neighbours.length);
            expect((await rows("Message", { mailboxUid: live })).length).toBe(1);
            expect(await ctx.findAcl(liveMailbox.uid)).toBeDefined();
            // It no longer lists, and the address is free: a new mailbox gets its own folders, none of the old data.
            const list = await auth(request(ctx.app()).get(url("/mailboxes/leftover")), admin);
            expect(list.body.items.map((item: any) => item.mailboxUid)).not.toContain(address);
            const fresh = await createMailbox(address, { displayName: "New", ownerUserUid: stranger.uid });
            expect(fresh.ownerUserUid).toBe(stranger.uid);
            expect((await rows("Message", { mailboxUid: address })).length).toBe(0);
            const reused = await auth(request(ctx.app()).get(url(`/mailboxes/${address}`)), stranger);
            expect(reused.status).toBe(200);
            const oldOwner = await auth(request(ctx.app()).get(url(`/mailboxes/${address}`)), owner);
            expect(oldOwner.status).toBe(404);
        });

        it("Erases an address whose only remains are an access list, and frees it.", async () => {
            const address = newAddress();
            await store().saveAcl(address, "Mailbox", [{ userOrRoleId: owner.uid, actions: ["*"] }]);
            const blocked = await auth(request(ctx.app()).post(url("/mailboxes")), admin).send({ primarySmtpAddress: address, aliasAddresses: [], displayName: "x", timezone: "UTC" });
            expect(blocked.status).toBe(409);

            const queued = await post(admin, { mailboxUid: address });
            expect(queued.status).toBeLessThan(300);
            await drain();

            expect((await filed(address))[0].status).toBe("completed");
            expect(await ctx.findAcl(address)).toBeUndefined();
            await createMailbox(address);
        });
    });

    describe("DELETE /mailboxes/:id", () => {
        it("Says the data is kept (X-Mailbox-Data) when the mailbox is deleted, and files nothing.", async () => {
            const address = newAddress();
            const created = await createMailbox(address);

            const deleted = await auth(request(ctx.app()).delete(url(`/mailboxes/${created.uid}`)), admin);

            expect(deleted.status).toBeLessThan(300);
            expect(deleted.headers["x-mailbox-data"]).toBe("kept");
            expect(deleted.headers["x-erasure-request"]).toBeUndefined();
            expect(await filed(address)).toEqual([]);
        });

        it("Says nothing when the mailbox had no data.", async () => {
            const address = newAddress();
            await store().save("Mailbox", { uid: address, primarySmtpAddress: address, ownerUserUid: owner.uid, aliasAddresses: [], displayName: "Bare", timezone: "UTC", quotaBytes: 1, usedBytes: 0 });
            await store().saveAcl(address, "Mailbox", [{ userOrRoleId: admin.uid, actions: ["*"] }]);

            const deleted = await auth(request(ctx.app()).delete(url(`/mailboxes/${address}`)), admin);

            expect(deleted.status).toBeLessThan(300);
            expect(deleted.headers["x-mailbox-data"]).toBeUndefined();
        });

        it("Deletes and erases in one step with ?erase=true: the request is filed, approved and named in X-Erasure-Request, and the job finishes it.", async () => {
            const address = newAddress();
            const created = await createMailbox(address);
            const inbox = await inboxOf(address);
            const message = await saveMessage(address, inbox.uid);

            const deleted = await auth(request(ctx.app()).delete(url(`/mailboxes/${created.uid}?erase=true`)), admin);

            expect(deleted.status).toBeLessThan(300);
            expect(deleted.headers["x-mailbox-data"]).toBe("erasing");
            const [queued] = await filed(address);
            expect(deleted.headers["x-erasure-request"]).toBe(queued.uid);
            expect(queued).toMatchObject({ status: "approved", leftoverOnly: true, requestedByUserUid: admin.uid });
            expect(await rows("AuditLogEntry", { action: "mailbox.admin-delete", targetUid: address })).toHaveLength(1);

            await drain();

            expect((await filed(address))[0].status).toBe("completed");
            expect(await rows("Message", { uid: message.uid })).toEqual([]);
            expect(await rows("Folder", { mailboxUid: address })).toEqual([]);
            await createMailbox(address);
        });

        it("Refuses ?erase=true to anybody but an administrator (403) before deleting anything - the owner included.", async () => {
            const address = newAddress();
            const created = await createMailbox(address);

            const byOwner = await auth(request(ctx.app()).delete(url(`/mailboxes/${created.uid}?erase=true`)), owner);
            const unelevated = await auth(request(ctx.app()).delete(url(`/mailboxes/${created.uid}?erase=true`)), unelevatedAdmin);

            expect(byOwner.status).toBe(403);
            expect([unelevated.status, unelevated.body.code]).toEqual([403, "api-104"]);
            expect((await rows("Mailbox", { uid: address })).length).toBe(1);
            expect(await filed(address)).toEqual([]);
        });

        it("Lets an owner delete their own mailbox without ?erase - the data is kept, and the response says so.", async () => {
            const address = newAddress();
            const created = await createMailbox(address);

            const byOwner = await auth(request(ctx.app()).delete(url(`/mailboxes/${created.uid}`)), owner);

            expect(byOwner.status).toBeLessThan(300);
            expect(byOwner.headers["x-mailbox-data"]).toBe("kept");
        });

        it("Is blocked by a legal hold as before, with ?erase=true too - the mailbox stays.", async () => {
            const address = newAddress();
            const created = await createMailbox(address);
            await store().save("Matter", {
                name: "Hold",
                escrowScopeId: uuid.v4(),
                custodianMailboxUids: [address],
                dateRangeStart: new Date("2020-01-01"),
                dateRangeEnd: new Date("2035-01-01"),
            });

            const deleted = await auth(request(ctx.app()).delete(url(`/mailboxes/${created.uid}?erase=true`)), admin);

            expect(deleted.status).toBe(409);
            expect((await rows("Mailbox", { uid: address })).length).toBe(1);
            expect(await filed(address)).toEqual([]);
        });
    });
}
