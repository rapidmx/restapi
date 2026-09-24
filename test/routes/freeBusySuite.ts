///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// "Find a time": `POST /calendar-events/free-busy` and the `Mailbox.freeBusyVisibility` setting behind it, identical on both
// backends. `test/routes/{mongo,sql}/FreeBusyRoute.test.ts` supply a started server and raw row helpers. Every case goes through
// real HTTP against a real database.
import { request } from "@rapidrest/service-core/test";
import { ACLAction } from "@rapidrest/service-core";
import { JWTUtils } from "@rapidrest/core";
import * as uuid from "uuid";
import {
    AttendeeResponseStatus,
    AttendeeRole,
    BusyStatus,
    CalendarEventStatus,
    FolderType,
    RecipientType,
    RecurrenceFrequency,
    type FreeBusyVisibility,
} from "../../src/models/types.js";
import { FREE_BUSY_LIMITS, FREE_BUSY_MAX_ADDRESSES, FREE_BUSY_MAX_WINDOW_MS } from "../../src/util/FreeBusyLookupUtils.js";

type AclRecords = { userOrRoleId: string; actions: string[] }[];

export interface FreeBusySuiteContext {
    config: any;
    app: () => any;
    calendarUrl: string;
    mailboxUrl: string;
    /** Saves a mailbox with `fields` over defaults and an ACL carrying full access for its owner plus `records`. */
    saveMailbox: (fields: Record<string, any>, records?: AclRecords) => Promise<any>;
    /** Saves a folder under `mailboxUid` (type `CALENDAR` unless `fields` say otherwise) with an ACL that inherits from the mailbox's, plus `records`. */
    saveFolder: (mailboxUid: string, fields?: Record<string, any>, records?: AclRecords) => Promise<any>;
    saveEvent: (mailboxUid: string, folderUid: string, fields?: Record<string, any>) => Promise<any>;
    /** Leaves the mailbox's visibility unset (absent on Mongo, `null` on SQL), as a row written before the field existed. */
    clearVisibility: (mailboxUid: string) => Promise<void>;
    findMailbox: (uid: string) => Promise<any>;
}

const HOUR = 60 * 60 * 1000;
/** A moment in January 2031, so every case reads against fixed dates. */
const at = (day: number, hour: number = 0): Date => new Date(Date.UTC(2031, 0, day, hour));
const iso = (day: number, hour: number = 0): string => at(day, hour).toISOString();
/** The window most cases ask about: January 5th to 12th. */
const WINDOW = { start: iso(5), end: iso(12) };

const CALLERS = ["alice", "bob", "carol", "dave", "fiona", "hank", "pat", "manager", "erin", "admin"] as const;
type Caller = (typeof CALLERS)[number];
type Answer = "available" | "restricted" | "unknown";

/** What each caller is told about alice's mailbox under each visibility - see `Mailbox.freeBusyVisibility`. */
const EXPECTED: Record<FreeBusyVisibility, Record<Caller, Answer>> = {
    // alice: the owner. pat: read and update access. bob: same domain. carol: another domain. dave: read access on the mailbox. fiona: freebusy access on the calendar folder
    // only. hank: update access only (no read). manager: full access. erin: signed in, owns no mailbox. admin: trusted role, owns no mailbox.
    domain: { alice: "available", bob: "available", carol: "restricted", dave: "available", fiona: "available", hank: "restricted", pat: "available", manager: "available", erin: "unknown", admin: "restricted" },
    shared: { alice: "available", bob: "restricted", carol: "restricted", dave: "available", fiona: "available", hank: "restricted", pat: "available", manager: "available", erin: "unknown", admin: "restricted" },
    nobody: { alice: "available", bob: "restricted", carol: "restricted", dave: "restricted", fiona: "restricted", hank: "restricted", pat: "restricted", manager: "available", erin: "unknown", admin: "restricted" },
    everyone: { alice: "available", bob: "available", carol: "available", dave: "available", fiona: "available", hank: "available", pat: "available", manager: "available", erin: "available", admin: "available" },
};

export function freeBusySuite(ctx: FreeBusySuiteContext): void {
    const newUser = (roles: string[] = []): any => ({ uid: uuid.v4(), roles, elevated: Date.now() });
    const tokenFor = (user: any): string => JWTUtils.createTokenSync(ctx.config.get("auth"), user);
    const as = (req: any, user?: any): any => (user ? req.set("Authorization", "jwt " + tokenFor(user)) : req);
    const post = (body: unknown, user?: any) => as(request(ctx.app()).post(`${ctx.calendarUrl}/free-busy`), user).send(body as any);
    const busyOf = (res: any, address: string): any => res.body.results.find((entry: any) => entry.address === address);

    interface World {
        users: Record<Caller, any>;
        corp: string;
        other: string;
        /** alice's mailbox, its address and its alias. */
        alice: any;
        address: string;
        alias: string;
        /** alice's calendar folder. */
        folder: any;
        ask: (user: any, addresses?: string[], window?: { start: string; end: string }) => Promise<any>;
    }

    /** alice (her mailbox at `alice@corp`, an alias, one calendar folder) and the callers `EXPECTED` describes. */
    const world = async (visibility?: FreeBusyVisibility): Promise<World> => {
        const tag: string = uuid.v4().slice(0, 8);
        const corp = `corp-${tag}.test`;
        const other = `other-${tag}.test`;
        const users = Object.fromEntries(CALLERS.map((name) => [name, newUser(name === "admin" ? ["admin"] : [])])) as Record<Caller, any>;
        const alice = await ctx.saveMailbox(
            {
                ownerUserUid: users.alice.uid,
                displayName: "Alice",
                primarySmtpAddress: `alice@${corp}`,
                aliasAddresses: [`ally@${corp}`],
                ...(visibility ? { freeBusyVisibility: visibility } : {}),
            },
            [
                { userOrRoleId: users.dave.uid, actions: [ACLAction.READ] },
                { userOrRoleId: users.hank.uid, actions: [ACLAction.UPDATE] },
                { userOrRoleId: users.pat.uid, actions: [ACLAction.READ, ACLAction.UPDATE] },
                { userOrRoleId: users.manager.uid, actions: [ACLAction.FULL] },
            ],
        );
        await ctx.saveMailbox({ ownerUserUid: users.bob.uid, displayName: "Bob", primarySmtpAddress: `bob@${corp}` });
        for (const name of ["carol", "dave", "fiona", "hank", "pat", "manager"] as const) {
            await ctx.saveMailbox({ ownerUserUid: users[name].uid, displayName: name, primarySmtpAddress: `${name}@${other}` });
        }
        const folder = await ctx.saveFolder(alice.uid, { name: "Calendar" }, [{ userOrRoleId: users.fiona.uid, actions: ["freebusy"] }]);
        return {
            users,
            corp,
            other,
            alice,
            address: `alice@${corp}`,
            alias: `ally@${corp}`,
            folder,
            ask: (user, addresses = [`alice@${corp}`], window = WINDOW) => post({ addresses, ...window }, user),
        };
    };

    /** An event of alice's - a busy hour with a title, location and attendees that must never come back. */
    const event = (w: World, fields: Record<string, any> = {}, folderUid: string = w.folder.uid) =>
        ctx.saveEvent(w.alice.uid, folderUid, {
            title: "Secret Board Meeting",
            location: "The Vault",
            startDate: at(6, 10),
            endDate: at(6, 11),
            attendees: [{ address: "ceo@example.com", displayName: "The CEO", role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.ACCEPTED, isOrganizer: false }],
            ...fields,
        });

    const answerFor = async (w: World, user: any): Promise<any> => {
        const res = await w.ask(user);
        expect(res.status).toBe(200);
        return res.body.results[0];
    };

    describe("POST /free-busy - who may see whose", () => {
        for (const visibility of ["domain", "shared", "nobody", "everyone"] as FreeBusyVisibility[]) {
            it(`Answers each caller as the owner's "${visibility}" setting says: the owner, a colleague, another domain, a caller with access, a caller with none, and a caller with no mailbox.`, async () => {
                const w = await world(visibility);
                await event(w);

                for (const name of CALLERS) {
                    const res = await w.ask(w.users[name]);
                    expect(res.status, `${visibility}/${name}`).toBe(200);
                    const entry = res.body.results[0];
                    expect(entry.status, `${visibility}/${name}`).toBe(EXPECTED[visibility][name]);
                    expect(entry.busy, `${visibility}/${name}`).toEqual(
                        entry.status === "available" ? [{ start: iso(6, 10), end: iso(6, 11), tentative: false }] : [],
                    );
                }
            });
        }

        it("Reads a mailbox that has no visibility stored - one written before the setting existed - as domain.", async () => {
            const w = await world("nobody");
            await event(w);
            await ctx.clearVisibility(w.alice.uid);

            expect((await answerFor(w, w.users.bob)).status).toBe("available");
            expect((await answerFor(w, w.users.carol)).status).toBe("restricted");
            expect((await answerFor(w, w.users.erin)).status).toBe("unknown");
        });

        it("Defaults a new mailbox to domain.", async () => {
            const w = await world();
            await event(w);

            expect((await ctx.findMailbox(w.alice.uid)).freeBusyVisibility).toBe("domain");
            expect((await answerFor(w, w.users.bob)).status).toBe("available");
            expect((await answerFor(w, w.users.carol)).status).toBe("restricted");
        });

        it("Answers 401 to a caller who isn't signed in.", async () => {
            const w = await world("everyone");

            const res = await post({ addresses: [w.address], ...WINDOW });

            expect(res.status).toBe(401);
        });

        it("Never lets a trusted role widen what it sees: an administrator with no grant gets what any stranger gets.", async () => {
            const w = await world("nobody");
            await event(w);

            const entry = await answerFor(w, w.users.admin);

            expect(entry).toEqual({ address: w.address, status: "restricted", busy: [] });
        });

        it("Tells a caller who could not find the address in the directory anyway nothing more than for an address that is not here.", async () => {
            const w = await world("nobody");
            const missing = `ghost@${w.corp}`;

            const stranger = await w.ask(w.users.erin, [w.address, missing]);
            const colleague = await w.ask(w.users.carol, [w.address, missing]);

            expect(stranger.body.results).toEqual([
                { address: w.address, status: "unknown", busy: [] },
                { address: missing, status: "unknown", busy: [] },
            ]);
            expect(colleague.body.results).toEqual([
                { address: w.address, status: "restricted", busy: [] },
                { address: missing, status: "unknown", busy: [] },
            ]);
        });

        it("Always shows the caller their own mailbox, whatever it says, and another's only as its setting allows.", async () => {
            const w = await world("nobody");
            const own = await w.ask(w.users.bob, [`bob@${w.corp}`, w.address]);

            expect(own.body.results.map((entry: any) => entry.status)).toEqual(["available", "restricted"]);
        });
    });

    describe("POST /free-busy - what is reported", () => {
        it("Reports the windows and nothing else: no title, location, attendee, organizer or uid.", async () => {
            const w = await world("everyone");
            await event(w, { organizer: { address: "boss@example.com", type: RecipientType.TO } });

            const res = await w.ask(w.users.bob);

            expect(res.status).toBe(200);
            expect(Object.keys(res.body).sort()).toEqual(["end", "results", "start"]);
            expect(res.body.start).toBe(WINDOW.start);
            expect(res.body.end).toBe(WINDOW.end);
            expect(Object.keys(res.body.results[0]).sort()).toEqual(["address", "busy", "status"]);
            expect(Object.keys(res.body.results[0].busy[0]).sort()).toEqual(["end", "start", "tentative"]);
            const text = JSON.stringify(res.body);
            for (const secret of ["Secret", "Vault", "CEO", "boss@", ...[w.alice.uid]]) {
                expect(text).not.toContain(secret);
            }
        });

        it("Reports free time as an available mailbox with no busy windows, also with no calendar folder at all.", async () => {
            const w = await world("everyone");
            const bare = await ctx.saveMailbox({ ownerUserUid: uuid.v4(), primarySmtpAddress: `bare@${w.corp}` });

            const res = await w.ask(w.users.bob, [w.address, `bare@${w.corp}`]);

            expect(res.body.results).toEqual([
                { address: w.address, status: "available", busy: [] },
                { address: `bare@${w.corp}`, status: "available", busy: [] },
            ]);
            expect(bare.uid).toBeDefined();
        });

        it("Clips a window to the one asked for, and leaves out events outside it.", async () => {
            const w = await world("everyone");
            await event(w, { startDate: at(4, 22), endDate: at(5, 2) });
            await event(w, { startDate: at(11, 23), endDate: at(12, 3) });
            await event(w, { startDate: at(3, 9), endDate: at(3, 10) });
            await event(w, { startDate: at(20, 9), endDate: at(20, 10) });

            const res = await w.ask(w.users.bob);

            expect(busyOf(res, w.address).busy).toEqual([
                { start: iso(5), end: iso(5, 2), tentative: false },
                { start: iso(11, 23), end: iso(12), tentative: false },
            ]);
        });

        it("Merges overlapping and touching events into one window, sorted.", async () => {
            const w = await world("everyone");
            await event(w, { startDate: at(7, 15), endDate: at(7, 16) });
            await event(w, { startDate: at(6, 10), endDate: at(6, 12) });
            await event(w, { startDate: at(6, 11), endDate: at(6, 13) });
            await event(w, { startDate: at(6, 13), endDate: at(6, 14) });

            const res = await w.ask(w.users.bob);

            expect(busyOf(res, w.address).busy).toEqual([
                { start: iso(6, 10), end: iso(6, 14), tentative: false },
                { start: iso(7, 15), end: iso(7, 16), tentative: false },
            ]);
        });

        it("Expands a recurring series, skips its exceptions and takes a moved occurrence where it was moved to.", async () => {
            const w = await world("everyone");
            const icalUid = uuid.v4();
            await event(w, {
                icalUid,
                startDate: at(6, 9),
                endDate: at(6, 10),
                recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, count: 5, exceptions: [at(13, 9)] },
            });
            await event(w, { icalUid, recurrenceId: at(20, 9), startDate: at(21, 15), endDate: at(21, 16) });
            // A series that ended before the window, and one that never ends and reaches it from long ago.
            await event(w, {
                startDate: at(-20, 9),
                endDate: at(-20, 10),
                recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, until: at(-10, 9), exceptions: [] },
            });
            await event(w, {
                startDate: new Date(Date.UTC(2030, 0, 1, 18)),
                endDate: new Date(Date.UTC(2030, 0, 1, 19)),
                recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, exceptions: [] },
            });

            const res = await w.ask(w.users.bob, [w.address], { start: iso(5), end: iso(24) });

            const all: any[] = busyOf(res, w.address).busy;
            expect(all.filter((window) => new Date(window.start).getUTCHours() !== 18)).toEqual([
                { start: iso(6, 9), end: iso(6, 10), tentative: false },
                { start: iso(21, 15), end: iso(21, 16), tentative: false },
            ]);
            // The daily series from 2030 is busy every evening of the window.
            expect(all.filter((window) => new Date(window.start).getUTCHours() === 18)).toHaveLength(19);
        });

        it("Leaves out cancelled events, free events and deleted events, and a cancelled occurrence of a series.", async () => {
            const w = await world("everyone");
            await event(w, { status: CalendarEventStatus.CANCELLED });
            await event(w, { busyStatus: BusyStatus.FREE, startDate: at(6, 12), endDate: at(6, 13) });
            await event(w, { deleted: true, startDate: at(6, 14), endDate: at(6, 15) });
            const icalUid = uuid.v4();
            await event(w, {
                icalUid,
                startDate: at(8, 9),
                endDate: at(8, 10),
                recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, count: 2, exceptions: [] },
            });
            await event(w, { icalUid, status: CalendarEventStatus.CANCELLED, recurrenceId: at(8, 9), startDate: at(8, 9), endDate: at(8, 10) });

            const res = await w.ask(w.users.bob);

            expect(busyOf(res, w.address).busy).toEqual([{ start: iso(9, 9), end: iso(9, 10), tentative: false }]);
        });

        it("Counts every calendar folder of the mailbox, and no other folder and no deleted one.", async () => {
            const w = await world("everyone");
            const second = await ctx.saveFolder(w.alice.uid, { name: "Team" });
            const gone = await ctx.saveFolder(w.alice.uid, { name: "Old", deleted: true });
            const tasks = await ctx.saveFolder(w.alice.uid, { name: "Elsewhere", type: FolderType.TASKS });
            await event(w, { startDate: at(6, 10), endDate: at(6, 11) });
            await event(w, { startDate: at(7, 10), endDate: at(7, 11) }, second.uid);
            await event(w, { startDate: at(8, 10), endDate: at(8, 11) }, gone.uid);
            await event(w, { startDate: at(9, 10), endDate: at(9, 11) }, tasks.uid);
            // Another mailbox's calendar is not this one's.
            const bob = await ctx.saveMailbox({ ownerUserUid: uuid.v4(), primarySmtpAddress: `carol-${uuid.v4()}@${w.corp}` });
            const bobFolder = await ctx.saveFolder(bob.uid, { name: "Calendar" });
            await ctx.saveEvent(bob.uid, bobFolder.uid, { startDate: at(10, 10), endDate: at(10, 11) });

            const res = await w.ask(w.users.bob);

            expect(busyOf(res, w.address).busy.map((window: any) => window.start)).toEqual([iso(6, 10), iso(7, 10)]);
        });

        it("Leaves out what the owner declined, and marks tentative events and unanswered or tentatively answered invitations tentative.", async () => {
            const w = await world("everyone");
            const invited = (address: string, responseStatus: AttendeeResponseStatus, isOrganizer: boolean = false) => ({
                address,
                role: AttendeeRole.REQUIRED,
                responseStatus,
                isOrganizer,
            });
            const organizer = { address: "boss@example.com", type: RecipientType.TO };
            await event(w, { startDate: at(6, 8), endDate: at(6, 9), organizer, attendees: [invited(w.alias, AttendeeResponseStatus.DECLINED)] });
            await event(w, { startDate: at(6, 10), endDate: at(6, 11), organizer, attendees: [invited(w.address, AttendeeResponseStatus.NEEDS_ACTION)] });
            await event(w, { startDate: at(6, 12), endDate: at(6, 13), organizer, attendees: [invited(w.alias.toUpperCase(), AttendeeResponseStatus.TENTATIVE)] });
            await event(w, { startDate: at(6, 14), endDate: at(6, 15), organizer, attendees: [invited(w.address, AttendeeResponseStatus.ACCEPTED)] });
            await event(w, { startDate: at(6, 16), endDate: at(6, 17), busyStatus: BusyStatus.TENTATIVE });
            // Organized by the owner, who never answers: not tentative however the attendee entry reads.
            await event(w, {
                startDate: at(6, 18),
                endDate: at(6, 19),
                organizer: { address: w.address, type: RecipientType.TO },
                attendees: [invited(w.address, AttendeeResponseStatus.NEEDS_ACTION, true), invited("guest@example.com", AttendeeResponseStatus.DECLINED)],
            });
            // Another attendee's answer says nothing about the owner.
            await event(w, { startDate: at(6, 20), endDate: at(6, 21), organizer, attendees: [invited("guest@example.com", AttendeeResponseStatus.DECLINED)] });

            const res = await w.ask(w.users.bob);

            expect(busyOf(res, w.address).busy).toEqual([
                { start: iso(6, 10), end: iso(6, 11), tentative: true },
                { start: iso(6, 12), end: iso(6, 13), tentative: true },
                { start: iso(6, 14), end: iso(6, 15), tentative: false },
                { start: iso(6, 16), end: iso(6, 17), tentative: true },
                { start: iso(6, 18), end: iso(6, 19), tentative: false },
                { start: iso(6, 20), end: iso(6, 21), tentative: false },
            ]);
        });

        it("Counts a private or confidential event as busy like any other.", async () => {
            const w = await world("everyone");
            await event(w, { visibility: "private" });

            expect((await answerFor(w, w.users.bob)).busy).toHaveLength(1);
        });
    });

    describe("POST /free-busy - addresses", () => {
        it("Answers unknown for an address that is not a local mailbox, one entry per address in the order asked.", async () => {
            const w = await world("everyone");

            // An underscore or percent sign in an address is only ever itself when the alias is looked up, never a pattern.
            const res = await w.ask(w.users.bob, ["someone@elsewhere.example", w.address, "nobody-here@" + w.corp, `100%_sure@${w.corp}`]);

            expect(res.body.results.map((entry: any) => [entry.address, entry.status])).toEqual([
                ["someone@elsewhere.example", "unknown"],
                [w.address, "available"],
                [`nobody-here@${w.corp}`, "unknown"],
                [`100%_sure@${w.corp}`, "unknown"],
            ]);
        });

        it("Finds a mailbox by its alias, answering under the address that was asked.", async () => {
            const w = await world("everyone");
            await event(w);

            const res = await w.ask(w.users.bob, [w.alias]);

            expect(res.body.results).toEqual([{ address: w.alias, status: "available", busy: [{ start: iso(6, 10), end: iso(6, 11), tentative: false }] }]);
        });

        it("Normalizes and de-duplicates the addresses.", async () => {
            const w = await world("everyone");

            const res = await w.ask(w.users.bob, [` ${w.address.toUpperCase()} `, w.address, w.alias, w.alias.toUpperCase()]);

            expect(res.body.results.map((entry: any) => entry.address)).toEqual([w.address, w.alias]);
        });

        it("Answers 50 addresses in one request.", async () => {
            const w = await world("everyone");
            const addresses = [w.address, ...Array.from({ length: FREE_BUSY_MAX_ADDRESSES - 1 }, (_, i) => `person${i}@elsewhere.example`)];

            const res = await w.ask(w.users.bob, addresses);

            expect(res.status).toBe(200);
            expect(res.body.results).toHaveLength(FREE_BUSY_MAX_ADDRESSES);
        });
    });

    describe("POST /free-busy - bad requests", () => {
        it("Answers 400 for a missing or malformed body, address list or window.", async () => {
            const w = await world("everyone");
            const bob = w.users.bob;
            const good = { addresses: [w.address], ...WINDOW };
            const cases: [string, unknown][] = [
                ["no body", undefined],
                ["no addresses", { start: WINDOW.start, end: WINDOW.end }],
                ["addresses not a list", { ...good, addresses: w.address }],
                ["no address", { ...good, addresses: [] }],
                ["too many addresses", { ...good, addresses: Array.from({ length: FREE_BUSY_MAX_ADDRESSES + 1 }, (_, i) => `p${i}@x.example`) }],
                ["a name with the address", { ...good, addresses: ["Alice <alice@corp.test>"] }],
                ["not an address", { ...good, addresses: ["alice"] }],
                ["not a string address", { ...good, addresses: [42] }],
                ["no start", { ...good, start: undefined }],
                ["start not a date", { ...good, start: "next tuesday" }],
                ["end not a date", { ...good, end: "2031-13-01T00:00:00Z" }],
                ["end before start", { ...good, start: WINDOW.end, end: WINDOW.start }],
                ["end at start", { ...good, end: WINDOW.start }],
                ["a window over 31 days", { ...good, end: new Date(new Date(WINDOW.start).getTime() + FREE_BUSY_MAX_WINDOW_MS + HOUR).toISOString() }],
            ];
            for (const [name, body] of cases) {
                const res = await post(body, bob);
                expect(res.status, name).toBe(400);
            }
        });

        it("Accepts a window of exactly 31 days.", async () => {
            const w = await world("everyone");

            const res = await w.ask(w.users.bob, [w.address], { start: WINDOW.start, end: new Date(new Date(WINDOW.start).getTime() + FREE_BUSY_MAX_WINDOW_MS).toISOString() });

            expect(res.status).toBe(200);
        });
    });

    describe("POST /free-busy - bounded reads", () => {
        const withLimits = async (limits: Partial<typeof FREE_BUSY_LIMITS>, run: () => Promise<void>): Promise<void> => {
            const saved = { ...FREE_BUSY_LIMITS };
            Object.assign(FREE_BUSY_LIMITS, limits);
            try {
                await run();
            } finally {
                Object.assign(FREE_BUSY_LIMITS, saved);
            }
        };

        it("Reports a mailbox whose events are too many to read as unknown, never as free.", async () => {
            const w = await world("everyone");
            for (let hour = 0; hour < 5; hour++) {
                await event(w, { startDate: at(6, 2 * hour), endDate: at(6, 2 * hour + 1) });
            }

            await withLimits({ pageSize: 2, maxPages: 2 }, async () => {
                expect((await answerFor(w, w.users.bob)).status).toBe("unknown");
            });
            await withLimits({ pageSize: 2, maxPages: 3 }, async () => {
                expect((await answerFor(w, w.users.bob)).busy).toHaveLength(5);
            });
        });

        it("Reports a mailbox whose recurring series or moved occurrences are too many to read as unknown as well.", async () => {
            const w = await world("everyone");
            for (let i = 0; i < 3; i++) {
                await event(w, {
                    startDate: at(-20 - i, 9),
                    endDate: at(-20 - i, 10),
                    recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, until: at(-10), exceptions: [] },
                });
            }
            await withLimits({ pageSize: 3, maxPages: 1 }, async () => {
                expect((await answerFor(w, w.users.bob)).status).toBe("unknown");
            });

            const moved = await world("everyone");
            for (let i = 0; i < 3; i++) {
                await event(moved, { icalUid: uuid.v4(), recurrenceId: at(30 + i, 9), startDate: at(30 + i, 9), endDate: at(30 + i, 10) });
            }
            await withLimits({ pageSize: 3, maxPages: 1 }, async () => {
                expect((await answerFor(moved, moved.users.bob)).status).toBe("unknown");
            });
        });

        it("Reports a mailbox with more busy windows than the response allows as unknown.", async () => {
            const w = await world("everyone");
            await event(w, { startDate: at(6, 10), endDate: at(6, 11) });
            await event(w, { startDate: at(7, 10), endDate: at(7, 11) });

            await withLimits({ maxWindows: 1 }, async () => {
                expect((await answerFor(w, w.users.bob)).status).toBe("unknown");
            });
            await withLimits({ maxWindows: 2 }, async () => {
                expect((await answerFor(w, w.users.bob)).status).toBe("available");
            });
        });
    });

    describe("Mailbox.freeBusyVisibility - who may change it", () => {
        const put = (w: World, body: Record<string, any>, user: any) => as(request(ctx.app()).put(`${ctx.mailboxUrl}/${w.alice.uid}`), user).send({ uid: w.alice.uid, ...body });
        const stored = async (w: World) => (await ctx.findMailbox(w.alice.uid)).freeBusyVisibility;
        const version = async (w: World) => (await ctx.findMailbox(w.alice.uid)).version;

        it("Lets the owner change it and reads it back.", async () => {
            const w = await world("domain");

            const res = await put(w, { version: await version(w), freeBusyVisibility: "nobody" }, w.users.alice);
            expect(res.status).toBe(200);
            expect(res.body.freeBusyVisibility).toBe("nobody");

            expect(await stored(w)).toBe("nobody");
            const read = await as(request(ctx.app()).get(`${ctx.mailboxUrl}/${w.alice.uid}`), w.users.alice);
            expect(read.body.freeBusyVisibility).toBe("nobody");
            expect((await answerFor(w, w.users.bob)).status).toBe("restricted");
        });

        it("Lets a delegate with full access change it.", async () => {
            const w = await world("domain");

            const res = await put(w, { version: await version(w), freeBusyVisibility: "everyone" }, w.users.manager);

            expect(res.status).toBe(200);
            expect(await stored(w)).toBe("everyone");
        });

        it("Refuses (403) a delegate with read and update access, but not full access, widening - or changing - it, by PUT, property PUT or bulk PUT.", async () => {
            const w = await world("nobody");

            const changed = await put(w, { version: await version(w), freeBusyVisibility: "everyone" }, w.users.pat);
            expect(changed.status).toBe(403);
            const property = await as(request(ctx.app()).put(`${ctx.mailboxUrl}/${w.alice.uid}/freeBusyVisibility`), w.users.pat).send("everyone");
            expect(property.status).toBe(403);
            const bulk = await as(request(ctx.app()).put(ctx.mailboxUrl), w.users.pat).send([{ uid: w.alice.uid, version: await version(w), freeBusyVisibility: "everyone" }]);
            expect(bulk.status).toBe(403);

            expect(await stored(w)).toBe("nobody");
        });

        it("Lets a delegate with read and update access save the mailbox with the value unchanged, so a full-object round trip keeps working.", async () => {
            const w = await world("nobody");

            const res = await put(w, { version: await version(w), freeBusyVisibility: "nobody", displayName: "Alice A." }, w.users.pat);

            expect(res.status).toBe(200);
            expect(res.body.displayName).toBe("Alice A.");
            expect(await stored(w)).toBe("nobody");
        });

        it("Reads the default as unchanged for a row with no value stored, and null as no change.", async () => {
            const w = await world("nobody");
            await ctx.clearVisibility(w.alice.uid);

            const same = await put(w, { version: await version(w), freeBusyVisibility: "domain" }, w.users.pat);
            expect(same.status).toBe(200);
            const nothing = await put(w, { version: await version(w), freeBusyVisibility: null, displayName: "Alice B." }, w.users.pat);
            expect(nothing.status).toBe(200);
            expect(nothing.body.displayName).toBe("Alice B.");
            const widen = await put(w, { version: await version(w), freeBusyVisibility: "everyone" }, w.users.pat);
            expect(widen.status).toBe(403);
        });

        it("Refuses (400) a value that is not one of the four, whoever asks.", async () => {
            const w = await world("domain");

            for (const value of ["bogus", "Nobody", "", 5, true, {}, ["nobody"]]) {
                const res = await put(w, { version: await version(w), freeBusyVisibility: value }, w.users.alice);
                expect(res.status, JSON.stringify(value)).toBe(400);
            }
            const property = await as(request(ctx.app()).put(`${ctx.mailboxUrl}/${w.alice.uid}/freeBusyVisibility`), w.users.alice).send("bogus");
            expect(property.status).toBe(400);
            expect(await stored(w)).toBe("domain");
        });

        it("Lets the owner change it by property PUT.", async () => {
            const w = await world("domain");

            const res = await as(request(ctx.app()).put(`${ctx.mailboxUrl}/${w.alice.uid}/freeBusyVisibility`), w.users.alice).send("shared");

            expect(res.status).toBe(200);
            expect(await stored(w)).toBe("shared");
        });

        it("Does not let an administrator with no grant on the mailbox change it: the field is dropped from a PUT and a property PUT is refused (403).", async () => {
            const w = await world("nobody");

            const res = await put(w, { version: await version(w), freeBusyVisibility: "everyone", displayName: "Alice C." }, w.users.admin);
            expect(res.status).toBe(200);
            expect(res.body.displayName).toBe("Alice C.");
            const property = await as(request(ctx.app()).put(`${ctx.mailboxUrl}/${w.alice.uid}/freeBusyVisibility`), w.users.admin).send("everyone");
            expect(property.status).toBe(403);

            expect(await stored(w)).toBe("nobody");
        });

        it("Reads a mailbox with no value stored as domain, in a list too.", async () => {
            const w = await world("nobody");
            await ctx.clearVisibility(w.alice.uid);

            const one = await as(request(ctx.app()).get(`${ctx.mailboxUrl}/${w.alice.uid}`), w.users.alice);
            const list = await as(request(ctx.app()).get(ctx.mailboxUrl), w.users.alice);

            expect(one.body.freeBusyVisibility).toBe("domain");
            expect(list.body.map((mailbox: any) => mailbox.freeBusyVisibility)).toEqual(["domain"]);
        });

        it("Accepts a value when a trusted administrator creates a mailbox, defaults it, and refuses one that is not a choice (400).", async () => {
            const admin = newUser(["admin"]);
            const owner = newUser();
            const create = (fields: Record<string, any>) =>
                as(request(ctx.app()).post(ctx.mailboxUrl), admin).send({
                    ownerUserUid: owner.uid,
                    primarySmtpAddress: `${uuid.v4()}@created.test`,
                    aliasAddresses: [],
                    displayName: "Created",
                    timezone: "UTC",
                    quotaBytes: 1_000_000,
                    usedBytes: 0,
                    ...fields,
                });

            const chosen = await create({ freeBusyVisibility: "shared" });
            expect(chosen.status).toBeLessThan(300);
            expect(chosen.body.freeBusyVisibility).toBe("shared");
            const defaulted = await create({});
            expect(defaulted.status).toBeLessThan(300);
            expect(defaulted.body.freeBusyVisibility).toBe("domain");
            const unset = await create({ freeBusyVisibility: null });
            expect(unset.status).toBeLessThan(300);
            expect(unset.body.freeBusyVisibility).toBe("domain");
            const bad = await create({ freeBusyVisibility: "bogus" });
            expect(bad.status).toBe(400);
        });
    });
}
