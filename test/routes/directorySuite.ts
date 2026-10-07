///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `GET /mail/directory`, `GET /mail/directory/contacts` and `GET /mail/directory/correspondents` (recipient suggestions),
// identical on both backends.
// `test/routes/{mongo,sql}/DirectoryRoute.test.ts` supply a started server and raw row helpers.
import { request } from "@rapidrest/service-core/test";
import { ACLAction } from "@rapidrest/service-core";
import { JWTUtils } from "@rapidrest/core";
import * as uuid from "uuid";
import { DIRECTORY_MAX_ATTEMPTS, DIRECTORY_MAX_LIMIT } from "../../src/routes/BaseDirectoryRoute.js";
import { ContactAddressKind, FolderType } from "../../src/models/types.js";

type AclRecords = { userOrRoleId: string; actions: string[] }[];

export interface DirectorySuiteContext {
    config: any;
    app: () => any;
    baseUrl: string;
    /** Saves a mailbox with `fields` over defaults (owned by no one unless `ownerUserUid` is given) and an ACL carrying
     * `records` (plus full access for its owner). */
    saveMailbox: (fields: Record<string, any>, records?: AclRecords) => Promise<any>;
    saveList: (fields: Record<string, any>) => Promise<any>;
    /** Saves a folder with an ACL under its mailbox carrying `records`. */
    saveFolder: (fields: Record<string, any>, records?: AclRecords) => Promise<any>;
    saveContact: (fields: Record<string, any>) => Promise<any>;
    saveErasureRequest: (mailboxUid: string, status: string) => Promise<void>;
    saveCorrespondent: (fields: Record<string, any>) => Promise<any>;
    saveMessage: (fields: Record<string, any>) => Promise<any>;
    saveCalendarEvent: (fields: Record<string, any>) => Promise<any>;
    /** Every stored `Correspondent` of `mailboxUid`. */
    findCorrespondents: (mailboxUid: string) => Promise<any[]>;
    /** Every stored `Contact` of `mailboxUid`, deleted ones included. */
    findContacts: (mailboxUid: string) => Promise<any[]>;
    /** Every stored `Folder` of `mailboxUid`. */
    findFolders: (mailboxUid: string) => Promise<any[]>;
    /** Deletes the stored `Mailbox` row `uid` (its ACL stays). */
    removeMailbox: (uid: string) => Promise<void>;
    /** Deletes the stored `Contact` `uid` outright. */
    removeContact: (uid: string) => Promise<void>;
    /** The stored `Mailbox` `uid`. */
    findMailbox: (uid: string) => Promise<any>;
}

export function directorySuite(ctx: DirectorySuiteContext): void {
    const newUser = (roles: string[] = []): any => ({ uid: uuid.v4(), roles, elevated: Date.now() });
    const tokenFor = (user: any): string => JWTUtils.createTokenSync(ctx.config.get("auth"), user);
    const get = (path: string, user?: any) => {
        const req: any = request(ctx.app()).get(`${ctx.baseUrl}${path}`);
        return user ? req.set("Authorization", "jwt " + tokenFor(user)) : req;
    };
    const search = (q: string, user: any, extra: string = "") => get(`?q=${encodeURIComponent(q)}${extra}`, user);
    const searchContacts = (q: string, user: any, extra: string = "") => get(`/contacts?q=${encodeURIComponent(q)}${extra}`, user);
    const searchCorrespondents = (q: string, user: any, extra: string = "") => get(`/correspondents?q=${encodeURIComponent(q)}${extra}`, user);
    const addresses = (body: any[]): string[] => body.map((entry) => entry.address);

    const mailboxFor = async (owner: any, fields: Record<string, any> = {}, records: AclRecords = []) =>
        await ctx.saveMailbox({ ownerUserUid: owner.uid, displayName: "Owner Mailbox", primarySmtpAddress: `${uuid.v4()}@owners.test`, ...fields }, records);

    describe("GET / (server directory)", () => {
        const caller: any = newUser();
        const tag: string = uuid.v4().slice(0, 8);

        /** Seeds a small directory whose addresses carry `tag`, so rows other tests left behind never match. */
        const seed = async () => {
            await mailboxFor(caller);
            await ctx.saveMailbox({ ownerUserUid: uuid.v4(), displayName: "Alice Johnson", primarySmtpAddress: `alice.${tag}@example.com` });
            await ctx.saveMailbox({ ownerUserUid: uuid.v4(), displayName: "Jean-Philippe Steinmetz", primarySmtpAddress: `jp.${tag}@example.com` });
            await ctx.saveMailbox({ displayName: "Support Desk", primarySmtpAddress: `support.${tag}@example.com` });
            await ctx.saveMailbox({ displayName: "Board Room", primarySmtpAddress: `boardroom.${tag}@example.com`, isResource: true, resourceType: "room" });
            await ctx.saveMailbox({ displayName: "Beamer", primarySmtpAddress: `beamer.${tag}@example.com`, isResource: true, resourceType: "equipment" });
            await ctx.saveMailbox({ displayName: "Resource Without Type", primarySmtpAddress: `resource.${tag}@example.com`, isResource: true });
            await ctx.saveList({ name: "Sales Team", primarySmtpAddress: `sales.${tag}@example.com` });
            await ctx.saveList({ name: "Old List", primarySmtpAddress: `oldlist.${tag}@example.com`, deleted: true });
        };

        it("requires a signed-in caller", async () => {
            expect((await get("?q=alice")).status).toBe(401);
        });

        it("refuses a caller with no mailbox on this server, but not a trusted one", async () => {
            await seed();
            const res = await search("alice", newUser());
            expect(res.status).toBe(403);
            const admin = await search(`alice.${tag}`, newUser(["admin"]));
            expect(admin.status).toBe(200);
            expect(addresses(admin.body)).toEqual([`alice.${tag}@example.com`]);
        });

        it("refuses a missing, repeated, too short or too long query and a bad limit", async () => {
            await mailboxFor(caller);
            expect((await get("", caller)).status).toBe(400);
            expect((await get("?q=ab&q=cd", caller)).status).toBe(400);
            expect((await search("a", caller)).status).toBe(400);
            expect((await search("  a  ", caller)).status).toBe(400);
            expect((await search("a".repeat(101), caller)).status).toBe(400);
            for (const limit of ["abc", "0", "-1", "1.5"]) {
                expect((await search("alice", caller, `&limit=${limit}`)).status).toBe(400);
            }
        });

        it("matches name word prefixes and address prefixes case-insensitively, returning only name, address and kind", async () => {
            await seed();
            const byName = await search("ALI", caller);
            expect(byName.status).toBe(200);
            expect(byName.body).toEqual([{ displayName: "Alice Johnson", address: `alice.${tag}@example.com`, kind: "user" }]);
            expect(Object.keys(byName.body[0]).sort()).toEqual(["address", "displayName", "kind"]);

            expect(addresses((await search("johns", caller)).body)).toEqual([`alice.${tag}@example.com`]);
            expect(addresses((await search("phil", caller)).body)).toEqual([`jp.${tag}@example.com`]);
            expect(addresses((await search("alice john", caller)).body)).toEqual([`alice.${tag}@example.com`]);
            expect((await search("alice smith", caller)).body).toEqual([]);
            // Not a word prefix ("Alice", "Sales").
            expect((await search("lice", caller)).body).toEqual([]);
            expect(addresses((await search(`jp.${tag}@exa`, caller)).body)).toEqual([`jp.${tag}@example.com`]);
            // A domain isn't a prefix of the address.
            expect((await search("example.com", caller)).body).toEqual([]);
        });

        it("names each kind of entry and leaves out deleted lists and mailboxes being erased", async () => {
            await seed();
            const erased = await ctx.saveMailbox({ ownerUserUid: uuid.v4(), displayName: "Erased Approved", primarySmtpAddress: `erased1.${tag}@example.com` });
            await ctx.saveErasureRequest(erased.uid, "approved");
            const running = await ctx.saveMailbox({ ownerUserUid: uuid.v4(), displayName: "Erased Running", primarySmtpAddress: `erased2.${tag}@example.com` });
            await ctx.saveErasureRequest(running.uid, "in_progress");
            const pending = await ctx.saveMailbox({ ownerUserUid: uuid.v4(), displayName: "Erased Pending", primarySmtpAddress: `erased3.${tag}@example.com` });
            await ctx.saveErasureRequest(pending.uid, "pending");

            const kinds = async (q: string) => (await search(q, caller, "&limit=20")).body.map((entry: any) => `${entry.address.split(".")[0]}:${entry.kind}`);
            expect(await kinds("support")).toEqual(["support:shared"]);
            expect(await kinds("board")).toEqual(["boardroom:room"]);
            expect(await kinds("beamer")).toEqual(["beamer:equipment"]);
            expect(await kinds("resource")).toEqual(["resource:room"]);
            expect(await kinds("sales")).toEqual(["sales:list"]);
            expect(await kinds("old")).toEqual([]);
            expect(await kinds("erased")).toEqual(["erased3:user"]);
        });

        it("matches query text literally, never as a pattern", async () => {
            await mailboxFor(caller);
            await ctx.saveMailbox({ ownerUserUid: uuid.v4(), displayName: "100% Club", primarySmtpAddress: `club.${tag}@example.com` });
            await ctx.saveMailbox({ ownerUserUid: uuid.v4(), displayName: "Axe Person", primarySmtpAddress: `axe.${tag}@example.com` });
            await ctx.saveMailbox({ ownerUserUid: uuid.v4(), displayName: "a_x Literal", primarySmtpAddress: `lit.${tag}@example.com` });
            expect(addresses((await search("100%", caller)).body)).toEqual([`club.${tag}@example.com`]);
            expect((await search("10%", caller)).body).toEqual([]);
            expect(addresses((await search("a_x", caller)).body)).toEqual([`lit.${tag}@example.com`]);
            for (const q of [".*", "%%", "__", "like(*)", "regex(.*)", "(a+)+$", "[a-z]*", "\\\\", "a\"b", "$ne"]) {
                const res = await search(q, caller);
                expect(res.status).toBe(200);
                expect(res.body).toEqual([]);
            }
        });

        it("defaults to 8 entries, caps the limit and ranks entries starting with the query first", async () => {
            await mailboxFor(caller);
            for (let i = 0; i < 25; i++) {
                await ctx.saveMailbox({ ownerUserUid: uuid.v4(), displayName: `Zed Tester${tag} ${String(i).padStart(2, "0")}`, primarySmtpAddress: `t${i}.${tag}@example.com` });
            }
            expect((await search(`tester${tag}`, caller)).body).toHaveLength(8);
            expect((await search(`tester${tag}`, caller, "&limit=3")).body).toHaveLength(3);
            expect((await search(`tester${tag}`, caller, "&limit=500")).body).toHaveLength(DIRECTORY_MAX_LIMIT);

            await ctx.saveMailbox({ ownerUserUid: uuid.v4(), displayName: `Bob Jo${tag}`, primarySmtpAddress: `bob.${tag}@example.com` });
            await ctx.saveMailbox({ ownerUserUid: uuid.v4(), displayName: `Jo${tag} Zimmer`, primarySmtpAddress: `zim.${tag}@example.com` });
            expect(addresses((await search(`jo${tag}`, caller)).body)).toEqual([`zim.${tag}@example.com`, `bob.${tag}@example.com`]);
        });

        it(`limits each caller to ${DIRECTORY_MAX_ATTEMPTS} searches a minute`, async () => {
            const admin: any = newUser(["admin"]);
            const statuses: number[] = [];
            for (let i = 0; i <= DIRECTORY_MAX_ATTEMPTS; i++) {
                statuses.push((await search("nobody-here", admin)).status);
            }
            expect(statuses.slice(0, DIRECTORY_MAX_ATTEMPTS).every((status) => status === 200)).toBe(true);
            expect(statuses[DIRECTORY_MAX_ATTEMPTS]).toBe(429);
        });
    });

    describe("GET /contacts (the caller's contacts)", () => {
        const owner: any = newUser();
        const email = (address: string) => ({ address, type: ContactAddressKind.WORK });

        const contactsFolder = async (mailboxUid: string, records: AclRecords = [], fields: Record<string, any> = {}) =>
            await ctx.saveFolder({ mailboxUid, name: "Contacts", type: FolderType.CONTACTS, ...fields }, records);
        const contact = async (folder: any, fields: Record<string, any>) =>
            await ctx.saveContact({ mailboxUid: folder.mailboxUid, folderUid: folder.uid, emails: [], phones: [], addresses: [], displayName: "", ...fields });

        it("requires a signed-in caller and validates the query", async () => {
            expect((await get("/contacts?q=carol")).status).toBe(401);
            expect((await searchContacts("c", owner)).status).toBe(400);
            expect((await searchContacts("carol", owner, "&limit=x")).status).toBe(400);
        });

        it("returns every address of a contact whose name matches, or just the addresses that match", async () => {
            const mailbox = await mailboxFor(owner);
            const folder = await contactsFolder(mailbox.uid);
            await contact(folder, { displayName: "Carol Danvers", emails: [email("carol@marvel.test"), email("cdanvers@home.test")], notes: "secret" });
            await contact(folder, { displayName: "", givenName: "Peter", surname: "Parker", emails: [email("spidey@marvel.test")] });
            await contact(folder, { displayName: "No Address" });

            const byName = await searchContacts("carol", owner);
            expect(byName.status).toBe(200);
            expect(byName.body).toEqual([
                { displayName: "Carol Danvers", address: "carol@marvel.test", kind: "contact" },
                { displayName: "Carol Danvers", address: "cdanvers@home.test", kind: "contact" },
            ]);
            expect(addresses((await searchContacts("CDAN", owner)).body)).toEqual(["cdanvers@home.test"]);
            expect((await searchContacts("park", owner)).body).toEqual([{ displayName: "Peter Parker", address: "spidey@marvel.test", kind: "contact" }]);
            expect(addresses((await searchContacts("peter spid", owner)).body)).toEqual(["spidey@marvel.test"]);
            expect((await searchContacts("no address", owner)).body).toEqual([]);
            expect((await searchContacts("marvel", owner)).body).toEqual([]);
        });

        it("only searches readable, undeleted contacts folders of the caller's mailboxes and a readable mailboxUid", async () => {
            const mailbox = await mailboxFor(owner);
            const folder = await contactsFolder(mailbox.uid);
            await contact(folder, { displayName: "Kept Contact", emails: [email("kept@contacts.test")] });
            await contact(folder, { displayName: "Kept Deleted", emails: [email("keptdeleted@contacts.test")], deleted: true });
            const deletedFolder = await contactsFolder(mailbox.uid, [], { deleted: true });
            await contact(deletedFolder, { displayName: "Kept In Deleted Folder", emails: [email("keptfolder@contacts.test")] });
            const inbox = await ctx.saveFolder({ mailboxUid: mailbox.uid, name: "Inbox", type: FolderType.INBOX });
            await contact(inbox, { displayName: "Kept In Inbox", emails: [email("keptinbox@contacts.test")] });
            const denied = await contactsFolder(mailbox.uid, [{ userOrRoleId: owner.uid, actions: [] }]);
            await contact(denied, { displayName: "Kept Denied", emails: [email("keptdenied@contacts.test")] });

            const someoneElse: any = newUser();
            const shared = await mailboxFor(someoneElse, { displayName: "Shared" }, [{ userOrRoleId: owner.uid, actions: [ACLAction.READ] }]);
            const sharedFolder = await contactsFolder(shared.uid);
            await contact(sharedFolder, { displayName: "Kept Shared", emails: [email("keptshared@contacts.test")] });
            const privateMailbox = await mailboxFor(someoneElse, { displayName: "Private" });
            const privateFolder = await contactsFolder(privateMailbox.uid);
            await contact(privateFolder, { displayName: "Kept Private", emails: [email("keptprivate@contacts.test")] });

            expect(addresses((await searchContacts("kept", owner, "&limit=20")).body)).toEqual(["kept@contacts.test"]);
            expect(addresses((await searchContacts("kept", owner, `&limit=20&mailboxUid=${shared.uid}`)).body)).toEqual([
                "kept@contacts.test",
                "keptshared@contacts.test",
            ]);
            expect(addresses((await searchContacts("kept", owner, `&limit=20&mailboxUid=${privateMailbox.uid}`)).body)).toEqual(["kept@contacts.test"]);
            expect(addresses((await searchContacts("kept", owner, `&limit=20&mailboxUid=${mailbox.uid}`)).body)).toEqual(["kept@contacts.test"]);
            expect(addresses((await searchContacts("kept", someoneElse, "&limit=20")).body)).toEqual(["keptprivate@contacts.test", "keptshared@contacts.test"]);
        });

        it("returns nothing for a caller without contacts folders, and de-duplicates addresses", async () => {
            expect((await searchContacts("dupe", newUser())).body).toEqual([]);
            const lonely: any = newUser();
            await mailboxFor(lonely);
            expect((await searchContacts("dupe", lonely)).body).toEqual([]);

            const mailbox = await mailboxFor(owner);
            const folder = await contactsFolder(mailbox.uid);
            await contact(folder, { displayName: "Dupe One", emails: [email("dupe@contacts.test")] });
            await contact(folder, { displayName: "Dupe Two", emails: [email("DUPE@contacts.test")] });
            const res = await searchContacts("dupe", owner);
            expect(res.body).toEqual([{ displayName: "Dupe One", address: "dupe@contacts.test", kind: "contact" }]);
        });

        it("matches query text literally", async () => {
            const mailbox = await mailboxFor(owner);
            const folder = await contactsFolder(mailbox.uid);
            await contact(folder, { displayName: "Percent Person", emails: [email("50%off@deals.test"), email("a_b@deals.test")] });
            await contact(folder, { displayName: "Quote Person", emails: [email("q\"uote@deals.test")] });
            expect(addresses((await searchContacts("50%", owner)).body)).toEqual(["50%off@deals.test"]);
            expect(addresses((await searchContacts("a_b", owner)).body)).toEqual(["a_b@deals.test"]);
            expect(addresses((await searchContacts("q\"u", owner)).body)).toEqual(["q\"uote@deals.test"]);
            for (const q of ["5%", "a%", "__", ".*", "(a+)+$", "\\\\"]) {
                const res = await searchContacts(q, owner);
                expect(res.status).toBe(200);
                expect(res.body).toEqual([]);
            }
        });
    });

    describe("GET /correspondents (people the caller's mailboxes have corresponded with)", () => {
        const owner: any = newUser();
        const day = (n: number): Date => new Date(Date.UTC(2026, 0, n));
        // A mailbox whose backfill has already run, so a test's own rows are the only ones searched.
        const doneMailbox = async (user: any, fields: Record<string, any> = {}, records: AclRecords = []) =>
            await mailboxFor(user, { correspondentsBackfilledAt: new Date(), ...fields }, records);
        const correspondent = async (mailbox: any, address: string, fields: Record<string, any> = {}) =>
            await ctx.saveCorrespondent({ mailboxUid: mailbox.uid, address, displayName: "", lastSeenAt: day(1), count: 1, lastSource: "received", ...fields });

        it("requires a signed-in caller and validates the query", async () => {
            expect((await get("/correspondents?q=carol")).status).toBe(401);
            expect((await searchCorrespondents("c", owner)).status).toBe(400);
            expect((await searchCorrespondents("carol", owner, "&limit=x")).status).toBe(400);
            expect((await get("/correspondents", owner)).status).toBe(400);
        });

        it("returns nothing for a caller with no mailbox", async () => {
            expect((await searchCorrespondents("carol", newUser())).body).toEqual([]);
        });

        it("matches name word prefixes and address prefixes, and returns only name, address and kind", async () => {
            const mailbox = await doneMailbox(owner);
            await correspondent(mailbox, "carol.danvers@marvel.test", { displayName: "Carol Danvers" });
            await correspondent(mailbox, "nameless@marvel.test");
            await correspondent(mailbox, "peter@marvel.test", { displayName: "Peter Parker-Stark" });

            const byName = await searchCorrespondents("DANV", owner);
            expect(byName.status).toBe(200);
            expect(byName.body).toEqual([{ displayName: "Carol Danvers", address: "carol.danvers@marvel.test", kind: "correspondent" }]);
            expect(addresses((await searchCorrespondents("carol dan", owner)).body)).toEqual(["carol.danvers@marvel.test"]);
            expect(addresses((await searchCorrespondents("stark", owner)).body)).toEqual(["peter@marvel.test"]);
            expect(addresses((await searchCorrespondents("nameless@ma", owner)).body)).toEqual(["nameless@marvel.test"]);
            expect((await searchCorrespondents("nameless", owner)).body).toEqual([{ displayName: "", address: "nameless@marvel.test", kind: "correspondent" }]);
            // Not a word prefix, and a domain isn't a prefix of the address.
            expect((await searchCorrespondents("anvers", owner)).body).toEqual([]);
            expect((await searchCorrespondents("marvel.test", owner)).body).toEqual([]);
            expect((await searchCorrespondents("carol smith", owner)).body).toEqual([]);
        });

        it("orders by most recently seen, then most often, with one entry per address across the caller's mailboxes", async () => {
            const first = await doneMailbox(owner);
            const second = await doneMailbox(owner);
            await correspondent(first, "ord.old@x.test", { displayName: "Ord Old", lastSeenAt: day(1), count: 50 });
            await correspondent(first, "ord.new@x.test", { displayName: "Ord New", lastSeenAt: day(9), count: 1 });
            await correspondent(first, "ord.tie.few@x.test", { displayName: "Ord Tie Few", lastSeenAt: day(5), count: 2 });
            await correspondent(first, "ord.tie.many@x.test", { displayName: "Ord Tie Many", lastSeenAt: day(5), count: 7 });
            await correspondent(first, "ord.both@x.test", { displayName: "Ord Both Old Name", lastSeenAt: day(2), count: 1 });
            await correspondent(second, "ord.both@x.test", { displayName: "Ord Both New Name", lastSeenAt: day(7), count: 1 });
            const res = await searchCorrespondents("ord", owner, "&limit=20");
            expect(res.body.map((entry: any) => entry.address)).toEqual([
                "ord.new@x.test",
                "ord.both@x.test",
                "ord.tie.many@x.test",
                "ord.tie.few@x.test",
                "ord.old@x.test",
            ]);
            expect(res.body[1].displayName).toBe("Ord Both New Name");
        });

        it("defaults to 8 entries and caps the limit", async () => {
            const mailbox = await doneMailbox(owner);
            for (let i = 0; i < 25; i++) {
                await correspondent(mailbox, `lim${i}@x.test`, { displayName: `Lim ${i}`, lastSeenAt: day(1 + i) });
            }
            expect((await searchCorrespondents("lim", owner)).body).toHaveLength(8);
            expect((await searchCorrespondents("lim", owner, "&limit=3")).body).toHaveLength(3);
            expect((await searchCorrespondents("lim", owner, "&limit=500")).body).toHaveLength(DIRECTORY_MAX_LIMIT);
            // Newest first.
            expect((await searchCorrespondents("lim", owner, "&limit=1")).body[0].address).toBe("lim24@x.test");
        });

        it("only searches the caller's own mailboxes and a mailboxUid the caller may read", async () => {
            const mine = await doneMailbox(owner);
            await correspondent(mine, "scope.mine@x.test");
            const someoneElse: any = newUser();
            const shared = await doneMailbox(someoneElse, { displayName: "Shared" }, [{ userOrRoleId: owner.uid, actions: [ACLAction.READ] }]);
            await correspondent(shared, "scope.shared@x.test");
            const privateMailbox = await doneMailbox(someoneElse, { displayName: "Private" });
            await correspondent(privateMailbox, "scope.private@x.test");

            expect(addresses((await searchCorrespondents("scope", owner, "&limit=20")).body)).toEqual(["scope.mine@x.test"]);
            expect(addresses((await searchCorrespondents("scope", owner, `&limit=20&mailboxUid=${shared.uid}`)).body).sort()).toEqual(["scope.mine@x.test", "scope.shared@x.test"]);
            expect(addresses((await searchCorrespondents("scope", owner, `&limit=20&mailboxUid=${privateMailbox.uid}`)).body)).toEqual(["scope.mine@x.test"]);
            expect(addresses((await searchCorrespondents("scope", owner, `&limit=20&mailboxUid=${mine.uid}`)).body)).toEqual(["scope.mine@x.test"]);
            expect(addresses((await searchCorrespondents("scope", owner, "&limit=20&mailboxUid=no-such-mailbox")).body)).toEqual(["scope.mine@x.test"]);
            expect(addresses((await searchCorrespondents("scope", someoneElse, "&limit=20")).body).sort()).toEqual(["scope.private@x.test", "scope.shared@x.test"]);
            // No role reads another user's mailbox (the platform's mail privacy rule): an administrator without a grant finds nothing.
            expect((await searchCorrespondents("scope", newUser(["admin"]), `&limit=20&mailboxUid=${privateMailbox.uid}`)).body).toEqual([]);
        });

        it("matches query text literally", async () => {
            const mailbox = await doneMailbox(owner);
            await correspondent(mailbox, "50%off@deals.test", { displayName: "Percent Person" });
            await correspondent(mailbox, "a_b@deals.test", { displayName: "Under Score" });
            expect(addresses((await searchCorrespondents("50%", owner)).body)).toEqual(["50%off@deals.test"]);
            expect(addresses((await searchCorrespondents("a_b", owner)).body)).toEqual(["a_b@deals.test"]);
            for (const q of ["5%", "a%", "__", ".*", "(a+)+$", "\\\\", "$ne"]) {
                const res = await searchCorrespondents(q, owner);
                expect(res.status).toBe(200);
                expect(res.body).toEqual([]);
            }
        });

        it("builds a mailbox's correspondents from its existing mail and events the first time it is searched, once", async () => {
            const mailbox = await mailboxFor(owner, { primarySmtpAddress: "me.bf@owners.test", aliasAddresses: ["alias.bf@owners.test"] });
            const folder = async (type: FolderType) => await ctx.saveFolder({ mailboxUid: mailbox.uid, name: type, type });
            const inbox = await folder(FolderType.INBOX);
            const sent = await folder(FolderType.SENT_ITEMS);
            const junk = await folder(FolderType.JUNK);
            const calendar = await folder(FolderType.CALENDAR);
            const msg = (folderUid: string, from: string, recipients: [string, string][], receivedDate: Date, fromName = "") =>
                ctx.saveMessage({
                    mailboxUid: mailbox.uid,
                    folderUid,
                    messageId: uuid.v4(),
                    from: { address: from, displayName: fromName, type: "to" },
                    recipients: recipients.map(([address, type]) => ({ address, type, displayName: address.split("@")[0] })),
                    receivedDate,
                });
            await msg(inbox.uid, "BF.Ann@Sender.test", [["me.bf@owners.test", "to"], ["bf.cc@sender.test", "cc"], ["bf.bcc@sender.test", "bcc"]], day(3), "Ann Backfill");
            await msg(inbox.uid, "bf.ann@sender.test", [["alias.bf@owners.test", "to"]], day(4), "Ann B. Backfill");
            await msg(sent.uid, "me.bf@owners.test", [["bf.to@dest.test", "to"], ["bf.hidden@dest.test", "bcc"]], day(5));
            await msg(junk.uid, "bf.spam@sender.test", [["me.bf@owners.test", "to"]], day(6));
            await ctx.saveCalendarEvent({
                mailboxUid: mailbox.uid,
                folderUid: calendar.uid,
                title: "Sync",
                icalUid: uuid.v4(),
                organizer: { address: "bf.org@meet.test", displayName: "Olive Organizer", type: "to" },
                attendees: [
                    { address: "me.bf@owners.test", role: "required", responseStatus: "accepted", isOrganizer: false },
                    { address: "bf.guest@meet.test", displayName: "Gus Guest", role: "required", responseStatus: "needs_action", isOrganizer: false },
                ],
                startDate: day(7),
                endDate: day(8),
            });

            expect((await ctx.findMailbox(mailbox.uid)).correspondentsBackfilledAt ?? null).toBeNull();
            const res = await searchCorrespondents("bf", owner, "&limit=20");
            expect(res.status).toBe(200);
            expect(res.body.map((entry: any) => entry.address).sort()).toEqual([
                "bf.ann@sender.test",
                "bf.cc@sender.test",
                "bf.guest@meet.test",
                "bf.hidden@dest.test",
                "bf.org@meet.test",
                "bf.to@dest.test",
            ]);
            // The newest name of Ann wins; the bcc of received mail, junk and the mailbox's own addresses are left out.
            expect(res.body.find((entry: any) => entry.address === "bf.ann@sender.test").displayName).toBe("Ann B. Backfill");

            const stored = await ctx.findCorrespondents(mailbox.uid);
            expect(stored.find((row) => row.address === "bf.ann@sender.test")).toMatchObject({ count: 2, lastSource: "received" });
            expect(stored.find((row) => row.address === "bf.to@dest.test")).toMatchObject({ count: 1, lastSource: "sent" });
            expect(stored.find((row) => row.address === "bf.org@meet.test")).toMatchObject({ count: 1, lastSource: "event" });
            expect((await ctx.findMailbox(mailbox.uid)).correspondentsBackfilledAt).toBeTruthy();

            // Once: a second search adds nothing, however often it is repeated.
            await Promise.all([searchCorrespondents("bf", owner), searchCorrespondents("bf", owner)]);
            const after = await ctx.findCorrespondents(mailbox.uid);
            expect(after).toHaveLength(stored.length);
            expect(after.find((row) => row.address === "bf.ann@sender.test").count).toBe(2);
        });

        it("backfills a mailbox once even when searched by several requests at the same time", async () => {
            const mailbox = await mailboxFor(owner, { primarySmtpAddress: "me.race@owners.test" });
            const inbox = await ctx.saveFolder({ mailboxUid: mailbox.uid, name: "Inbox", type: FolderType.INBOX });
            await ctx.saveMessage({
                mailboxUid: mailbox.uid,
                folderUid: inbox.uid,
                messageId: uuid.v4(),
                from: { address: "zed.race@sender.test", displayName: "Zed", type: "to" },
                recipients: [],
                receivedDate: day(3),
            });
            await Promise.all([searchCorrespondents("zed", owner), searchCorrespondents("zed", owner), searchCorrespondents("zed", owner)]);
            const stored = (await ctx.findCorrespondents(mailbox.uid)).filter((row) => row.address === "zed.race@sender.test");
            expect(stored).toHaveLength(1);
            expect(stored[0].count).toBe(1);
        });

        it("does not backfill a mailbox that is not the caller's to read", async () => {
            const someoneElse: any = newUser();
            const privateMailbox = await mailboxFor(someoneElse);
            const inbox = await ctx.saveFolder({ mailboxUid: privateMailbox.uid, name: "Inbox", type: FolderType.INBOX });
            await ctx.saveMessage({
                mailboxUid: privateMailbox.uid,
                folderUid: inbox.uid,
                messageId: uuid.v4(),
                from: { address: "who.priv@sender.test", displayName: "", type: "to" },
                recipients: [],
                receivedDate: day(3),
            });
            await mailboxFor(owner);
            expect((await searchCorrespondents("who", owner, `&mailboxUid=${privateMailbox.uid}`)).body).toEqual([]);
            expect(await ctx.findCorrespondents(privateMailbox.uid)).toEqual([]);
            expect((await ctx.findMailbox(privateMailbox.uid)).correspondentsBackfilledAt ?? null).toBeNull();
        });
    });
    describe("POST /suggested-contacts (correspondents as contacts of a Suggested Contacts folder)", () => {
        const owner: any = newUser();
        const day = (n: number): Date => new Date(Date.UTC(2026, 0, n));
        const post = (path: string, user?: any) => {
            const req: any = request(ctx.app()).post(`${ctx.baseUrl}${path}`);
            return user ? req.set("Authorization", "jwt " + tokenFor(user)) : req;
        };
        const suggest = (mailboxUid: string, user: any) => post(`/suggested-contacts?mailboxUid=${mailboxUid}`, user);
        const doneMailbox = async (user: any, fields: Record<string, any> = {}, records: AclRecords = []) =>
            await mailboxFor(user, { correspondentsBackfilledAt: new Date(), ...fields }, records);
        const correspondent = async (mailbox: any, address: string, fields: Record<string, any> = {}) =>
            await ctx.saveCorrespondent({ mailboxUid: mailbox.uid, address, displayName: "", lastSeenAt: day(1), count: 1, lastSource: "received", ...fields });
        const suggested = async (mailbox: any) => {
            const folder = (await ctx.findFolders(mailbox.uid)).find((candidate) => candidate.type === FolderType.SUGGESTED_CONTACTS);
            return { folder, contacts: folder ? (await ctx.findContacts(mailbox.uid)).filter((contact) => contact.folderUid === folder.uid) : [] };
        };

        it("requires a signed-in caller and a mailboxUid", async () => {
            expect((await post("/suggested-contacts?mailboxUid=x")).status).toBe(401);
            expect((await post("/suggested-contacts", owner)).status).toBe(400);
            expect((await post("/suggested-contacts?mailboxUid=", owner)).status).toBe(400);
            expect((await post("/suggested-contacts?mailboxUid=a&mailboxUid=b", owner)).status).toBe(400);
        });

        it("refuses callers who may not create in the mailbox, and unknown mailboxes, creating nothing", async () => {
            const mailbox = await doneMailbox(owner);
            await correspondent(mailbox, "refused@x.test");
            const reader: any = newUser();
            const readOnly = await doneMailbox(owner, {}, [{ userOrRoleId: reader.uid, actions: [ACLAction.READ, ACLAction.LIST] }]);
            await correspondent(readOnly, "refused2@x.test");
            expect((await suggest(mailbox.uid, newUser())).status).toBe(403);
            expect((await suggest(mailbox.uid, newUser(["admin"]))).status).toBe(403);
            expect((await suggest(readOnly.uid, reader)).status).toBe(403);
            expect((await suggest("no-such-mailbox", owner)).status).toBe(403);
            expect((await suggested(mailbox)).folder).toBeUndefined();
            expect((await suggested(readOnly)).folder).toBeUndefined();
            expect((await ctx.findCorrespondents(mailbox.uid)).every((row) => !row.suggestedAt)).toBe(true);
        });

        it("answers 404 for a mailbox the caller holds an ACL on that has no row", async () => {
            const ghost = await mailboxFor(owner);
            await ctx.removeMailbox(ghost.uid);
            expect((await suggest(ghost.uid, owner)).status).toBe(404);
        });

        it("lets a delegate with write access fill the mailbox's Suggested Contacts folder", async () => {
            const delegate: any = newUser();
            const mailbox = await doneMailbox(owner, {}, [{ userOrRoleId: delegate.uid, actions: [ACLAction.CREATE] }]);
            await correspondent(mailbox, "delegated@x.test", { displayName: "Del Egated" });
            const res = await suggest(mailbox.uid, delegate);
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ created: 1, remaining: 0 });
            expect((await suggested(mailbox)).contacts.map((contact) => contact.displayName)).toEqual(["Del Egated"]);
        });

        it("creates the folder and a contact per correspondent that is nobody's contact yet, once", async () => {
            const mailbox = await doneMailbox(owner);
            const contacts = await ctx.saveFolder({ mailboxUid: mailbox.uid, name: "Contacts", type: FolderType.CONTACTS });
            await ctx.saveContact({
                mailboxUid: mailbox.uid,
                folderUid: contacts.uid,
                displayName: "Already Mine",
                emails: [{ address: "Mine@Contacts.test", type: ContactAddressKind.WORK }],
            });
            await correspondent(mailbox, "ann@x.test", { displayName: "Ann Example", lastSeenAt: day(3) });
            await correspondent(mailbox, "bare@x.test", { lastSeenAt: day(2) });
            await correspondent(mailbox, "mine@contacts.test", { displayName: "Mine From Mail", lastSeenAt: day(4) });
            await correspondent(mailbox, "done@x.test", { suggestedAt: day(1) });

            const res = await suggest(mailbox.uid, owner);
            expect(res.status).toBe(200);
            const { folder, contacts: made } = await suggested(mailbox);
            expect(folder).toMatchObject({ name: "Suggested Contacts", type: FolderType.SUGGESTED_CONTACTS });
            expect(res.body).toEqual({ folderUid: folder.uid, created: 2, remaining: 0 });
            expect(made.map((contact) => contact.displayName).sort()).toEqual(["Ann Example", "bare@x.test"]);
            const ann = made.find((contact) => contact.displayName === "Ann Example");
            expect(ann.mailboxUid).toBe(mailbox.uid);
            expect(ann.emails).toEqual([{ address: "ann@x.test", type: ContactAddressKind.OTHER }]);
            // Everything that was considered is marked.
            const rows = await ctx.findCorrespondents(mailbox.uid);
            for (const address of ["ann@x.test", "bare@x.test", "mine@contacts.test"]) {
                expect(rows.find((row) => row.address === address).suggestedAt).toBeTruthy();
            }
            expect((await ctx.findContacts(mailbox.uid)).filter((contact) => contact.folderUid === contacts.uid)).toHaveLength(1);

            // Once: nothing more is made, and the folder is the same one.
            const again = await suggest(mailbox.uid, owner);
            expect(again.body).toEqual({ folderUid: folder.uid, created: 0, remaining: 0 });
            expect((await ctx.findFolders(mailbox.uid)).filter((candidate) => candidate.type === FolderType.SUGGESTED_CONTACTS)).toHaveLength(1);
            expect((await suggested(mailbox)).contacts).toHaveLength(2);
        });

        it("never brings back a suggested contact the user deleted, and picks up people seen later", async () => {
            const mailbox = await doneMailbox(owner);
            await correspondent(mailbox, "gone@x.test", { displayName: "Gone Soon" });
            const first = await suggest(mailbox.uid, owner);
            expect(first.body.created).toBe(1);
            const { contacts } = await suggested(mailbox);
            await ctx.removeContact(contacts[0].uid);
            await correspondent(mailbox, "later@x.test", { displayName: "Later Person" });
            const second = await suggest(mailbox.uid, owner);
            expect(second.body).toMatchObject({ created: 1, remaining: 0 });
            expect((await suggested(mailbox)).contacts.map((contact) => contact.displayName)).toEqual(["Later Person"]);
        });

        it("includes the people from the mailbox's existing mail the first time, and leaves other mailboxes alone", async () => {
            const mailbox = await mailboxFor(owner, { primarySmtpAddress: "me.sc@owners.test" });
            const inbox = await ctx.saveFolder({ mailboxUid: mailbox.uid, name: "Inbox", type: FolderType.INBOX });
            await ctx.saveMessage({
                mailboxUid: mailbox.uid,
                folderUid: inbox.uid,
                messageId: uuid.v4(),
                from: { address: "hist.sc@sender.test", displayName: "History Hank", type: "to" },
                recipients: [{ address: "me.sc@owners.test", type: "to", displayName: "" }],
                receivedDate: day(3),
            });
            const other = await doneMailbox(newUser());
            await correspondent(other, "other.sc@x.test");
            const res = await suggest(mailbox.uid, owner);
            expect(res.status).toBe(200);
            expect(res.body.created).toBe(1);
            expect((await suggested(mailbox)).contacts.map((contact) => contact.displayName)).toEqual(["History Hank"]);
            expect((await suggested(other)).folder).toBeUndefined();
        });

        it("is not part of the contacts directory search, which covers the user's own contacts", async () => {
            const mailbox = await doneMailbox(owner);
            await correspondent(mailbox, "hidden.sc@x.test", { displayName: "Hidden Suggest" });
            await suggest(mailbox.uid, owner);
            expect((await get("/contacts?q=hidden", owner)).body).toEqual([]);
            expect(addresses((await get("/correspondents?q=hidden", owner)).body)).toEqual(["hidden.sc@x.test"]);
        });
    });
}
