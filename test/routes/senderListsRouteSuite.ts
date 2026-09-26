///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// A mailbox's Blocked Senders and Safe Senders lists (`Mailbox.blockedSenders`/`safeSenders`, and the add/remove endpoints on the
// mailbox route) and the exact-match sender conditions of a mail filter rule, identical on both backends.
// `test/routes/{mongo,sql}/SenderListsRoute.test.ts` supply a started server and raw row helpers. Every case goes through real HTTP
// against a real database.
import { request } from "@rapidrest/service-core/test";
import { ACLAction, RepoUtils } from "@rapidrest/service-core";
import { JWTUtils } from "@rapidrest/core";
import * as uuid from "uuid";
import { MailFilterActionType } from "../../src/models/types.js";
import { MAX_SENDER_LIST_ENTRIES } from "../../src/util/SenderListUtils.js";

type AclRecords = { userOrRoleId: string; actions: string[] }[];

export interface SenderListsRouteSuiteContext {
    config: any;
    app: () => any;
    mailboxUrl: string;
    filterRuleUrl: string;
    /** Saves a mailbox with `fields` over defaults and an ACL carrying full access for its owner plus `records`. */
    saveMailbox: (fields: Record<string, any>, records?: AclRecords) => Promise<any>;
    findMailbox: (uid: string) => Promise<any>;
    /** Writes `fields` straight to the row, bumping its version like any real write. */
    rawUpdateMailbox: (uid: string, fields: Record<string, any>) => Promise<void>;
    /** Leaves both lists unset (absent on Mongo, `null` on SQL), as a row written before the fields existed. */
    clearLists: (uid: string) => Promise<void>;
}

const OWNER = "owner";
const USERS = [OWNER, "manager", "pat", "dave", "hank", "erin", "admin"] as const;
type User = (typeof USERS)[number];

export function senderListsRouteSuite(ctx: SenderListsRouteSuiteContext): void {
    const newUser = (roles: string[] = []): any => ({ uid: uuid.v4(), roles, elevated: Date.now() });
    const tokenFor = (user: any): string => JWTUtils.createTokenSync(ctx.config.get("auth"), user);
    const as = (req: any, user?: any): any => (user ? req.set("Authorization", "jwt " + tokenFor(user)) : req);

    interface World {
        users: Record<User, any>;
        mailbox: any;
        url: string;
    }

    /** A mailbox owned by `owner`, shared with: manager (full), pat (read + update), dave (read), hank (update). erin has nothing; admin holds a trusted role only. */
    const world = async (fields: Record<string, any> = {}): Promise<World> => {
        const users = Object.fromEntries(USERS.map((name) => [name, newUser(name === "admin" ? ["admin"] : [])])) as Record<User, any>;
        const mailbox = await ctx.saveMailbox(
            { ownerUserUid: users.owner.uid, displayName: "Owner", primarySmtpAddress: `owner@${uuid.v4().slice(0, 8)}.test`, ...fields },
            [
                { userOrRoleId: users.manager.uid, actions: [ACLAction.FULL] },
                { userOrRoleId: users.pat.uid, actions: [ACLAction.READ, ACLAction.UPDATE] },
                { userOrRoleId: users.dave.uid, actions: [ACLAction.READ] },
                { userOrRoleId: users.hank.uid, actions: [ACLAction.UPDATE] },
            ],
        );
        return { users, mailbox, url: `${ctx.mailboxUrl}/${mailbox.uid}` };
    };

    const listsOf = async (w: World): Promise<{ blocked: string[]; safe: string[] }> => {
        const row = await ctx.findMailbox(w.mailbox.uid);
        return { blocked: row.blockedSenders ?? [], safe: row.safeSenders ?? [] };
    };
    const post = (w: World, list: "blocked-senders" | "safe-senders", body: unknown, user: any = w.users.owner) =>
        as(request(ctx.app()).post(`${w.url}/${list}`), user).send(body as any);
    const remove = (w: World, list: "blocked-senders" | "safe-senders", entry: string, user: any = w.users.owner) =>
        as(request(ctx.app()).delete(`${w.url}/${list}/${encodeURIComponent(entry)}`), user);
    /** A PUT of `body` over the mailbox, carrying the row's current version. */
    const put = async (w: World, body: Record<string, any>, user: any = w.users.owner) =>
        as(request(ctx.app()).put(w.url), user).send({ uid: w.mailbox.uid, version: (await ctx.findMailbox(w.mailbox.uid)).version, ...body });
    /** Makes the next `RepoUtils.update()` run `interleave()` first - a concurrent write between the route's read and write. */
    const interleaveNextUpdate = (interleave: () => Promise<void>): void => {
        const original = RepoUtils.prototype.update;
        vi.spyOn(RepoUtils.prototype, "update").mockImplementationOnce(async function (this: any, ...args: any[]) {
            await interleave();
            return await (original as any).apply(this, args);
        });
    };

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("POST /:id/blocked-senders and /safe-senders", () => {
        it("Adds an address, lowercased, and answers the entry and both lists.", async () => {
            const w = await world();

            const res = await post(w, "blocked-senders", { entry: " Pest@Bad.Example " });

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ entry: "pest@bad.example", changed: true, blockedSenders: ["pest@bad.example"], safeSenders: [] });
            expect(await listsOf(w)).toEqual({ blocked: ["pest@bad.example"], safe: [] });
        });

        it("Stores a domain in its canonical @domain form, whichever way it was written.", async () => {
            const w = await world();

            const bare = await post(w, "blocked-senders", { entry: "Bad.Example" });
            const at = await post(w, "safe-senders", { entry: "@friends.example" });

            expect(bare.body.entry).toBe("@bad.example");
            expect(at.body.entry).toBe("@friends.example");
            expect(await listsOf(w)).toEqual({ blocked: ["@bad.example"], safe: ["@friends.example"] });
        });

        it("Is idempotent: adding an entry that is already there changes nothing and writes nothing.", async () => {
            const w = await world({ blockedSenders: ["pest@bad.example"] });
            const before = (await ctx.findMailbox(w.mailbox.uid)).version;

            const res = await post(w, "blocked-senders", { entry: "PEST@bad.example" });

            expect(res.status).toBe(200);
            expect(res.body.changed).toBe(false);
            expect(res.body.blockedSenders).toEqual(["pest@bad.example"]);
            expect((await ctx.findMailbox(w.mailbox.uid)).version).toBe(before);
        });

        it("Moves an entry: adding it to the blocked list takes it off the safe list, and the other way round.", async () => {
            const w = await world({ safeSenders: ["both@x.example", "keep@x.example"] });

            const blocked = await post(w, "blocked-senders", { entry: "both@x.example" });
            expect(blocked.body).toMatchObject({ changed: true, blockedSenders: ["both@x.example"], safeSenders: ["keep@x.example"] });

            const safe = await post(w, "safe-senders", { entry: "both@x.example" });
            expect(safe.body).toMatchObject({ changed: true, blockedSenders: [], safeSenders: ["keep@x.example", "both@x.example"] });
            expect(await listsOf(w)).toEqual({ blocked: [], safe: ["keep@x.example", "both@x.example"] });
        });

        it("Keeps an address and its domain as two entries.", async () => {
            const w = await world();

            await post(w, "blocked-senders", { entry: "ann@x.example" });
            await post(w, "blocked-senders", { entry: "@x.example" });

            expect((await listsOf(w)).blocked).toEqual(["ann@x.example", "@x.example"]);
        });

        it.each([[{}], [{ entry: 42 }], [{ entry: "" }], [{ entry: "not an entry" }], [{ entry: "Ann <ann@x.example>" }], [{ entry: "a@b@c.example" }], [{ entry: "localhost" }], [undefined]])(
            "Refuses (400) %j.",
            async (body) => {
                const w = await world();

                const res = await post(w, "blocked-senders", body);

                expect(res.status).toBe(400);
                expect(await listsOf(w)).toEqual({ blocked: [], safe: [] });
            },
        );

        it("Refuses (400) an entry past the cap, but still answers an entry that is already there.", async () => {
            const full = Array.from({ length: MAX_SENDER_LIST_ENTRIES }, (_, i) => `user${i}@x.example`);
            const w = await world({ blockedSenders: full });

            const over = await post(w, "blocked-senders", { entry: "one-more@x.example" });
            const same = await post(w, "blocked-senders", { entry: "user7@x.example" });

            expect(over.status).toBe(400);
            expect(same.status).toBe(200);
            expect(same.body.changed).toBe(false);
        });

        it("Works on a row that has no lists stored (written before they existed).", async () => {
            const w = await world();
            await ctx.clearLists(w.mailbox.uid);

            const res = await post(w, "safe-senders", { entry: "friend@ok.example" });

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ blockedSenders: [], safeSenders: ["friend@ok.example"] });
        });

        it("Loses no entry when several are added at once: each retries against what the others left.", async () => {
            const w = await world();
            const entries = ["a@x.example", "b@x.example", "c@x.example", "d@x.example"];

            const results = await Promise.all(entries.map((entry) => post(w, "blocked-senders", { entry })));

            expect(results.map((res) => res.status)).toEqual([200, 200, 200, 200]);
            expect((await listsOf(w)).blocked.sort()).toEqual(entries);
        });

        it("Re-reads and applies the change to what a concurrent write left when it loses the optimistic lock (two browser tabs).", async () => {
            const w = await world({ blockedSenders: ["first@x.example"] });
            interleaveNextUpdate(() => ctx.rawUpdateMailbox(w.mailbox.uid, { blockedSenders: ["first@x.example", "tab2@x.example"] }));

            const res = await post(w, "blocked-senders", { entry: "tab1@x.example" });

            expect(res.status).toBe(200);
            expect(res.body.blockedSenders).toEqual(["first@x.example", "tab2@x.example", "tab1@x.example"]);
            expect((await listsOf(w)).blocked).toEqual(["first@x.example", "tab2@x.example", "tab1@x.example"]);
        });

        it("Answers 409 when the lock keeps being lost, and passes any other write failure through.", async () => {
            const w = await world();
            const spy = vi.spyOn(RepoUtils.prototype, "update").mockRejectedValue(Object.assign(new Error("conflict"), { status: 409 }));

            const conflict = await post(w, "blocked-senders", { entry: "a@x.example" });
            expect(conflict.status).toBe(409);
            expect(spy).toHaveBeenCalledTimes(5);

            spy.mockRejectedValue(Object.assign(new Error("boom"), { status: 500 }));
            const failure = await post(w, "blocked-senders", { entry: "a@x.example" });
            expect(failure.status).toBe(500);
            expect(await listsOf(w)).toEqual({ blocked: [], safe: [] });
        });

        it("Answers 404 for a mailbox that does not exist.", async () => {
            const w = await world();

            const res = await as(request(ctx.app()).post(`${ctx.mailboxUrl}/${uuid.v4()}/blocked-senders`), w.users.owner).send({ entry: "a@x.example" });

            expect(res.status).toBe(404);
        });
    });

    describe("DELETE /:id/blocked-senders/:entry and /safe-senders/:entry", () => {
        it("Removes an address, and a domain given URL-encoded, and answers both lists.", async () => {
            const w = await world({ blockedSenders: ["pest@bad.example", "@spam.example"], safeSenders: ["friend@ok.example"] });

            const address = await remove(w, "blocked-senders", "PEST@bad.example");
            const domain = await remove(w, "blocked-senders", "@spam.example");

            expect(address.status).toBe(200);
            expect(address.body).toEqual({ entry: "pest@bad.example", changed: true, blockedSenders: ["@spam.example"], safeSenders: ["friend@ok.example"] });
            expect(domain.body).toMatchObject({ entry: "@spam.example", changed: true, blockedSenders: [] });
            expect(await listsOf(w)).toEqual({ blocked: [], safe: ["friend@ok.example"] });
        });

        it("Removes from the safe list only.", async () => {
            const w = await world({ blockedSenders: ["x@x.example"], safeSenders: ["x@x.example"] });

            const res = await remove(w, "safe-senders", "x@x.example");

            expect(res.body).toMatchObject({ changed: true, blockedSenders: ["x@x.example"], safeSenders: [] });
        });

        it("Succeeds for an entry that is not there, changing nothing.", async () => {
            const w = await world({ blockedSenders: ["pest@bad.example"] });

            const res = await remove(w, "blocked-senders", "nobody@x.example");

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ entry: "nobody@x.example", changed: false, blockedSenders: ["pest@bad.example"], safeSenders: [] });
        });

        it("Refuses (400) an entry that is not an address or a domain.", async () => {
            const w = await world();

            const res = await remove(w, "blocked-senders", "not an entry");

            expect(res.status).toBe(400);
        });
    });

    describe("Who may change the lists", () => {
        it("Lets the owner and a full-access ('manager') delegate; refuses (403) a delegate with read and update access, one with only read, and one with only update.", async () => {
            const w = await world();
            const attempts: [User, number][] = [
                ["owner", 200],
                ["manager", 200],
                ["pat", 403],
                ["dave", 403],
                ["hank", 404],
            ];

            for (const [name, status] of attempts) {
                const added = await post(w, "blocked-senders", { entry: `${name}@x.example` }, w.users[name]);
                expect(added.status, `POST ${name}`).toBe(status);
                const removed = await remove(w, "safe-senders", "nobody@x.example", w.users[name]);
                expect(removed.status, `DELETE ${name}`).toBe(status);
            }
            expect((await listsOf(w)).blocked).toEqual(["owner@x.example", "manager@x.example"]);
        });

        it("Answers 404, as GET /:id does, to a caller who cannot read the mailbox - a stranger, and an administrator with no grant (a trusted role is never a grant).", async () => {
            const w = await world({ blockedSenders: ["keep@x.example"] });

            for (const name of ["erin", "admin"] as const) {
                expect((await post(w, "blocked-senders", { entry: "a@x.example" }, w.users[name])).status, name).toBe(404);
                expect((await post(w, "safe-senders", { entry: "a@x.example" }, w.users[name])).status, name).toBe(404);
                expect((await remove(w, "blocked-senders", "keep@x.example", w.users[name])).status, name).toBe(404);
            }
            expect((await listsOf(w)).blocked).toEqual(["keep@x.example"]);
        });

        it("Refuses a caller who is not signed in.", async () => {
            const w = await world();

            const res = await request(ctx.app()).post(`${w.url}/blocked-senders`).send({ entry: "a@x.example" });

            expect([401, 403]).toContain(res.status);
        });
    });

    describe("The lists through the mailbox itself", () => {
        it("Defaults a new mailbox's lists to empty and reads a row with none stored as empty, in one mailbox and in a list.", async () => {
            const w = await world();
            await ctx.clearLists(w.mailbox.uid);

            const one = await as(request(ctx.app()).get(w.url), w.users.owner);
            const list = await as(request(ctx.app()).get(ctx.mailboxUrl), w.users.owner);

            expect(one.body).toMatchObject({ blockedSenders: [], safeSenders: [] });
            expect(list.body[0]).toMatchObject({ blockedSenders: [], safeSenders: [] });
        });

        it("Lets the owner write both lists with a PUT, normalized and de-duplicated.", async () => {
            const w = await world();

            const res = await put(w, { blockedSenders: ["Pest@Bad.example", "bad.example", "@BAD.example"], safeSenders: ["Friend@ok.example"] });

            expect(res.status).toBe(200);
            expect(await listsOf(w)).toEqual({ blocked: ["pest@bad.example", "@bad.example"], safe: ["friend@ok.example"] });
        });

        it("Lets the owner write one list with a property PUT.", async () => {
            const w = await world();

            const res = await as(request(ctx.app()).put(`${w.url}/safeSenders`), w.users.owner).send(["Friend@ok.example"]);

            expect(res.status).toBe(200);
            expect((await listsOf(w)).safe).toEqual(["friend@ok.example"]);
        });

        it("Refuses (400) a list that is not an array of addresses and domains, one past the cap, and an entry on both lists.", async () => {
            const w = await world({ safeSenders: ["both@x.example"] });

            for (const value of ["nope", {}, [42], ["not an entry"], Array.from({ length: MAX_SENDER_LIST_ENTRIES + 1 }, (_, i) => `u${i}@x.example`)]) {
                const res = await put(w, { blockedSenders: value });
                expect(res.status, JSON.stringify(value).slice(0, 40)).toBe(400);
            }
            const both = await put(w, { blockedSenders: ["both@x.example"] });
            expect(both.status).toBe(400);
            const property = await as(request(ctx.app()).put(`${w.url}/blockedSenders`), w.users.owner).send(["both@x.example"]);
            expect(property.status).toBe(400);
            expect(await listsOf(w)).toEqual({ blocked: [], safe: ["both@x.example"] });
        });

        it("Refuses (403) a delegate with read and update access changing either list, by PUT, property PUT or bulk PUT - but lets a full-object round trip through.", async () => {
            const w = await world({ blockedSenders: ["pest@bad.example"], safeSenders: ["friend@ok.example"] });
            const version = async () => (await ctx.findMailbox(w.mailbox.uid)).version;

            const blocked = await put(w, { blockedSenders: [] }, w.users.pat);
            const safe = await put(w, { safeSenders: ["friend@ok.example", "new@x.example"] }, w.users.pat);
            const property = await as(request(ctx.app()).put(`${w.url}/blockedSenders`), w.users.pat).send([]);
            const bulk = await as(request(ctx.app()).put(ctx.mailboxUrl), w.users.pat).send([{ uid: w.mailbox.uid, version: await version(), safeSenders: [] }]);
            expect([blocked.status, safe.status, property.status, bulk.status]).toEqual([403, 403, 403, 403]);
            expect(await listsOf(w)).toEqual({ blocked: ["pest@bad.example"], safe: ["friend@ok.example"] });

            const same = await put(w, { displayName: "Renamed", blockedSenders: ["PEST@bad.example"], safeSenders: ["friend@ok.example"] }, w.users.pat);
            expect(same.status).toBe(200);
            expect(same.body.displayName).toBe("Renamed");
        });

        it("Lets a full-access ('manager') delegate change them.", async () => {
            const w = await world();

            const res = await put(w, { blockedSenders: ["pest@bad.example"] }, w.users.manager);

            expect(res.status).toBe(200);
            expect((await listsOf(w)).blocked).toEqual(["pest@bad.example"]);
        });

        it("Drops null (a SQL row with none stored round-tripped back) instead of writing it.", async () => {
            const w = await world({ blockedSenders: ["pest@bad.example"] });

            const res = await put(w, { blockedSenders: null, safeSenders: null, displayName: "Kept lists" }, w.users.pat);

            expect(res.status).toBe(200);
            expect(res.body.displayName).toBe("Kept lists");
            expect((await listsOf(w)).blocked).toEqual(["pest@bad.example"]);
        });

        it("Does not let an administrator with no grant change them: the fields are dropped from a PUT and a property PUT is refused.", async () => {
            const w = await world({ blockedSenders: ["pest@bad.example"] });

            const res = await put(w, { blockedSenders: [], displayName: "Admin edit" }, w.users.admin);
            const property = await as(request(ctx.app()).put(`${w.url}/blockedSenders`), w.users.admin).send([]);

            expect(res.status).toBe(200);
            expect(property.status).toBe(403);
            expect((await listsOf(w)).blocked).toEqual(["pest@bad.example"]);
        });

        it("Accepts lists when a trusted administrator creates a mailbox, normalized, and refuses (400) an invalid list or an entry on both.", async () => {
            const admin = newUser(["admin"]);
            const create = (fields: Record<string, any>) =>
                as(request(ctx.app()).post(ctx.mailboxUrl), admin).send({
                    ownerUserUid: uuid.v4(),
                    primarySmtpAddress: `${uuid.v4()}@created.test`,
                    aliasAddresses: [],
                    displayName: "Created",
                    timezone: "UTC",
                    quotaBytes: 1_000_000,
                    usedBytes: 0,
                    ...fields,
                });

            const ok = await create({ blockedSenders: ["Pest@Bad.example", "bad.example"], safeSenders: null });
            expect(ok.status).toBeLessThan(300);
            expect(ok.body.blockedSenders).toEqual(["pest@bad.example", "@bad.example"]);
            expect((await create({ blockedSenders: "nope" })).status).toBe(400);
            expect((await create({ blockedSenders: ["a@x.example"], safeSenders: ["a@x.example"] })).status).toBe(400);
            expect((await create({})).status).toBeLessThan(300);
        });
    });

    describe("Mail filter rules: fromEquals and fromDomainEquals", () => {
        const create = async (w: World, conditions: unknown, user: any = w.users.owner) =>
            as(request(ctx.app()).post(ctx.filterRuleUrl), user).send({
                mailboxUid: w.mailbox.uid,
                name: "Sender rule",
                enabled: true,
                sequence: 0,
                stopProcessingRules: false,
                conditions,
                actions: [{ type: MailFilterActionType.MARK_AS_READ }],
            });

        it("Stores the conditions lowercased and de-duplicated, a domain without its @.", async () => {
            const w = await world();

            const res = await create(w, { fromEquals: ["Ann@X.example", "ann@x.example"], fromDomainEquals: ["@Corp.Example", "corp.example", "other.example"], subjectContains: ["Hi"] });

            expect(res.status).toBeLessThan(300);
            expect(res.body.conditions).toEqual({ fromEquals: ["ann@x.example"], fromDomainEquals: ["corp.example", "other.example"], subjectContains: ["Hi"] });
        });

        it("Drops a null condition, and leaves a rule with neither condition alone.", async () => {
            const w = await world();

            const nulls = await create(w, { fromEquals: null, fromDomainEquals: null, subjectContains: ["Hi"] });
            const plain = await create(w, { subjectContains: ["Hi"] });
            const notAnObject = await create(w, "everything");

            expect(nulls.status).toBeLessThan(300);
            expect(nulls.body.conditions).toEqual({ subjectContains: ["Hi"] });
            expect(plain.status).toBeLessThan(300);
            // Not this validation's to refuse: a conditions value that is no object is left to the model, never crashes it.
            expect(notAnObject.status).toBeLessThan(500);
        });

        it.each([
            [{ fromEquals: "ann@x.example" }],
            [{ fromEquals: ["Ann <ann@x.example>"] }],
            [{ fromEquals: ["x.example"] }],
            [{ fromEquals: [42] }],
            [{ fromEquals: Array.from({ length: 101 }, (_, i) => `u${i}@x.example`) }],
            [{ fromDomainEquals: ["ann@x.example"] }],
            [{ fromDomainEquals: "x.example" }],
            [{ fromDomainEquals: ["localhost"] }],
            [{ fromDomainEquals: [`${"a".repeat(250)}.example`] }],
        ])("Refuses (400) %j.", async (conditions) => {
            const w = await world();

            const res = await create(w, conditions);

            expect(res.status).toBe(400);
        });

        it("Validates an update the same way, by PUT and property PUT.", async () => {
            const w = await world();
            const rule = (await create(w, { fromEquals: ["ann@x.example"] })).body;

            const bad = await as(request(ctx.app()).put(`${ctx.filterRuleUrl}/${rule.uid}`), w.users.owner).send({ uid: rule.uid, version: rule.version, conditions: { fromEquals: ["nope"] } });
            const badProperty = await as(request(ctx.app()).put(`${ctx.filterRuleUrl}/${rule.uid}/conditions`), w.users.owner).send({ fromDomainEquals: ["nope@x"] });
            const good = await as(request(ctx.app()).put(`${ctx.filterRuleUrl}/${rule.uid}`), w.users.owner).send({ uid: rule.uid, version: rule.version, conditions: { fromEquals: ["BOB@x.example"] } });

            expect(bad.status).toBe(400);
            expect(badProperty.status).toBe(400);
            expect(good.status).toBe(200);
            expect(good.body.conditions).toEqual({ fromEquals: ["bob@x.example"] });
        });
    });
}
