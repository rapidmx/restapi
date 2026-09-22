///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Every mailbox has every well-known folder: created with the mailbox, healed on the next read of an older one, and every
// folder created (or renamed, or deleted) is announced on the mailbox's channel - identical on both backends.
// `test/routes/{mongo,sql}/WellKnownFolders.test.ts` supply a started server and raw row access. Real HTTP against a real
// database throughout; only the push publisher is observed (`NotificationUtils.sendMessage`).
import { request } from "@rapidrest/service-core/test";
import { NotificationUtils } from "@rapidrest/service-core";
import * as uuid from "uuid";
import { FolderType } from "../../src/models/types.js";
import { WELL_KNOWN_FOLDER_TYPES, wellKnownFolderUid } from "../../src/util/FolderUtils.js";

export interface WellKnownFoldersSuiteContext {
    app: () => any;
    foldersUrl: string;
    mailboxesUrl: string;
    ownerToken: string;
    ownerUid: string;
    /** A user with no access to the owner's mailbox. */
    strangerToken: string;
    /** A trusted (`admin`), elevated caller - who has no implicit access to anyone's mail. */
    adminToken: string;
    adminUid: string;
    /** A delegate given READ-only (`grants`) access to the mailboxes it is granted. */
    delegateToken: string;
    delegateUid: string;
    /** A mailbox row plus its ACL: owned by `ownerUid` (or ownerless when `undefined`), with `grants` for other users. */
    createMailbox: (ownerUid: string | undefined, grants?: Array<{ userUid: string; actions: string[] }>) => Promise<any>;
    /** A raw folder row and its ACL (parented to the mailbox). */
    createFolder: (mailboxUid: string, type: FolderType, name?: string) => Promise<any>;
    /** Every folder row of the mailbox, straight from the database (soft-deleted included). */
    foldersOf: (mailboxUid: string) => Promise<any[]>;
    /** `findOrCreateWellKnownFolder()` for `type`, as a job or route that needs that folder would call it. */
    findOrCreate: (mailboxUid: string, type: Exclude<FolderType, FolderType.USER>) => Promise<any>;
}

interface FolderEvent {
    channels: string[];
    type: string;
    action: string;
    data: any;
}

export function wellKnownFoldersSuite(ctx: WellKnownFoldersSuiteContext): void {
    const auth = (req: any, token: string = ctx.ownerToken) => req.set("Authorization", "jwt " + token);
    const listFolders = (mailboxUid: string, token?: string) => auth(request(ctx.app()).get(`${ctx.foldersUrl}?mailboxUid=${mailboxUid}`), token);
    const getFolder = (uid: string, token?: string) => auth(request(ctx.app()).get(`${ctx.foldersUrl}/${uid}`), token);
    const types = (folders: any[]): string[] => folders.map((folder) => folder.type).sort();
    const allTypes: string[] = [...WELL_KNOWN_FOLDER_TYPES].sort();

    let spy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        spy = vi.spyOn(NotificationUtils.prototype, "sendMessage");
    });
    afterEach(() => {
        spy.mockRestore();
    });
    /** Every folder event published so far (the count events and the message ones have other shapes/names). */
    const folderEvents = (action?: string): FolderEvent[] =>
        spy.mock.calls
            .map(([channels, type, act, data]: any[]) => ({ channels: ([] as string[]).concat(channels), type, action: act, data }))
            .filter((event) => /^Folder/.test(event.type) && (action === undefined || event.action === action));
    /** The events that announce a folder being created (`{ action: "create" }`), keyed by folder uid. */
    const createEvents = (): FolderEvent[] => folderEvents("create");

    it("lists the well-known types as the mail set plus calendar, contacts, tasks and notes", () => {
        expect([...WELL_KNOWN_FOLDER_TYPES]).toEqual([
            FolderType.INBOX,
            FolderType.DRAFTS,
            FolderType.OUTBOX,
            FolderType.SENT_ITEMS,
            FolderType.DELETED_ITEMS,
            FolderType.JUNK,
            FolderType.ARCHIVE,
            FolderType.CALENDAR,
            FolderType.CONTACTS,
            FolderType.TASKS,
            FolderType.NOTES,
        ]);
        expect(WELL_KNOWN_FOLDER_TYPES).not.toContain(FolderType.USER);
    });

    describe("creating a mailbox", () => {
        it("creates every well-known folder with it, each under its deterministic uid, and announces each once", async () => {
            const res = await auth(request(ctx.app()).post(ctx.mailboxesUrl), ctx.adminToken).send({
                ownerUserUid: ctx.ownerUid,
                primarySmtpAddress: `${uuid.v4()}@example.com`,
                aliasAddresses: [],
                displayName: "Fresh Mailbox",
                timezone: "UTC",
                quotaBytes: 1_000_000_000,
                usedBytes: 0,
            });
            expect(res.status).toBe(200);
            const mailboxUid: string = res.body.uid;

            // Straight from the database - a read through the route would heal the mailbox and prove nothing about creation.
            const folders = await ctx.foldersOf(mailboxUid);
            expect(types(folders)).toEqual(allTypes);
            for (const folder of folders) {
                expect(folder.uid).toBe(wellKnownFolderUid(mailboxUid, folder.type));
                expect(folder.mailboxUid).toBe(mailboxUid);
                expect(folder.name).toBeTruthy();
                expect(folder.unreadCount).toBe(0);
                expect(folder.totalCount).toBe(0);
            }
            const names = new Map(folders.map((folder: any) => [folder.type, folder.name]));
            expect(names.get(FolderType.OUTBOX)).toBe("Outbox");
            expect(names.get(FolderType.SENT_ITEMS)).toBe("Sent Items");
            expect(names.get(FolderType.DELETED_ITEMS)).toBe("Deleted Items");
            expect(names.get(FolderType.JUNK)).toBe("Junk Email");
            expect(names.get(FolderType.ARCHIVE)).toBe("Archive");

            const events = createEvents();
            expect(events).toHaveLength(folders.length);
            expect(new Set(events.map((event) => event.data.uid))).toEqual(new Set(folders.map((folder: any) => folder.uid)));
            for (const event of events) {
                expect(event.type).toMatch(/^Folder(Mongo|SQL)$/);
                expect(event.channels).toEqual(expect.arrayContaining([event.data.uid, mailboxUid]));
                expect(event.data).toEqual(
                    expect.objectContaining({ mailboxUid, type: expect.any(String), name: expect.any(String), unreadCount: 0, totalCount: 0 }),
                );
            }
        });

        it("creates them for a shared (ownerless) mailbox an administrator makes, and its creator - not the administrator's role - reads them", async () => {
            const res = await auth(request(ctx.app()).post(ctx.mailboxesUrl), ctx.adminToken).send({
                primarySmtpAddress: `${uuid.v4()}@example.com`,
                aliasAddresses: [],
                displayName: "Shared Mailbox",
                timezone: "UTC",
                quotaBytes: 1_000_000_000,
                usedBytes: 0,
            });
            expect(res.status).toBe(200);

            expect(types(await ctx.foldersOf(res.body.uid))).toEqual(allTypes);
            // The administrator was granted the mailbox explicitly (`grantCreator()`), so it lists the whole set.
            expect(types((await listFolders(res.body.uid, ctx.adminToken)).body)).toEqual(allTypes);
        });
    });

    describe("healing on read", () => {
        it("gives a mailbox that has only some of them the rest when its folders are listed, keeping the ones it has", async () => {
            const mailbox = await ctx.createMailbox(ctx.ownerUid);
            const inbox = await ctx.createFolder(mailbox.uid, FolderType.INBOX);
            const drafts = await ctx.createFolder(mailbox.uid, FolderType.DRAFTS);
            const mine = await ctx.createFolder(mailbox.uid, FolderType.USER, "Projects");

            const res = await listFolders(mailbox.uid);

            expect(res.status).toBe(200);
            expect(types(res.body)).toEqual([...allTypes, FolderType.USER].sort());
            const byType = new Map<string, any>(res.body.map((folder: any) => [folder.type, folder]));
            expect(byType.get(FolderType.INBOX).uid).toBe(inbox.uid);
            expect(byType.get(FolderType.DRAFTS).uid).toBe(drafts.uid);
            expect(byType.get(FolderType.USER).uid).toBe(mine.uid);
            expect(byType.get(FolderType.OUTBOX).uid).toBe(wellKnownFolderUid(mailbox.uid, FolderType.OUTBOX));
            expect(byType.get(FolderType.SENT_ITEMS).name).toBe("Sent Items");
            expect(await ctx.foldersOf(mailbox.uid)).toHaveLength(12);

            // One `create` event per folder the read created (nine), none for the two that existed or the user's own.
            const events = createEvents();
            expect(events).toHaveLength(9);
            expect(events.map((event) => event.data.type).sort()).toEqual(
                allTypes.filter((type) => type !== FolderType.INBOX && type !== FolderType.DRAFTS),
            );
            for (const event of events) {
                expect(event.channels).toEqual(expect.arrayContaining([event.data.uid, mailbox.uid]));
            }
        });

        it("heals the mailbox behind GET /folders/:id too, and answers the folder itself", async () => {
            const mailbox = await ctx.createMailbox(ctx.ownerUid);
            const inbox = await ctx.createFolder(mailbox.uid, FolderType.INBOX);

            const res = await getFolder(inbox.uid);

            expect(res.status).toBe(200);
            expect(res.body.uid).toBe(inbox.uid);
            expect(types(await ctx.foldersOf(mailbox.uid))).toEqual(allTypes);
            expect(createEvents()).toHaveLength(10);
        });

        it("writes nothing and publishes nothing when the set is already complete", async () => {
            const mailbox = await ctx.createMailbox(ctx.ownerUid);
            await listFolders(mailbox.uid);
            expect(await ctx.foldersOf(mailbox.uid)).toHaveLength(11);
            const before = (await ctx.foldersOf(mailbox.uid)).map((folder) => `${folder.uid}:${folder.version}`).sort();
            spy.mockClear();

            const again = await listFolders(mailbox.uid);
            const byId = await getFolder(again.body[0].uid);

            expect(again.body).toHaveLength(11);
            expect(byId.status).toBe(200);
            expect(createEvents()).toEqual([]);
            expect((await ctx.foldersOf(mailbox.uid)).map((folder) => `${folder.uid}:${folder.version}`).sort()).toEqual(before);
        });

        it("ends with exactly one folder of each type, and one create event each, when the same mailbox is read concurrently", async () => {
            const mailbox = await ctx.createMailbox(ctx.ownerUid);

            const results = await Promise.all(Array.from({ length: 6 }, () => listFolders(mailbox.uid)));

            for (const res of results) {
                expect(res.status).toBe(200);
                expect(types(res.body)).toEqual(allTypes);
            }
            const folders = await ctx.foldersOf(mailbox.uid);
            expect(types(folders)).toEqual(allTypes);
            expect(new Set(folders.map((folder) => folder.uid)).size).toBe(11);
            // Whoever lost the race for a folder's uid published nothing for it.
            const events = createEvents();
            expect(events).toHaveLength(11);
            expect(new Set(events.map((event) => event.data.uid)).size).toBe(11);
        });

        it("heals a shared mailbox for a delegate who may list it, without granting the delegate anything on the new folders", async () => {
            const mailbox = await ctx.createMailbox(undefined, [{ userUid: ctx.delegateUid, actions: ["read", "list"] }]);
            await ctx.createFolder(mailbox.uid, FolderType.INBOX);

            const res = await listFolders(mailbox.uid, ctx.delegateToken);

            expect(res.status).toBe(200);
            expect(types(res.body)).toEqual(allTypes);
            expect(types(await ctx.foldersOf(mailbox.uid))).toEqual(allTypes);
            // Healing on read is server-side structure, not the delegate's write: they hold no more on a folder than the mailbox gives.
            const outbox = res.body.find((folder: any) => folder.type === FolderType.OUTBOX);
            const rename = await auth(request(ctx.app()).put(`${ctx.foldersUrl}/${outbox.uid}`), ctx.delegateToken).send({
                uid: outbox.uid,
                version: outbox.version,
                name: "Mine now",
            });
            expect(rename.status).toBe(403);
        });

        it("provisions nothing for a caller with no access to the mailbox, whether they list it or read one of its folders", async () => {
            const mailbox = await ctx.createMailbox(ctx.ownerUid);
            const inbox = await ctx.createFolder(mailbox.uid, FolderType.INBOX);

            const list = await listFolders(mailbox.uid, ctx.strangerToken);
            const byId = await getFolder(inbox.uid, ctx.strangerToken);

            expect(list.status).toBe(200);
            expect(list.body).toEqual([]);
            expect(byId.status).toBe(404);
            expect(await ctx.foldersOf(mailbox.uid)).toHaveLength(1);
            expect(createEvents()).toEqual([]);
        });

        it("provisions nothing for a trusted, elevated administrator with no grant on the mailbox either", async () => {
            const mailbox = await ctx.createMailbox(ctx.ownerUid);
            const inbox = await ctx.createFolder(mailbox.uid, FolderType.INBOX);

            const list = await listFolders(mailbox.uid, ctx.adminToken);
            const byId = await getFolder(inbox.uid, ctx.adminToken);

            expect(list.body).toEqual([]);
            expect(byId.status).toBe(404);
            expect(await ctx.foldersOf(mailbox.uid)).toHaveLength(1);
            expect(createEvents()).toEqual([]);
        });

        it("provisions nothing for a mailbox that doesn't exist", async () => {
            const missing = `${uuid.v4()}@example.com`;

            const list = await listFolders(missing);

            expect(list.body).toEqual([]);
            expect(await ctx.foldersOf(missing)).toEqual([]);
        });
    });

    describe("announcing folders", () => {
        it("announces a well-known folder created lazily (at first send, a first junk delivery, ...) on the mailbox's channel", async () => {
            const mailbox = await ctx.createMailbox(ctx.ownerUid);

            const outbox = await ctx.findOrCreate(mailbox.uid, FolderType.OUTBOX);
            const again = await ctx.findOrCreate(mailbox.uid, FolderType.OUTBOX);

            expect(again.uid).toBe(outbox.uid);
            const events = createEvents();
            expect(events).toHaveLength(1);
            expect(events[0].channels).toEqual([outbox.uid, mailbox.uid]);
            expect(events[0].data).toEqual(
                expect.objectContaining({ uid: outbox.uid, mailboxUid: mailbox.uid, type: FolderType.OUTBOX, name: "Outbox", unreadCount: 0, totalCount: 0 }),
            );
        });

        it("announces a folder a client creates on both the mailbox's channel and the folder's own", async () => {
            const mailbox = await ctx.createMailbox(ctx.ownerUid);

            const res = await auth(request(ctx.app()).post(ctx.foldersUrl)).send({
                mailboxUid: mailbox.uid,
                name: "Receipts",
                type: FolderType.USER,
            });

            expect(res.status).toBe(200);
            const channels = createEvents().flatMap((event) => event.channels);
            expect(channels).toEqual(expect.arrayContaining([mailbox.uid, res.body.uid]));
            expect(createEvents().every((event) => event.data.uid === res.body.uid && event.data.name === "Receipts")).toBe(true);
        });

        it("announces a rename with the whole folder on the mailbox's channel", async () => {
            const mailbox = await ctx.createMailbox(ctx.ownerUid);
            const folder = await ctx.createFolder(mailbox.uid, FolderType.USER, "Old name");

            const res = await auth(request(ctx.app()).put(`${ctx.foldersUrl}/${folder.uid}`)).send({
                uid: folder.uid,
                version: folder.version,
                name: "New name",
            });

            expect(res.status).toBe(200);
            const renamed = folderEvents("update").filter((event) => event.channels.includes(mailbox.uid));
            expect(renamed).toHaveLength(1);
            expect(renamed[0].type).toMatch(/^Folder(Mongo|SQL)$/);
            expect(renamed[0].data).toEqual(
                expect.objectContaining({ uid: folder.uid, mailboxUid: mailbox.uid, type: FolderType.USER, name: "New name" }),
            );
        });

        it("announces a rename made through the bulk and the single-property updates the same way", async () => {
            const mailbox = await ctx.createMailbox(ctx.ownerUid);
            const first = await ctx.createFolder(mailbox.uid, FolderType.USER, "First");
            const second = await ctx.createFolder(mailbox.uid, FolderType.USER, "Second");

            const bulk = await auth(request(ctx.app()).put(ctx.foldersUrl)).send([
                { uid: first.uid, version: first.version, name: "First!" },
            ]);
            expect(bulk.status).toBe(200);
            const property = await auth(request(ctx.app()).put(`${ctx.foldersUrl}/${second.uid}/name`))
                .set("Content-Type", "application/json")
                .send(JSON.stringify("Second!"));
            expect(property.status).toBe(200);

            const seen = folderEvents("update")
                .filter((event) => event.channels.includes(mailbox.uid))
                .map((event) => `${event.data.uid}:${event.data.name}`)
                .sort();
            expect(seen).toEqual([`${first.uid}:First!`, `${second.uid}:Second!`].sort());
        });

        it("announces a deletion on the mailbox's channel with the folder's uid and mailbox", async () => {
            const mailbox = await ctx.createMailbox(ctx.ownerUid);
            const folder = await ctx.createFolder(mailbox.uid, FolderType.USER, "Doomed");

            const res = await auth(request(ctx.app()).delete(`${ctx.foldersUrl}/${folder.uid}`));

            expect(res.status).toBe(204);
            const deleted = folderEvents("delete").filter((event) => event.channels.includes(mailbox.uid));
            expect(deleted).toHaveLength(1);
            expect(deleted[0].data).toEqual(expect.objectContaining({ uid: folder.uid, mailboxUid: mailbox.uid }));
        });

        it("announces nothing for a deletion that is refused", async () => {
            const mailbox = await ctx.createMailbox(ctx.ownerUid);
            const folder = await ctx.createFolder(mailbox.uid, FolderType.USER, "Not yours");

            const res = await auth(request(ctx.app()).delete(`${ctx.foldersUrl}/${folder.uid}`), ctx.strangerToken);

            expect(res.status).toBeGreaterThanOrEqual(400);
            expect(folderEvents("delete").filter((event) => event.channels.includes(mailbox.uid))).toEqual([]);
        });

        it("announces nothing for a deletion of a folder that doesn't exist", async () => {
            const res = await auth(request(ctx.app()).delete(`${ctx.foldersUrl}/${uuid.v4()}`));

            expect(res.status).toBe(404);
            expect(folderEvents("delete")).toEqual([]);
        });
    });
}
