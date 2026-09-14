///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Anonymous booking hardening - identical on both backends. Run from the BookingRoute test files, which supply a
// started server and fixtures (a mailbox with one calendar folder, recreated before every test).
import { request } from "@rapidrest/service-core/test";
import { RepoUtils } from "@rapidrest/service-core";
import { BaseBookingRoute } from "../../src/routes/BaseBookingRoute.js";
import { BookingStatus, BusyStatus, CalendarEventStatus, FolderType, RecurrenceFrequency } from "../../src/models/types.js";

const SLOT_1 = "2099-06-01T13:00:00.000Z";
const SLOT_2 = "2099-06-01T14:00:00.000Z";
const NEXT_DAY_SLOT_1 = "2099-06-02T13:00:00.000Z";
const WINDOW_FROM = "2099-06-01T00:00:00.000Z";
const WINDOW_TO = "2099-06-02T00:00:00.000Z";

export interface BookingSecuritySuiteContext {
    app: () => any;
    baseUrl: string;
    mailboxUid: () => string;
    /** The fixture mailbox's (well-known) calendar folder. */
    calendarFolderUid: () => string;
    createBookingType: (data?: any) => Promise<{ uid: string; slug: string }>;
    /** Saves a calendar event in the fixture calendar folder, with `data` overriding any field. */
    createEvent: (data?: any) => Promise<any>;
    /** Saves many calendar events at once, each `data` overriding the same defaults as `createEvent()`. */
    createEvents: (data: any[]) => Promise<void>;
    createFolder: (data: any) => Promise<{ uid: string }>;
    findEvents: () => Promise<any[]>;
    /** Writes `patch` straight onto the stored calendar event `uid` (bumping nothing). */
    updateEvent: (uid: string, patch: any) => Promise<void>;
    findBookings: () => Promise<any[]>;
    rateLimiter: () => any;
}

export function bookingSecuritySuite(ctx: BookingSecuritySuiteContext): void {
    const validBooking = (start: string = SLOT_1) => ({
        start,
        bookerName: "Grace Hopper",
        bookerEmail: "grace@example.com",
        bookerNotes: "Looking forward to it.",
        bookerTimezone: "America/Chicago",
    });
    const book = (slug: string, body: any) => request(ctx.app()).post(`${ctx.baseUrl}/types/${slug}`).send(body);
    const slotStarts = async (slug: string): Promise<string[]> =>
        (await request(ctx.app()).get(`${ctx.baseUrl}/types/${slug}/slots?from=${WINDOW_FROM}&to=${WINDOW_TO}`)).body.map((slot: any) => slot.start);

    describe("manage token", () => {
        it("never resolves a query operator in place of a token, so another booker's booking can't be read or cancelled", async () => {
            const bookingType = await ctx.createBookingType();
            const created = await book(bookingType.slug, validBooking());
            expect(created.status).toBe(200);
            expect(created.body.manageToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

            for (const token of ["like(*)", "regex(^)", `regex(^${created.body.manageToken[0]})`, "ne(x)", "exists(true)", "in(a,b)"]) {
                const encoded: string = encodeURIComponent(token);
                expect((await request(ctx.app()).get(`${ctx.baseUrl}/manage/${encoded}`)).status).toBe(404);
                expect((await request(ctx.app()).post(`${ctx.baseUrl}/manage/${encoded}/cancel`)).status).toBe(404);
                expect((await request(ctx.app()).post(`${ctx.baseUrl}/manage/${encoded}/reschedule`).send({ start: SLOT_2 })).status).toBe(404);
            }
            // Token-shaped but wrong.
            expect((await request(ctx.app()).get(`${ctx.baseUrl}/manage/${"A".repeat(43)}`)).status).toBe(404);

            const bookings = await ctx.findBookings();
            expect(bookings).toHaveLength(1);
            expect(bookings[0].status).toBe(BookingStatus.CONFIRMED);
            expect((await request(ctx.app()).get(`${ctx.baseUrl}/manage/${created.body.manageToken}`)).status).toBe(200);
        });
    });

    describe("calendar folder", () => {
        it("writes the booking into the booking type's own calendar folder, and counts both it and the main calendar as busy", async () => {
            // The main calendar is the mailbox's oldest calendar folder (oldest `dateCreated`, then `uid`). Created in
            // the same millisecond as the fixture's, this folder would win that tie half the time and become "main".
            await new Promise((resolve) => setTimeout(resolve, 5));
            const secondCalendar = await ctx.createFolder({ mailboxUid: ctx.mailboxUid(), name: "Bookings", type: FolderType.CALENDAR });
            const bookingType = await ctx.createBookingType({ calendarFolderUid: secondCalendar.uid });

            const result = await book(bookingType.slug, validBooking(SLOT_1));
            expect(result.status).toBe(200);
            const events = await ctx.findEvents();
            expect(events).toHaveLength(1);
            expect(events[0].folderUid).toBe(secondCalendar.uid);
            expect((await ctx.findBookings())[0].folderUid).toBe(secondCalendar.uid);

            // The booking just made (in the booking type's folder) blocks SLOT_1; an event in the mailbox's main
            // calendar - where bookings used to be written - blocks SLOT_2.
            await ctx.createEvent({ startDate: new Date(SLOT_2), endDate: new Date("2099-06-01T15:00:00.000Z") });
            expect(await slotStarts(bookingType.slug)).toEqual([]);
            expect((await book(bookingType.slug, validBooking(SLOT_2))).status).toBe(409);
        });

        it("falls back to the mailbox's main calendar when the booking type's folder is no longer a calendar of its mailbox", async () => {
            const elsewhere = await ctx.createFolder({ mailboxUid: "some-other-mailbox", name: "Calendar", type: FolderType.CALENDAR });
            const bookingType = await ctx.createBookingType({ calendarFolderUid: elsewhere.uid });

            const result = await book(bookingType.slug, validBooking(SLOT_1));

            expect(result.status).toBe(200);
            const events = await ctx.findEvents();
            expect(events).toHaveLength(1);
            expect(events[0].folderUid).toBe(ctx.calendarFolderUid());
        });

        it("reads every page of busy events, not just the first 500", async () => {
            const bookingType = await ctx.createBookingType();
            // 500 recurring masters that never occur in the window, saved first...
            await ctx.createEvents(
                Array.from({ length: 500 }, () => ({
                    startDate: new Date("2000-01-03T13:00:00.000Z"),
                    endDate: new Date("2000-01-03T14:00:00.000Z"),
                    recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, count: 1, exceptions: [] },
                })),
            );
            // ...then the one weekly series that does block SLOT_1.
            await ctx.createEvent({
                startDate: new Date("2099-05-25T13:00:00.000Z"),
                endDate: new Date("2099-05-25T14:00:00.000Z"),
                recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, exceptions: [] },
                status: CalendarEventStatus.CONFIRMED,
                busyStatus: BusyStatus.BUSY,
            });

            expect(await slotStarts(bookingType.slug)).toEqual([SLOT_2]);
            expect((await book(bookingType.slug, validBooking(SLOT_1))).status).toBe(409);
        }, 60_000);
    });

    describe("rate limiting", () => {
        it("limits booking per source IP and booking type, so one client can't lock everyone else out of a link", async () => {
            const rateLimiter: any = ctx.rateLimiter();
            const original = rateLimiter.config;
            rateLimiter.config = { enabled: true, maxAttempts: 2, windowSeconds: 300, ip: { enabled: false } };
            let address = "203.0.113.1";
            const spy = vi.spyOn(BaseBookingRoute.prototype as any, "clientAddress").mockImplementation(() => address);
            try {
                const bookingType = await ctx.createBookingType();
                const otherType = await ctx.createBookingType();

                expect((await book(bookingType.slug, validBooking(SLOT_1))).status).toBe(200);
                expect((await book(bookingType.slug, validBooking(SLOT_1))).status).toBe(409);
                expect((await book(bookingType.slug, validBooking(SLOT_2))).status).toBe(429);
                // The same client on another booking type has its own counter...
                expect((await book(otherType.slug, validBooking(NEXT_DAY_SLOT_1))).status).toBe(200);

                // ...and a different client on the exhausted booking type isn't locked out.
                address = "203.0.113.2";
                expect((await book(bookingType.slug, validBooking(SLOT_2))).status).toBe(200);
            } finally {
                spy.mockRestore();
                rateLimiter.config = original;
            }
        });
    });

    describe("booker fields", () => {
        it("rejects over-long or non-string booker fields (400) without booking anything", async () => {
            const bookingType = await ctx.createBookingType();

            for (const overrides of [
                { bookerName: "n".repeat(201) },
                { bookerName: 42 },
                { bookerEmail: `${"e".repeat(250)}@example.com` },
                { bookerEmail: ["grace@example.com"] },
                { bookerNotes: "x".repeat(2001) },
                { bookerNotes: { text: "hi" } },
                { bookerTimezone: "T".repeat(65) },
            ]) {
                const result = await book(bookingType.slug, { ...validBooking(), ...overrides });
                expect(result.status).toBe(400);
            }
            expect(await ctx.findBookings()).toHaveLength(0);

            const atLimits = await book(bookingType.slug, {
                ...validBooking(),
                bookerName: "n".repeat(200),
                bookerNotes: "x".repeat(2000),
                bookerTimezone: "T".repeat(64),
            });
            expect(atLimits.status).toBe(200);
        });
    });

    describe("round 4", () => {
        const manage = (token: string, action: "cancel" | "reschedule", body?: any) =>
            request(ctx.app()).post(`${ctx.baseUrl}/manage/${token}/${action}`).send(body);

        it("rate limits the slots endpoint per source IP and booking type, on a counter separate from booking, and only for real booking types", async () => {
            const rateLimiter: any = ctx.rateLimiter();
            const original = rateLimiter.config;
            rateLimiter.config = { enabled: true, maxAttempts: 2, windowSeconds: 300, ip: { enabled: false } };
            const spy = vi.spyOn(BaseBookingRoute.prototype as any, "clientAddress").mockImplementation(() => "203.0.113.9");
            const checkSpy = vi.spyOn(rateLimiter, "checkAndIncrement");
            try {
                const bookingType = await ctx.createBookingType();
                const slots = () => request(ctx.app()).get(`${ctx.baseUrl}/types/${bookingType.slug}/slots?from=${WINDOW_FROM}&to=${WINDOW_TO}`);

                expect((await slots()).status).toBe(200);
                expect((await slots()).status).toBe(200);
                expect((await slots()).status).toBe(429);
                // Booking has its own counter, so browsing didn't use it up.
                expect((await book(bookingType.slug, validBooking(SLOT_1))).status).toBe(200);

                // A slug naming no booking type is a 404 without ever reaching the limiter.
                checkSpy.mockClear();
                expect((await request(ctx.app()).get(`${ctx.baseUrl}/types/no-such-type-${Date.now()}/slots`)).status).toBe(404);
                expect((await book(`no-such-type-${Date.now()}`, validBooking(SLOT_1))).status).toBe(404);
                expect((await book("---", validBooking(SLOT_1))).status).toBe(404);
                expect(checkSpy).not.toHaveBeenCalled();
            } finally {
                checkSpy.mockRestore();
                spy.mockRestore();
                rateLimiter.config = original;
            }
        });

        it("keys the limiter on the socket address when the peer isn't a trusted proxy, so a forged X-Forwarded-For doesn't get a fresh counter", async () => {
            const rateLimiter: any = ctx.rateLimiter();
            const original = rateLimiter.config;
            rateLimiter.config = { enabled: true, maxAttempts: 1, windowSeconds: 300, ip: { enabled: false } };
            try {
                const bookingType = await ctx.createBookingType();
                const slots = (forwardedFor: string) =>
                    request(ctx.app()).get(`${ctx.baseUrl}/types/${bookingType.slug}/slots?from=${WINDOW_FROM}&to=${WINDOW_TO}`).set("X-Forwarded-For", forwardedFor);

                expect((await slots("198.51.100.1")).status).toBe(200);
                expect((await slots("198.51.100.2")).status).toBe(429);
            } finally {
                rateLimiter.config = original;
            }
        });

        it("caps one slots response at 500 slots (earliest first) and offers each start once even with duplicated windows", async () => {
            const window = { startMinute: 0, endMinute: 1440 };
            const bookingType = await ctx.createBookingType({
                durationMinutes: 5,
                // Every window listed twice - the duplicates must not double any slot.
                availability: [0, 1, 2, 3, 4, 5, 6].flatMap((dayOfWeek) => [
                    { dayOfWeek, ...window },
                    { dayOfWeek, ...window },
                ]),
            });

            const result = await request(ctx.app()).get(
                `${ctx.baseUrl}/types/${bookingType.slug}/slots?from=${WINDOW_FROM}&to=2099-06-04T00:00:00.000Z`,
            );

            expect(result.status).toBe(200);
            expect(result.body).toHaveLength(500);
            const starts: string[] = result.body.map((slot: any) => slot.start);
            expect(new Set(starts).size).toBe(500);
            expect([...starts].sort()).toEqual(starts);
            // The window opens at `from` itself (20:00 the previous evening in New York).
            expect(starts[0]).toBe(WINDOW_FROM);
            expect(starts[499]).toBe(new Date(Date.parse(WINDOW_FROM) + 499 * 5 * 60_000).toISOString());
        });

        it("lets a booking move within its own day when maxPerDay is 1, while a second booking that day is still refused", async () => {
            const bookingType = await ctx.createBookingType({ maxPerDay: 1 });
            const created = await book(bookingType.slug, validBooking(SLOT_1));
            expect(created.status).toBe(200);

            // The booking itself no longer counts against its own day.
            const moved = await manage(created.body.manageToken, "reschedule", { start: SLOT_2 });
            expect(moved.status).toBe(200);
            expect(moved.body.startDate).toBe(SLOT_2);

            // A second booking on that day is still refused.
            expect((await book(bookingType.slug, validBooking(SLOT_1))).status).toBe(409);
        });

        it("refuses to reschedule once the booking's calendar event is cancelled (409)", async () => {
            const bookingType = await ctx.createBookingType();
            const created = await book(bookingType.slug, validBooking(SLOT_1));
            expect(created.status).toBe(200);
            const [event] = await ctx.findEvents();
            // e.g. the host cancelled the meeting from their own calendar.
            await ctx.updateEvent(event.uid, { status: CalendarEventStatus.CANCELLED });

            const result = await manage(created.body.manageToken, "reschedule", { start: SLOT_2 });

            expect(result.status).toBe(409);
            expect(new Date((await ctx.findEvents())[0].startDate).toISOString()).toBe(SLOT_1);
            expect(new Date((await ctx.findBookings())[0].startDate).toISOString()).toBe(SLOT_1);
        });

        it("refuses (409) a cancel that raced a reschedule of the same booking, without cancelling the moved event", async () => {
            const bookingType = await ctx.createBookingType();
            const created = await book(bookingType.slug, validBooking(SLOT_1));
            expect(created.status).toBe(200);
            const token: string = created.body.manageToken;

            const originalFind = RepoUtils.prototype.find;
            let raced = false;
            const spy = vi.spyOn(RepoUtils.prototype, "find").mockImplementation(async function (this: any, ...args: any[]) {
                const rows = await (originalFind as any).apply(this, args);
                if (!raced && /^Booking(Mongo|SQL)$/.test(this.modelClass?.name ?? "")) {
                    raced = true;
                    // The reschedule lands between the cancel's read of the booking and its write.
                    expect((await manage(token, "reschedule", { start: SLOT_2 })).status).toBe(200);
                }
                return rows;
            });
            let cancelled: any;
            try {
                cancelled = await manage(token, "cancel");
            } finally {
                spy.mockRestore();
            }

            expect(raced).toBe(true);
            expect(cancelled.status).toBe(409);
            const [booking] = await ctx.findBookings();
            expect(booking.status).toBe(BookingStatus.CONFIRMED);
            expect(new Date(booking.startDate).toISOString()).toBe(SLOT_2);
            const [event] = await ctx.findEvents();
            expect(event.status).not.toBe(CalendarEventStatus.CANCELLED);
            expect(new Date(event.startDate).toISOString()).toBe(SLOT_2);

            // Retrying the cancel now works, and cancels the event too.
            expect((await manage(token, "cancel")).status).toBe(200);
            expect((await ctx.findEvents())[0].status).toBe(CalendarEventStatus.CANCELLED);
        });
    });
}
