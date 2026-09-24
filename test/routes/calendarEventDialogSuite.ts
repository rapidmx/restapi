///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// What the calendar event dialog needs of `/calendar-events`, identical on both backends: the rich-text description (sanitized on every
// write), visibility (a private event shown to a shared-calendar reader only as a busy block), guest permissions, and a guest's request
// to change an event (`POST /:id/request-change`). `test/routes/{mongo,sql}/CalendarEventRoute.test.ts` supply a started server, the
// recording transport and raw row access; every case goes through real HTTP against a real database.
import { request } from "@rapidrest/service-core/test";
import { NotificationUtils } from "@rapidrest/service-core";
import * as uuid from "uuid";
import { AttendeeResponseStatus, AttendeeRole, FolderType, RecipientType } from "../../src/models/types.js";
import { MAX_EVENT_DESCRIPTION_HTML_LENGTH, MAX_EVENT_DESCRIPTION_LENGTH } from "../../src/util/EventDescriptionUtils.js";
import type { CalendarInviteSuiteContext } from "./calendarInviteSuite.js";

export interface CalendarEventDialogSuiteContext extends CalendarInviteSuiteContext {
    /** The uid of the user `otherToken` is for. */
    otherUid: string;
    /** Adds an ACL record granting `userUid` `actions` on the folder (before anything has read the folder's ACL). */
    grantFolder: (folderUid: string, userUid: string, actions: string[]) => Promise<void>;
    findEvent: (uid: string) => Promise<any>;
    shareLinksUrl: string;
}

const HOUR = 60 * 60 * 1000;
const BOSS = "boss@boss.example.com";

/** A sent message as text with quoted-printable escapes undone and folded calendar lines joined. */
const unfolded = (raw: Buffer): string => raw.toString().replace(/=\r?\n/g, "").replace(/=3D/g, "=").replace(/\r\n /g, "");

const guest = (address: string, extra: any = {}): any => ({
    address,
    role: AttendeeRole.REQUIRED,
    responseStatus: AttendeeResponseStatus.NEEDS_ACTION,
    isOrganizer: false,
    ...extra,
});

export function calendarEventDialogSuite(ctx: CalendarEventDialogSuiteContext): void {
    const as = (token: string) => (req: any) => req.set("Authorization", "jwt " + token);
    const owner = as(ctx.ownerToken);
    const other = as(ctx.otherToken);
    const start = new Date(Date.now() + 48 * HOUR);
    const end = new Date(start.getTime() + HOUR);

    /** A mailbox of the owner with a Calendar folder. */
    const setup = async () => {
        const mailbox = await ctx.createMailbox(ctx.ownerUid);
        const calendar = await ctx.createFolder(mailbox.uid, FolderType.CALENDAR);
        return { mailbox, calendar, me: mailbox.primarySmtpAddress as string };
    };

    const create = async (calendarUid: string, mailboxUid: string, body: any, as_: (req: any) => any = owner) =>
        await as_(request(ctx.app()).post(ctx.baseUrl)).send({
            folderUid: calendarUid,
            mailboxUid,
            title: "Planning",
            startDate: start.toISOString(),
            endDate: end.toISOString(),
            timezone: "UTC",
            organizer: { address: "", type: "to" },
            attendees: [],
            icalUid: uuid.v4(),
            ...body,
        });

    describe("Description, visibility and guest permissions on create and update", () => {
        it("Stores a new event with the defaults: no description, default visibility, guests can't modify, can invite and can see the list.", async () => {
            const { mailbox, calendar } = await setup();
            const result = await create(calendar.uid, mailbox.uid, {});

            expect(result.status).toBe(200);
            const row = await ctx.findEvent(result.body.uid);
            expect(row.description ?? undefined).toBeUndefined();
            expect(row.descriptionHtml ?? undefined).toBeUndefined();
            expect(row.visibility).toBe("default");
            expect(row.guestsCanModify).toBe(false);
            expect(row.guestsCanInviteOthers).toBe(true);
            expect(row.guestsCanSeeGuestList).toBe(true);
        });

        it("Sanitizes the description HTML on create, whatever the client sent, and derives the plain text from it.", async () => {
            const { mailbox, calendar } = await setup();
            const result = await create(calendar.uid, mailbox.uid, {
                descriptionHtml: '<p onclick="steal()">Agenda: <b>budget</b> <a href="javascript:alert(1)">bad</a> <a href="https://example.com/x">good</a></p><script>alert(1)</script><img src=x onerror=alert(1)>',
            });

            expect(result.status).toBe(200);
            expect(result.body.descriptionHtml).toBe('<p>Agenda: <b>budget</b> bad <a href="https://example.com/x" rel="noopener noreferrer">good</a></p>');
            expect(result.body.description).toBe("Agenda: budget bad good (https://example.com/x)");
            const row = await ctx.findEvent(result.body.uid);
            expect(row.descriptionHtml).toBe(result.body.descriptionHtml);
            expect(row.description).toBe(result.body.description);
        });

        it("Keeps a plain-text description as it is and leaves the HTML unset; keeps both when both are given.", async () => {
            const { mailbox, calendar } = await setup();
            const plain = await create(calendar.uid, mailbox.uid, { description: "Line one\r\nLine two" });
            expect(plain.status).toBe(200);
            expect(plain.body.description).toBe("Line one\nLine two");
            expect((await ctx.findEvent(plain.body.uid)).descriptionHtml ?? undefined).toBeUndefined();

            const both = await create(calendar.uid, mailbox.uid, { description: "Custom plain", descriptionHtml: "<p>Rich</p>" });
            expect(both.body).toMatchObject({ description: "Custom plain", descriptionHtml: "<p>Rich</p>" });
        });

        it("Leaves a cleared description out on create (null, empty, or nothing but markup that is removed).", async () => {
            const { mailbox, calendar } = await setup();
            for (const body of [{ description: null, descriptionHtml: null }, { description: "", descriptionHtml: "" }, { descriptionHtml: "<script>1</script>" }]) {
                const result = await create(calendar.uid, mailbox.uid, body);
                expect(result.status).toBe(200);
                const row = await ctx.findEvent(result.body.uid);
                expect(row.description ?? undefined).toBeUndefined();
                expect(row.descriptionHtml ?? undefined).toBeUndefined();
            }
        });

        it("Is a 400 for nonsense: a description that isn't a string or is too long, an unknown visibility, a guest permission that isn't a boolean.", async () => {
            const { mailbox, calendar } = await setup();
            for (const body of [
                { description: 5 },
                { descriptionHtml: { a: 1 } },
                { description: "x".repeat(MAX_EVENT_DESCRIPTION_LENGTH + 1) },
                { descriptionHtml: "x".repeat(MAX_EVENT_DESCRIPTION_HTML_LENGTH + 1) },
                { descriptionHtml: "&".repeat(30_000) },
                { visibility: "secret" },
                { visibility: 3 },
                { guestsCanModify: "yes" },
                { guestsCanInviteOthers: 0 },
                { guestsCanSeeGuestList: "false" },
            ]) {
                expect((await create(calendar.uid, mailbox.uid, body)).status).toBe(400);
            }
            expect(await ctx.findEvents(mailbox.uid)).toHaveLength(0);
        });

        it("Stores visibility and the guest permissions the organizer sets, and ignores a client-sent redacted marker.", async () => {
            const { mailbox, calendar } = await setup();
            const result = await create(calendar.uid, mailbox.uid, {
                visibility: "confidential",
                guestsCanModify: true,
                guestsCanInviteOthers: false,
                guestsCanSeeGuestList: false,
                redacted: true,
            });

            expect(result.status).toBe(200);
            const row = await ctx.findEvent(result.body.uid);
            expect(row.visibility).toBe("confidential");
            expect(row.guestsCanModify).toBe(true);
            expect(row.guestsCanInviteOthers).toBe(false);
            expect(row.guestsCanSeeGuestList).toBe(false);
            expect(row.redacted).toBeUndefined();
        });

        it("Updates the description like a create - HTML sanitized and plain text derived, plain text alone clears the HTML, null clears - and validates it.", async () => {
            const { mailbox, calendar } = await setup();
            const created = await create(calendar.uid, mailbox.uid, { descriptionHtml: "<p>First</p>" });
            const put = async (uid: string, body: any) => await owner(request(ctx.app()).put(`${ctx.baseUrl}/${uid}`)).send({ uid, ...body });

            const html = await put(created.body.uid, { version: created.body.version, descriptionHtml: '<p onclick="x()">Second <i>text</i></p>' });
            expect(html.status).toBe(200);
            expect(html.body).toMatchObject({ descriptionHtml: "<p>Second <i>text</i></p>", description: "Second text" });

            const plain = await put(created.body.uid, { version: html.body.version, description: "Only plain" });
            expect(plain.status).toBe(200);
            expect(plain.body.description).toBe("Only plain");
            expect((await ctx.findEvent(created.body.uid)).descriptionHtml ?? undefined).toBeUndefined();

            const cleared = await put(created.body.uid, { version: plain.body.version, description: null, descriptionHtml: null });
            expect(cleared.status).toBe(200);
            const row = await ctx.findEvent(created.body.uid);
            expect(row.description ?? undefined).toBeUndefined();
            expect(row.descriptionHtml ?? undefined).toBeUndefined();

            expect((await put(created.body.uid, { version: cleared.body.version, description: "x".repeat(MAX_EVENT_DESCRIPTION_LENGTH + 1) })).status).toBe(400);
            expect((await put(created.body.uid, { version: cleared.body.version, visibility: "nope" })).status).toBe(400);
        });

        it("Bumps sequence, so guests are re-invited, when the description, visibility or a guest permission changes - and only then.", async () => {
            const { mailbox, calendar } = await setup();
            const created = await create(calendar.uid, mailbox.uid, { description: "Same", visibility: "default" });
            expect(created.body.sequence).toBe(0);
            let version = created.body.version;
            const put = async (body: any) => {
                const result = await owner(request(ctx.app()).put(`${ctx.baseUrl}/${created.body.uid}`)).send({ uid: created.body.uid, version, ...body });
                expect(result.status).toBe(200);
                version = result.body.version;
                return result.body.sequence;
            };

            // Re-sending what is stored (a full-object round trip) is no change; a null flag from a legacy SQL row is left alone.
            expect(await put({ description: "Same", visibility: "default", guestsCanModify: false, guestsCanInviteOthers: null })).toBe(0);
            expect(await put({ description: "Changed" })).toBe(1);
            expect(await put({ descriptionHtml: "<p>Rich now</p>" })).toBe(2);
            expect(await put({ visibility: "private" })).toBe(3);
            expect(await put({ guestsCanModify: true })).toBe(4);
            expect(await put({ guestsCanSeeGuestList: false })).toBe(5);
            expect(await put({ title: "Retitled" })).toBe(5);
        });

        it("Round-trips a full event read from the API and written back, without needing to strip anything.", async () => {
            const { mailbox, calendar } = await setup();
            const created = await create(calendar.uid, mailbox.uid, { descriptionHtml: "<p>Hello <b>you</b></p>", visibility: "public", guestsCanModify: true });
            const read = await owner(request(ctx.app()).get(`${ctx.baseUrl}/${created.body.uid}`));
            expect(read.status).toBe(200);
            expect(read.body.redacted).toBeUndefined();

            const written = await owner(request(ctx.app()).put(`${ctx.baseUrl}/${created.body.uid}`)).send({ ...read.body, title: "Renamed" });

            expect(written.status).toBe(200);
            expect(written.body).toMatchObject({ title: "Renamed", descriptionHtml: "<p>Hello <b>you</b></p>", description: "Hello you", visibility: "public", guestsCanModify: true, sequence: 0 });
        });

        describe("guest permissions on an attendee's copy", () => {
            it("Ignores an edit of them on a copy the mailbox doesn't organize, while still applying the rest and a change of visibility.", async () => {
                const { mailbox, calendar, me } = await setup();
                const copy = await ctx.createCalendarEvent(mailbox.uid, calendar.uid, {
                    organizer: { address: BOSS, type: RecipientType.TO },
                    attendees: [guest(me)],
                    guestsCanModify: false,
                    guestsCanInviteOthers: true,
                    guestsCanSeeGuestList: false,
                });

                const result = await owner(request(ctx.app()).put(`${ctx.baseUrl}/${copy.uid}`)).send({
                    uid: copy.uid,
                    version: copy.version,
                    title: "My name for it",
                    visibility: "private",
                    guestsCanModify: true,
                    guestsCanInviteOthers: false,
                    guestsCanSeeGuestList: true,
                });

                expect(result.status).toBe(200);
                const row = await ctx.findEvent(copy.uid);
                expect(row.title).toBe("My name for it");
                expect(row.visibility).toBe("private");
                expect(row.guestsCanModify).toBe(false);
                expect(row.guestsCanInviteOthers).toBe(true);
                expect(row.guestsCanSeeGuestList).toBe(false);
            });

            it("Applies an edit of them on an event the mailbox organizes, under any of its own addresses, and on a personal event with no organizer.", async () => {
                const { mailbox, calendar, me } = await setup();
                for (const organizer of [me, me.toUpperCase(), ""]) {
                    const event = await ctx.createCalendarEvent(mailbox.uid, calendar.uid, { organizer: { address: organizer, type: RecipientType.TO }, attendees: [guest("friend@example.com")] });
                    const result = await owner(request(ctx.app()).put(`${ctx.baseUrl}/${event.uid}`)).send({ uid: event.uid, version: event.version, guestsCanModify: true, guestsCanSeeGuestList: false });
                    expect(result.status).toBe(200);
                    const row = await ctx.findEvent(event.uid);
                    expect(row.guestsCanModify).toBe(true);
                    expect(row.guestsCanSeeGuestList).toBe(false);
                }
            });
        });
    });

    describe("Visibility: a private or confidential event shown to a reader who isn't the owner only as a busy block", () => {
        /** A calendar with one event of each visibility; `other` gets `actions` on it. */
        const shared = async (actions: string[]) => {
            const { mailbox, calendar, me } = await setup();
            await ctx.grantFolder(calendar.uid, ctx.otherUid, actions);
            const make = async (visibility: string | undefined, title: string) =>
                await ctx.createCalendarEvent(mailbox.uid, calendar.uid, {
                    title,
                    location: `${title} room`,
                    description: `${title} notes`,
                    descriptionHtml: `<p>${title} notes</p>`,
                    ...(visibility ? { visibility } : {}),
                    organizer: { address: me, displayName: "Me", type: RecipientType.TO },
                    attendees: [guest("colleague@example.com", { responseStatus: AttendeeResponseStatus.ACCEPTED })],
                    reminderMinutesBeforeStart: 10,
                    videoMeetingUid: `meeting-${title}`,
                    recurrenceRule: title === "Confidential" ? { freq: "weekly", interval: 1, exceptions: [] } : undefined,
                    guestsCanModify: true,
                });
            const events = {
                legacy: await make(undefined, "Legacy"),
                normal: await make("default", "Normal"),
                open: await make("public", "Open"),
                secret: await make("private", "Private"),
                hidden: await make("confidential", "Confidential"),
            };
            return { mailbox, calendar, me, events };
        };
        const isBlock = (event: any): void => {
            expect(event.title).toBe("Busy");
            expect(event.redacted).toBe(true);
            expect(event.attendees).toEqual([]);
            expect(event.organizer.address).toBe("");
            for (const field of ["location", "description", "descriptionHtml", "videoMeetingUid", "reminderMinutesBeforeStart", "guestsCanModify", "inviteSequenceSent"]) {
                expect(field in event).toBe(false);
            }
            expect(event.startDate).toBeTruthy();
            expect(event.endDate).toBeTruthy();
        };
        const isFull = (event: any, title: string): void => {
            expect(event.title).toBe(title);
            expect(event.redacted).toBeUndefined();
            expect(event.location).toBe(`${title} room`);
            expect(event.description).toBe(`${title} notes`);
            expect(event.attendees).toHaveLength(1);
        };
        const byTitle = (events: any[], title: string): any => events.find((event) => event.title === title || event.uid === title);

        it("Shows the owner every event in full, when listing and when reading one.", async () => {
            const { calendar, events } = await shared(["read", "list"]);

            const list = await owner(request(ctx.app()).get(`${ctx.baseUrl}?folderUid=${calendar.uid}`));

            expect(list.status).toBe(200);
            expect(list.body).toHaveLength(5);
            for (const title of ["Legacy", "Normal", "Open", "Private", "Confidential"]) {
                isFull(byTitle(list.body, title), title);
            }
            const one = await owner(request(ctx.app()).get(`${ctx.baseUrl}/${events.secret.uid}`));
            isFull(one.body, "Private");
            expect(one.body.visibility).toBe("private");
        });

        it("Shows a shared-calendar reader default and public events in full - including one with no visibility set - and private and confidential ones as busy blocks.", async () => {
            const { calendar, events } = await shared(["read", "list"]);

            const list = await other(request(ctx.app()).get(`${ctx.baseUrl}?folderUid=${calendar.uid}`));

            expect(list.status).toBe(200);
            expect(list.body).toHaveLength(5);
            for (const title of ["Legacy", "Normal", "Open"]) {
                isFull(byTitle(list.body, title), title);
            }
            const blocks = list.body.filter((event: any) => event.redacted);
            expect(blocks.map((event: any) => event.uid).sort()).toEqual([events.secret.uid, events.hidden.uid].sort());
            blocks.forEach(isBlock);
            expect(blocks.map((event: any) => event.visibility).sort()).toEqual(["confidential", "private"]);
            // What makes it a block in the right place, and a series still a series.
            const hidden = blocks.find((event: any) => event.uid === events.hidden.uid);
            expect(hidden.recurrenceRule).toMatchObject({ freq: "weekly" });
            expect(hidden.icalUid).toBe(events.hidden.icalUid);
            expect(new Date(hidden.startDate).getTime()).toBe(new Date(events.hidden.startDate).getTime());
            // The stored events are not changed by being read that way.
            expect((await ctx.findEvent(events.secret.uid)).title).toBe("Private");
        });

        it("Does the same when a reader reads one event by id.", async () => {
            const { events } = await shared(["read", "list"]);

            isBlock((await other(request(ctx.app()).get(`${ctx.baseUrl}/${events.secret.uid}`))).body);
            isBlock((await other(request(ctx.app()).get(`${ctx.baseUrl}/${events.hidden.uid}`))).body);
            isFull((await other(request(ctx.app()).get(`${ctx.baseUrl}/${events.normal.uid}`))).body, "Normal");
        });

        it("Counts the same events as it lists.", async () => {
            const { calendar } = await shared(["read", "list", "count"]);

            const count = await other(request(ctx.app()).head(`${ctx.baseUrl}?folderUid=${calendar.uid}`));

            expect(count.status).toBe(200);
            expect(count.headers["content-length"]).toBe("5");
        });

        it("Shows a delegate with UPDATE everything, and a reader with no access nothing.", async () => {
            const { calendar, events } = await shared(["read", "list", "update"]);

            const list = await other(request(ctx.app()).get(`${ctx.baseUrl}?folderUid=${calendar.uid}`));
            expect(list.body.filter((event: any) => event.redacted)).toEqual([]);
            isFull(byTitle(list.body, "Private"), "Private");
            isFull((await other(request(ctx.app()).get(`${ctx.baseUrl}/${events.hidden.uid}`))).body, "Confidential");

            const { calendar: unshared } = await setup();
            expect((await other(request(ctx.app()).get(`${ctx.baseUrl}?folderUid=${unshared.uid}`))).body).toEqual([]);
        });

        it("Publishes a private or confidential event on the calendar's live-update channel only as a busy block, and any other event in full.", async () => {
            const { mailbox, calendar } = await setup();
            const spy = vi.spyOn(NotificationUtils.prototype, "sendMessage");

            const secret = await create(calendar.uid, mailbox.uid, { title: "Secret plan", location: "Bunker", visibility: "private", description: "Details" });
            const open = await create(calendar.uid, mailbox.uid, { title: "Open plan", location: "Cafe", visibility: "public" });
            await owner(request(ctx.app()).put(`${ctx.baseUrl}/${secret.body.uid}`)).send({ uid: secret.body.uid, version: secret.body.version, title: "Renamed secret" });
            await owner(request(ctx.app()).delete(`${ctx.baseUrl}/${secret.body.uid}`));

            const published = spy.mock.calls.filter((call: any[]) => call[0] === calendar.uid);
            expect(published.map((call: any[]) => call[2])).toEqual(["create", "create", "update", "delete"]);
            const [createdSecret, createdOpen, updatedSecret, deleted] = published.map((call: any[]) => call[3]);
            for (const payload of [createdSecret, updatedSecret]) {
                expect(payload.uid).toBe(secret.body.uid);
                expect(payload.title).toBe("Busy");
                expect(payload.redacted).toBe(true);
                expect(payload.location).toBeUndefined();
                expect(payload.description).toBeUndefined();
            }
            expect(createdOpen).toMatchObject({ title: "Open plan", location: "Cafe" });
            expect(createdOpen.redacted).toBeUndefined();
            expect(deleted).toEqual({ uid: secret.body.uid });
            spy.mockRestore();
        });

        it("Shows the holder of a share link the same busy blocks.", async () => {
            const { calendar, events } = await shared(["read"]);
            const link = await owner(request(ctx.app()).post(ctx.shareLinksUrl)).send({ folderUid: calendar.uid, permittedActions: ["list", "read"], createdByUserUid: ctx.ownerUid });
            expect(link.status).toBeLessThan(300);

            const list = await request(ctx.app()).get(`${ctx.baseUrl}?folderUid=${calendar.uid}&shareToken=${link.body.token}`);

            expect(list.status).toBe(200);
            expect(list.body.filter((event: any) => event.redacted).map((event: any) => event.uid).sort()).toEqual([events.secret.uid, events.hidden.uid].sort());
            isFull(byTitle(list.body, "Normal"), "Normal");
            const one = await request(ctx.app()).get(`${ctx.baseUrl}/${events.secret.uid}?shareToken=${link.body.token}`);
            isBlock(one.body);
        });

        it("Refuses a shared-calendar reader a filter or sort on the hidden fields - it would give a private event's title away - but not the owner or ordinary queries.", async () => {
            const { calendar } = await shared(["read", "list", "count"]);
            const url = (query: string) => `${ctx.baseUrl}?folderUid=${calendar.uid}&${query}`;

            for (const query of ["title=like(Private)", "location=x", "description=x", "sort=title:ASC"]) {
                expect((await other(request(ctx.app()).get(url(query)))).status).toBe(400);
            }
            expect((await other(request(ctx.app()).head(url("title=Private")))).status).toBe(400);

            expect((await owner(request(ctx.app()).get(url("title=Private")))).body).toHaveLength(1);
            expect((await other(request(ctx.app()).get(url("status=confirmed")))).status).toBe(200);
            expect((await other(request(ctx.app()).get(url("visibility=private")))).body.map((event: any) => event.title)).toEqual(["Busy"]);
        });
    });

    describe("POST /:id/request-change", () => {
        /** The caller as a guest of an event `BOSS` organizes, whose copy allows `flags`. */
        const guestOf = async (flags: any = { guestsCanModify: true, guestsCanInviteOthers: true }, data: any = {}) => {
            const { mailbox, calendar, me } = await setup();
            const event = await ctx.createCalendarEvent(mailbox.uid, calendar.uid, {
                title: "Team lunch",
                location: "https://video.example/my-own-link",
                startDate: start,
                endDate: end,
                icalUid: "lunch@boss.example.com",
                sequence: 4,
                organizer: { address: BOSS, displayName: "Boss", type: RecipientType.TO },
                attendees: [guest(me, { displayName: "Me" }), guest("peer@example.com")],
                ...flags,
                ...data,
            });
            return { mailbox, calendar, me, event };
        };
        const post = async (uid: string, body: any, as_: (req: any) => any = owner) => await as_(request(ctx.app()).post(`${ctx.baseUrl}/${uid}/request-change`)).send(body);
        const sentCounter = (): string => {
            expect(ctx.transport().sent).toHaveLength(1);
            expect(ctx.transport().sent[0].envelopeTo).toEqual([BOSS]);
            return unfolded(ctx.transport().sent[0].raw);
        };

        it("Mails the organizer a COUNTER carrying every proposed value, the change-request marker and the guests to add, and changes nothing locally.", async () => {
            const { me, event } = await guestOf();
            const newStart = new Date(start.getTime() + 3 * HOUR);
            const newEnd = new Date(newStart.getTime() + 2 * HOUR);
            const stamp = (date: Date): string => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

            const result = await post(event.uid, {
                title: "Team lunch (moved)",
                location: "Cafe Roma",
                descriptionHtml: '<p>Bring <b>cash</b><script>1</script></p>',
                startDate: newStart.toISOString(),
                endDate: newEnd.toISOString(),
                addAttendees: [{ address: "new@example.com", displayName: "New Guest" }, { address: "PEER@example.com" }, { address: "boss@boss.example.com" }, { address: "new@example.com" }],
            });

            expect(result.status).toBe(200);
            expect(result.body).toEqual({ requested: true, changes: ["title", "location", "description", "time"], addAttendees: [{ address: "new@example.com", displayName: "New Guest" }] });
            const raw = sentCounter();
            expect(raw).toContain("METHOD:COUNTER");
            expect(raw).toContain("X-RAPIDMX-CHANGE-REQUEST:TRUE");
            expect(raw).toContain("UID:lunch@boss.example.com");
            expect(raw).toContain("SUMMARY:Team lunch (moved)");
            expect(raw).toContain("LOCATION:Cafe Roma");
            expect(raw).toContain("DESCRIPTION:Bring cash");
            expect(raw).toContain("X-ALT-DESC;FMTTYPE=text/html:<p>Bring <b>cash</b></p>");
            expect(raw).toContain(`DTSTART:${stamp(newStart)}`);
            expect(raw).toContain(`DTEND:${stamp(newEnd)}`);
            expect(raw).toContain("SEQUENCE:4");
            expect(raw).toContain(`PARTSTAT=TENTATIVE`);
            expect(raw).toContain(`mailto:${me}`);
            expect(raw).toContain("mailto:new@example.com");
            expect(raw).not.toContain("peer@example.com");
            expect(raw).toContain(`From: `);
            expect(raw).toContain("Change requested: Team lunch");
            expect(raw).not.toContain("<script");
            // Nothing changed on the guest's own calendar.
            const row = await ctx.findEvent(event.uid);
            expect(row.title).toBe("Team lunch");
            expect(row.location).toBe("https://video.example/my-own-link");
            expect(row.sequence).toBe(4);
            expect(row.attendees).toHaveLength(2);
        });

        it("Names only what changed: the location a guest's own copy holds is never sent as a request, and a value equal to the event's isn't a change.", async () => {
            const { event } = await guestOf();

            const result = await post(event.uid, { title: "Team lunch (renamed)", location: "https://video.example/my-own-link", startDate: start.toISOString(), endDate: end.toISOString() });

            expect(result.status).toBe(200);
            expect(result.body.changes).toEqual(["title"]);
            const raw = sentCounter();
            expect(raw).toContain("SUMMARY:Team lunch (renamed)");
            expect(raw).not.toContain("LOCATION");
            expect(raw).not.toContain("DESCRIPTION");
        });

        it("Accepts a request that only adds guests when guests may invite others, even if they may not modify.", async () => {
            const { event } = await guestOf({ guestsCanModify: false, guestsCanInviteOthers: true });

            const result = await post(event.uid, { addAttendees: [{ address: "friend@example.com" }] });

            expect(result.status).toBe(200);
            expect(result.body).toMatchObject({ changes: [], addAttendees: [{ address: "friend@example.com" }] });
            expect(sentCounter()).toContain("mailto:friend@example.com");
        });

        it("Accepts a request that only changes the event when guests may modify, even if they may not invite others.", async () => {
            const { event } = await guestOf({ guestsCanModify: true, guestsCanInviteOthers: false });

            const result = await post(event.uid, { description: "Plain words" });

            expect(result.status).toBe(200);
            expect(result.body.changes).toEqual(["description"]);
            expect(sentCounter()).toContain("DESCRIPTION:Plain words");
        });

        it("Refuses with a 403 and mails nothing when the event's own flags don't allow what is asked.", async () => {
            const noModify = await guestOf({ guestsCanModify: false, guestsCanInviteOthers: true });
            for (const body of [{ title: "New" }, { location: "Elsewhere" }, { description: "x" }, { startDate: new Date(start.getTime() + HOUR).toISOString(), endDate: new Date(end.getTime() + HOUR).toISOString() }, { title: "New", addAttendees: [{ address: "a@example.com" }] }]) {
                const refused = await post(noModify.event.uid, body);
                expect(refused.status).toBe(403);
                expect(refused.body.message ?? refused.text).toContain("doesn't allow guests to change");
            }
            const noInvite = await guestOf({ guestsCanModify: true, guestsCanInviteOthers: false });
            const refused = await post(noInvite.event.uid, { addAttendees: [{ address: "a@example.com" }] });
            expect(refused.status).toBe(403);
            expect(refused.body.message ?? refused.text).toContain("invite others");
            // The defaults: guests can invite others, can't modify.
            const defaults = await guestOf({});
            expect((await post(defaults.event.uid, { title: "New" })).status).toBe(403);
            expect((await post(defaults.event.uid, { addAttendees: [{ address: "a@example.com" }] })).status).toBe(200);
            expect(ctx.transport().sent).toHaveLength(1);
        });

        it("Refuses a caller who organizes the event, isn't one of its guests, or can't update the calendar; and 404s an unknown event.", async () => {
            const { mailbox, calendar, me } = await setup();
            const own = await ctx.createCalendarEvent(mailbox.uid, calendar.uid, { organizer: { address: me, type: RecipientType.TO }, attendees: [guest("friend@example.com"), guest(me)], guestsCanModify: true });
            const notGuest = await ctx.createCalendarEvent(mailbox.uid, calendar.uid, { organizer: { address: BOSS, type: RecipientType.TO }, attendees: [guest("someone@example.com")], guestsCanModify: true });
            const flagged = await ctx.createCalendarEvent(mailbox.uid, calendar.uid, { organizer: { address: BOSS, type: RecipientType.TO }, attendees: [guest(me, { isOrganizer: true })], guestsCanModify: true });

            expect((await post(own.uid, { title: "New" })).status).toBe(400);
            expect((await post(notGuest.uid, { title: "New" })).status).toBe(400);
            expect((await post(flagged.uid, { title: "New" })).status).toBe(400);
            expect((await post(own.uid, { title: "New" }, other)).status).toBe(403);
            expect((await post(uuid.v4(), { title: "New" })).status).toBe(404);
            expect(ctx.transport().sent).toHaveLength(0);
        });

        it("Is a 400 for a body that is nonsense: not an object, nothing to change, bad values.", async () => {
            const { event } = await guestOf();
            const bad: any[] = [
                undefined,
                [],
                {},
                { title: "" },
                { title: "   " },
                { title: 5 },
                { title: "t".repeat(1001) },
                { location: "" },
                { location: "l".repeat(1001) },
                { description: 5 },
                { description: "x".repeat(MAX_EVENT_DESCRIPTION_LENGTH + 1) },
                { description: null, descriptionHtml: null },
                { startDate: "soon" },
                { startDate: 12 },
                { endDate: "never" },
                { startDate: end.toISOString(), endDate: start.toISOString() },
                { endDate: new Date(start.getTime() - HOUR).toISOString() },
                { addAttendees: "friend@example.com" },
                { addAttendees: [null] },
                { addAttendees: ["friend@example.com"] },
                { addAttendees: [{ address: "a@example.com, b@example.com" }] },
                { addAttendees: [{ address: "Name <a@example.com>" }] },
                { addAttendees: [{}] },
                { addAttendees: Array.from({ length: 51 }, (_, index) => ({ address: `g${index}@example.com` })) },
                // Nothing that differs from the event: the same title, an already invited guest, the organizer.
                { title: "Team lunch" },
                { addAttendees: [{ address: "peer@example.com" }, { address: BOSS }] },
                { startDate: start.toISOString(), endDate: end.toISOString() },
            ];
            for (const body of bad) {
                const result = await owner(request(ctx.app()).post(`${ctx.baseUrl}/${event.uid}/request-change`)).send(body);
                expect(result.status).toBe(400);
            }
            expect(ctx.transport().sent).toHaveLength(0);
        });

        it("Is a 400 when the guests to add would take the event past the attendee limit.", async () => {
            const { mailbox, calendar, me } = await setup();
            const crowded = await ctx.createCalendarEvent(mailbox.uid, calendar.uid, {
                organizer: { address: BOSS, type: RecipientType.TO },
                attendees: [guest(me), ...Array.from({ length: 498 }, (_, index) => guest(`p${index}@example.com`))],
                guestsCanInviteOthers: true,
            });

            expect((await post(crowded.uid, { addAttendees: [{ address: "one@example.com" }] })).status).toBe(200);
            ctx.transport().sent = [];
            const refused = await post(crowded.uid, { addAttendees: [{ address: "one@example.com" }, { address: "two@example.com" }] });
            expect(refused.status).toBe(400);
            expect(ctx.transport().sent).toHaveLength(0);
        });

        it("Changes one occurrence, or the whole series, according to the row it is asked of.", async () => {
            const { mailbox, calendar, me } = await setup();
            const common = { organizer: { address: BOSS, type: RecipientType.TO }, attendees: [guest(me)], guestsCanModify: true, icalUid: "series@boss.example.com" };
            const master = await ctx.createCalendarEvent(mailbox.uid, calendar.uid, { ...common, recurrenceRule: { freq: "weekly", interval: 1, exceptions: [] } });
            const recurrenceId = new Date(start.getTime() + 7 * 24 * HOUR);
            const override = await ctx.createCalendarEvent(mailbox.uid, calendar.uid, { ...common, recurrenceId, startDate: recurrenceId, endDate: new Date(recurrenceId.getTime() + HOUR) });

            expect((await post(master.uid, { title: "Series renamed" })).status).toBe(200);
            expect((await post(override.uid, { title: "Occurrence renamed" })).status).toBe(200);

            const [seriesMail, occurrenceMail] = ctx.transport().sent.map((sent) => unfolded(sent.raw));
            expect(seriesMail).toContain("RRULE:FREQ=WEEKLY");
            expect(seriesMail).not.toContain("RECURRENCE-ID");
            expect(occurrenceMail).toContain("RECURRENCE-ID:");
            expect(occurrenceMail).not.toContain("RRULE");
        });

        it("Is a 502 when the request can't be mailed to the organizer.", async () => {
            const { event } = await guestOf();
            vi.spyOn(ctx.transport(), "send").mockRejectedValueOnce(new Error("relay down"));

            const result = await post(event.uid, { title: "New title" });

            expect(result.status).toBe(502);
        });

        it("Is a 502 for an event whose organizer has no address to mail.", async () => {
            const { mailbox, calendar, me } = await setup();
            const event = await ctx.createCalendarEvent(mailbox.uid, calendar.uid, { organizer: { address: "", type: RecipientType.TO }, attendees: [guest(me)], guestsCanModify: true });
            expect((await post(event.uid, { title: "New title" })).status).toBe(502);
            expect(ctx.transport().sent).toHaveLength(0);
        });

        it("Still mails a request from a guest whose entry has no display name.", async () => {
            const { mailbox, calendar, me } = await setup();
            const event = await ctx.createCalendarEvent(mailbox.uid, calendar.uid, {
                organizer: { address: BOSS, type: RecipientType.TO },
                attendees: [guest(me)],
                guestsCanModify: true,
                title: "Plain",
            });

            const result = await post(event.uid, { title: "Plain, renamed", addAttendees: [{ address: "nameless@example.com", displayName: 7 }] });

            expect(result.status).toBe(200);
            expect(result.body.addAttendees).toEqual([{ address: "nameless@example.com" }]);
            expect(sentCounterText()).toContain(`${me} asked to change: Plain`);
            expect(sentCounterText()).toContain("- add guest: nameless@example.com");
        });

        const sentCounterText = (): string => unfolded(ctx.transport().sent[0].raw);
    });
}
