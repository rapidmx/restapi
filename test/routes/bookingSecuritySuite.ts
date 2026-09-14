///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Anonymous booking hardening - identical on both backends. Run from the BookingRoute test files, which supply a
// started server and fixtures (a mailbox with one calendar folder, recreated before every test).
import { request } from "@rapidrest/service-core/test";
import { NetUtils } from "@rapidrest/service-core";
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
            const spy = vi.spyOn(NetUtils, "getIPAddress").mockImplementation(() => address);
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
}
