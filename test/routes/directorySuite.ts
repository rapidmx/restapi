///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `GET /mail/directory` and `GET /mail/directory/contacts` (recipient suggestions), identical on both backends.
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
}
