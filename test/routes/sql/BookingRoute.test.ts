///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Exercises the ENTIRE anonymous booking flow with NO `Authorization` header on any request - these endpoints
// are unauthenticated by design, and a test that quietly authenticated would prove nothing about the behavior
// that actually matters. Same idiom as the anonymous share-token requests in CalendarEventRoute.test.ts.
//
// Unlike the Mongo twin, `@Transactional()` on `persistBooking()` opens a REAL transaction here - the SQL
// datasource supports them, where the standalone `MongoMemoryServer` the Mongo tests run against does not (it
// logs a warning at connect time and degrades to running without one). So this file, not its twin, is what
// actually exercises the transactional path.
import config from "../../config.sql.js";
import { request } from "@rapidrest/service-core/test";
import { Server, ObjectFactory, ConnectionManager, isSqlDataSource, RateLimiter } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import { BookingSQL } from "../../../src/models/sql/BookingSQL.js";
import { BookingTypeSQL } from "../../../src/models/sql/BookingTypeSQL.js";
import { CalendarEventSQL } from "../../../src/models/sql/CalendarEventSQL.js";
import { FolderSQL } from "../../../src/models/sql/FolderSQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import {
    BookingStatus,
    BusyStatus,
    CalendarEventStatus,
    FolderType,
    RecipientType,
    RecurrenceFrequency,
} from "../../../src/models/types.js";
import { RecordingMailTransport, registerTestDoubles } from "../../testDoubles.js";
import { bookingSecuritySuite } from "../bookingSecuritySuite.js";

// Every slot below sits on one fixed, far-future date so that it is always in the future no matter when the
// suite runs, WITHOUT freezing the clock. Freezing it with `vi.useFakeTimers({ toFake: ["Date"] })` is
// deliberately avoided here and in the SQL twin: with a mocked global `Date`, TypeORM's SQLite driver hydrates
// `datetime` columns back as raw strings rather than `Date` objects, so any date arithmetic the route performs
// on a row it just read (`expandOccurrences()`, for one) throws. The fixture booking type is available every
// day of the week, so the weekday of this date is deliberately irrelevant. New York is UTC-4 in June, so its
// 09:00-11:00 local window is 13:00Z-15:00Z.
const SLOT_1 = "2099-06-01T13:00:00.000Z";
const SLOT_2 = "2099-06-01T14:00:00.000Z";
const NEXT_DAY_SLOT_1 = "2099-06-02T13:00:00.000Z";
const NOT_A_SLOT = "2099-06-01T13:30:00.000Z";
const WINDOW_FROM = "2099-06-01T00:00:00.000Z";
const WINDOW_TO = "2099-06-02T00:00:00.000Z";
// One week before SLOT_1, for the weekly-recurrence test - a series whose own row starts outside the window.
const WEEK_BEFORE_START = "2099-05-25T13:00:00.000Z";
const WEEK_BEFORE_END = "2099-05-25T14:00:00.000Z";
// 11:00-12:00 local, immediately after the last slot - only reachable via a trailing buffer.
const AFTER_LAST_SLOT_START = "2099-06-01T15:00:00.000Z";
const AFTER_LAST_SLOT_END = "2099-06-01T16:00:00.000Z";

describe("Route:BookingSQL Tests (anonymous)", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/bookings";
    let mailboxRepo: Repository<MailboxSQL>;
    let folderRepo: Repository<FolderSQL>;
    let bookingTypeRepo: Repository<BookingTypeSQL>;
    let bookingRepo: Repository<BookingSQL>;
    let calendarEventRepo: Repository<CalendarEventSQL>;
    let mailTransport: RecordingMailTransport;

    let mailbox: MailboxSQL;
    let calendarFolder: FolderSQL;

    const createBookingType = async function (data?: any): Promise<BookingTypeSQL> {
        return await bookingTypeRepo.save(
            new BookingTypeSQL({
                mailboxUid: mailbox.uid,
                calendarFolderUid: calendarFolder.uid,
                slug: `intro-${uuid.v4()}`,
                name: "Intro Call",
                hostDisplayName: "Ada Lovelace",
                durationMinutes: 60,
                timezone: "America/New_York",
                availability: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, startMinute: 540, endMinute: 660 })),
                dateOverrides: [],
                bufferBeforeMinutes: 0,
                bufferAfterMinutes: 0,
                minimumNoticeMinutes: 0,
                bookingWindowDays: 100_000,
                requiresApproval: false,
                enabled: true,
                ...data,
            }),
        );
    };

    const createEvent = async function (data?: any): Promise<CalendarEventSQL> {
        return await calendarEventRepo.save(
            new CalendarEventSQL({
                folderUid: calendarFolder.uid,
                mailboxUid: mailbox.uid,
                title: "Existing",
                startDate: new Date(SLOT_1),
                endDate: new Date(SLOT_2),
                allDay: false,
                timezone: "UTC",
                organizer: { address: mailbox.primarySmtpAddress, type: RecipientType.TO },
                attendees: [],
                status: CalendarEventStatus.CONFIRMED,
                busyStatus: BusyStatus.BUSY,
                icalUid: uuid.v4(),
                sequence: 0,
                ...data,
            }),
        );
    };

    const book = (slug: string, body: any) => request(server.getApplication()).post(`${baseUrl}/types/${slug}`).send(body);

    const validBooking = (start: string = SLOT_1) => ({
        start,
        bookerName: "Grace Hopper",
        bookerEmail: "Grace@Example.com",
        bookerNotes: "Looking forward to it.",
        bookerTimezone: "America/Chicago",
    });

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("sql");
        if (isSqlDataSource(conn)) {
            mailboxRepo = conn.getRepository(MailboxSQL);
            folderRepo = conn.getRepository(FolderSQL);
            bookingTypeRepo = conn.getRepository(BookingTypeSQL);
            bookingRepo = conn.getRepository(BookingSQL);
            calendarEventRepo = conn.getRepository(CalendarEventSQL);
        } else {
            throw new Error("Could not find sql connection");
        }
        mailTransport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        // Child rows first - these tables are shared on disk with every other SQL test file in the run.
        for (const repo of [bookingRepo, calendarEventRepo, bookingTypeRepo, folderRepo, mailboxRepo]) {
            await repo.clear();
        }
        mailTransport.sent = [];

        mailbox = await mailboxRepo.save(
            new MailboxSQL({
                ownerUserUid: uuid.v4(),
                primarySmtpAddress: `ada-${uuid.v4()}@example.com`,
                aliasAddresses: [],
                displayName: "Ada Lovelace",
                timezone: "UTC",
                quotaBytes: 1_000_000_000,
                usedBytes: 0,
            }),
        );
        calendarFolder = await folderRepo.save(
            new FolderSQL({
                mailboxUid: mailbox.uid,
                name: "Calendar",
                type: FolderType.CALENDAR,
                unreadCount: 0,
                totalCount: 0,
                syncKeyVersion: 0,
            }),
        );
    });

    describe("GET /types/:slug", () => {
        it("Returns the public details of an enabled booking type, and none of the internal identifiers.", async () => {
            const bookingType = await createBookingType();

            const result = await request(server.getApplication()).get(`${baseUrl}/types/${bookingType.slug}`);

            expect(result.status).toBe(200);
            expect(result.body.name).toBe("Intro Call");
            expect(result.body.hostDisplayName).toBe("Ada Lovelace");
            expect(result.body.durationMinutes).toBe(60);
            expect(result.body.mailboxUid).toBeUndefined();
            expect(result.body.calendarFolderUid).toBeUndefined();
        });

        it("Returns 404 for a slug that does not exist.", async () => {
            const result = await request(server.getApplication()).get(`${baseUrl}/types/nope`);

            expect(result.status).toBe(404);
        });

        it("Returns 404 for a disabled booking type, so a paused link looks like one that never existed.", async () => {
            const bookingType = await createBookingType({ enabled: false });

            const result = await request(server.getApplication()).get(`${baseUrl}/types/${bookingType.slug}`);

            expect(result.status).toBe(404);
        });
    });

    describe("GET /types/:slug/slots", () => {
        it("Lists the slots the booking type's availability allows.", async () => {
            const bookingType = await createBookingType();

            const result = await request(server.getApplication()).get(
                `${baseUrl}/types/${bookingType.slug}/slots?from=${WINDOW_FROM}&to=${WINDOW_TO}`,
            );

            expect(result.status).toBe(200);
            expect(result.body.map((slot: any) => slot.start)).toEqual([SLOT_1, SLOT_2]);
        });

        it("Omits a slot the host is already busy for.", async () => {
            const bookingType = await createBookingType();
            await createEvent();

            const result = await request(server.getApplication()).get(
                `${baseUrl}/types/${bookingType.slug}/slots?from=${WINDOW_FROM}&to=${WINDOW_TO}`,
            );

            expect(result.body.map((slot: any) => slot.start)).toEqual([SLOT_2]);
        });

        it("Ignores an event marked free, which does not really occupy the host.", async () => {
            const bookingType = await createBookingType();
            await createEvent({ busyStatus: BusyStatus.FREE });

            const result = await request(server.getApplication()).get(
                `${baseUrl}/types/${bookingType.slug}/slots?from=${WINDOW_FROM}&to=${WINDOW_TO}`,
            );

            expect(result.body.map((slot: any) => slot.start)).toEqual([SLOT_1, SLOT_2]);
        });

        it("Expands a recurring busy series so a later occurrence blocks its slot too.", async () => {
            const bookingType = await createBookingType();
            // A weekly 09:00-10:00 New York series starting the Monday BEFORE the window - query 1 can never
            // see it, so this only passes because the recurring-master query exists.
            await createEvent({
                startDate: new Date(WEEK_BEFORE_START),
                endDate: new Date(WEEK_BEFORE_END),
                recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1 },
            });

            const result = await request(server.getApplication()).get(
                `${baseUrl}/types/${bookingType.slug}/slots?from=${WINDOW_FROM}&to=${WINDOW_TO}`,
            );

            expect(result.body.map((slot: any) => slot.start)).toEqual([SLOT_2]);
        });

        it("Applies the configured buffers, which can knock out an otherwise free adjacent slot.", async () => {
            const bookingType = await createBookingType({ bufferAfterMinutes: 30 });
            // Busy 11:00-12:00 local (15:00-16:00Z) - only the 10:00 slot's trailing buffer reaches it.
            await createEvent({
                startDate: new Date(AFTER_LAST_SLOT_START),
                endDate: new Date(AFTER_LAST_SLOT_END),
            });

            const result = await request(server.getApplication()).get(
                `${baseUrl}/types/${bookingType.slug}/slots?from=${WINDOW_FROM}&to=${WINDOW_TO}`,
            );

            expect(result.body.map((slot: any) => slot.start)).toEqual([SLOT_1]);
        });

        it("Defaults the window when no from/to is supplied.", async () => {
            const bookingType = await createBookingType();

            const result = await request(server.getApplication()).get(`${baseUrl}/types/${bookingType.slug}/slots`);

            expect(result.status).toBe(200);
            expect(result.body.length).toBeGreaterThan(0);
        });

        it("Returns an empty list, without touching the calendar, when the configuration allows nothing.", async () => {
            const bookingType = await createBookingType({ availability: [] });

            const result = await request(server.getApplication()).get(
                `${baseUrl}/types/${bookingType.slug}/slots?from=${WINDOW_FROM}&to=${WINDOW_TO}`,
            );

            expect(result.body).toEqual([]);
        });

        it("Rejects an unparseable from (400).", async () => {
            const bookingType = await createBookingType();

            const result = await request(server.getApplication()).get(`${baseUrl}/types/${bookingType.slug}/slots?from=yesterday`);

            expect(result.status).toBe(400);
        });

        it("Rejects an unparseable to (400).", async () => {
            const bookingType = await createBookingType();

            const result = await request(server.getApplication()).get(`${baseUrl}/types/${bookingType.slug}/slots?to=someday`);

            expect(result.status).toBe(400);
        });
    });

    describe("POST /types/:slug", () => {
        it("Books a slot, creating the calendar event and mailing the booker an invite with their manage link.", async () => {
            const bookingType = await createBookingType();

            const result = await book(bookingType.slug, validBooking());

            expect(result.status).toBe(200);
            expect(result.body.status).toBe(BookingStatus.CONFIRMED);
            expect(result.body.startDate).toBe(SLOT_1);
            expect(result.body.manageToken).toBeTruthy();
            // The address is normalized on the way in.
            expect(result.body.bookerEmail).toBe("grace@example.com");

            const events = await calendarEventRepo.find();
            expect(events).toHaveLength(1);
            expect(events[0].title).toBe("Intro Call with Grace Hopper");
            expect(events[0].status).toBe(CalendarEventStatus.CONFIRMED);
            expect(events[0].busyStatus).toBe(BusyStatus.BUSY);
            expect(events[0].icalUid).not.toBe("");
            expect(events[0].attendees[0].address).toBe("grace@example.com");
            // Stamped so MeetingSchedulingJob doesn't send a second, generic invite for the same revision.
            expect(events[0].inviteSequenceSent).toBe(events[0].sequence);

            expect(mailTransport.sent).toHaveLength(1);
            expect(mailTransport.sent[0].envelopeTo).toEqual(["grace@example.com"]);
            const raw: string = mailTransport.sent[0].raw.toString();
            expect(raw).toContain(`/manage/${result.body.manageToken}`);
        });

        it("Leaves a booking pending and its event tentative when the booking type requires approval.", async () => {
            const bookingType = await createBookingType({ requiresApproval: true });

            const result = await book(bookingType.slug, validBooking());

            expect(result.body.status).toBe(BookingStatus.PENDING);
            const events = await calendarEventRepo.find();
            expect(events[0].status).toBe(CalendarEventStatus.TENTATIVE);
            expect(events[0].busyStatus).toBe(BusyStatus.TENTATIVE);
        });

        it("Rejects a start that is not one of the offered slots (409).", async () => {
            const bookingType = await createBookingType();

            const result = await book(bookingType.slug, validBooking(NOT_A_SLOT));

            expect(result.status).toBe(409);
        });

        it("Rejects a slot the host became busy for after the page was loaded (409).", async () => {
            const bookingType = await createBookingType();
            await createEvent();

            const result = await book(bookingType.slug, validBooking());

            expect(result.status).toBe(409);
        });

        it("Rejects a second booking of the very same slot (409).", async () => {
            const bookingType = await createBookingType();
            expect((await book(bookingType.slug, validBooking())).status).toBe(200);

            const result = await book(bookingType.slug, validBooking());

            expect(result.status).toBe(409);
        });

        it("Rejects a booking on a day already at maxPerDay (409).", async () => {
            const bookingType = await createBookingType({ maxPerDay: 1 });
            expect((await book(bookingType.slug, validBooking(SLOT_1))).status).toBe(200);

            const result = await book(bookingType.slug, validBooking(SLOT_2));

            expect(result.status).toBe(409);
        });

        it("Still allows a booking on the next day when the previous day is at maxPerDay.", async () => {
            const bookingType = await createBookingType({ maxPerDay: 1 });
            expect((await book(bookingType.slug, validBooking(SLOT_1))).status).toBe(200);

            const result = await book(bookingType.slug, validBooking(NEXT_DAY_SLOT_1));

            expect(result.status).toBe(200);
        });

        it("Rejects a missing bookerName (400).", async () => {
            const bookingType = await createBookingType();

            const result = await book(bookingType.slug, { ...validBooking(), bookerName: "   " });

            expect(result.status).toBe(400);
        });

        it("Rejects a malformed bookerEmail (400).", async () => {
            const bookingType = await createBookingType();

            const result = await book(bookingType.slug, { ...validBooking(), bookerEmail: "not-an-address" });

            expect(result.status).toBe(400);
        });

        it("Rejects a missing start (400).", async () => {
            const bookingType = await createBookingType();
            const body: any = validBooking();
            delete body.start;

            const result = await book(bookingType.slug, body);

            expect(result.status).toBe(400);
        });

        it("Rejects a request with no body at all (400).", async () => {
            const bookingType = await createBookingType();

            const result = await book(bookingType.slug, undefined);

            expect(result.status).toBe(400);
        });

        it("Returns 404 for a disabled booking type.", async () => {
            const bookingType = await createBookingType({ enabled: false });

            const result = await book(bookingType.slug, validBooking());

            expect(result.status).toBe(404);
        });

        it("Returns 500 when the booking type points at a mailbox that no longer exists.", async () => {
            const bookingType = await createBookingType();
            await mailboxRepo.clear();

            const result = await book(bookingType.slug, validBooking());

            expect(result.status).toBe(500);
        });
    });

    describe("GET /manage/:token", () => {
        it("Returns the booker's own view of their booking, without re-issuing the token.", async () => {
            const bookingType = await createBookingType();
            const created = await book(bookingType.slug, validBooking());

            const result = await request(server.getApplication()).get(`${baseUrl}/manage/${created.body.manageToken}`);

            expect(result.status).toBe(200);
            expect(result.body.uid).toBe(created.body.uid);
            expect(result.body.bookingTypeSlug).toBe(bookingType.slug);
            expect(result.body.bookerNotes).toBe("Looking forward to it.");
            expect(result.body.manageToken).toBeUndefined();
        });

        it("Returns 404 for a token that matches nothing.", async () => {
            const result = await request(server.getApplication()).get(`${baseUrl}/manage/${uuid.v4()}`);

            expect(result.status).toBe(404);
        });

        it("Returns 404 when the booking's own booking type has been deleted.", async () => {
            const bookingType = await createBookingType();
            const created = await book(bookingType.slug, validBooking());
            await bookingTypeRepo.clear();

            const result = await request(server.getApplication()).get(`${baseUrl}/manage/${created.body.manageToken}`);

            expect(result.status).toBe(404);
        });
    });

    describe("POST /manage/:token/cancel", () => {
        it("Cancels the booking and marks its event cancelled, leaving the iTIP CANCEL to MeetingSchedulingJob.", async () => {
            const bookingType = await createBookingType();
            const created = await book(bookingType.slug, validBooking());

            const result = await request(server.getApplication()).post(`${baseUrl}/manage/${created.body.manageToken}/cancel`);

            expect(result.status).toBe(200);
            expect(result.body.status).toBe(BookingStatus.CANCELLED);

            const booking = (await bookingRepo.find({ where: { uid: created.body.uid } }))[0];
            expect(booking.cancelledAt).toBeTruthy();
            const events = await calendarEventRepo.find();
            expect(events[0].status).toBe(CalendarEventStatus.CANCELLED);
            expect(events[0].cancelNoticeSentAt).toBeFalsy();
        });

        it("Frees the slot up again for someone else.", async () => {
            const bookingType = await createBookingType();
            const created = await book(bookingType.slug, validBooking());
            await request(server.getApplication()).post(`${baseUrl}/manage/${created.body.manageToken}/cancel`);

            const result = await book(bookingType.slug, validBooking());

            expect(result.status).toBe(200);
        });

        it("Is idempotent - a second cancel returns the same answer rather than an error.", async () => {
            const bookingType = await createBookingType();
            const created = await book(bookingType.slug, validBooking());
            await request(server.getApplication()).post(`${baseUrl}/manage/${created.body.manageToken}/cancel`);

            const result = await request(server.getApplication()).post(`${baseUrl}/manage/${created.body.manageToken}/cancel`);

            expect(result.status).toBe(200);
            expect(result.body.status).toBe(BookingStatus.CANCELLED);
        });

        it("Returns 404 for a token that matches nothing.", async () => {
            const result = await request(server.getApplication()).post(`${baseUrl}/manage/${uuid.v4()}/cancel`);

            expect(result.status).toBe(404);
        });

        it("Returns 404 when the booking's own booking type has been deleted.", async () => {
            const bookingType = await createBookingType();
            const created = await book(bookingType.slug, validBooking());
            await bookingTypeRepo.clear();

            const result = await request(server.getApplication()).post(`${baseUrl}/manage/${created.body.manageToken}/cancel`);

            expect(result.status).toBe(404);
        });

        it("Still cancels the booking when its calendar event has already been deleted.", async () => {
            const bookingType = await createBookingType();
            const created = await book(bookingType.slug, validBooking());
            await calendarEventRepo.clear();

            const result = await request(server.getApplication()).post(`${baseUrl}/manage/${created.body.manageToken}/cancel`);

            expect(result.status).toBe(200);
            expect(result.body.status).toBe(BookingStatus.CANCELLED);
        });
    });

    describe("POST /manage/:token/reschedule", () => {
        const reschedule = (token: string, body: any) =>
            request(server.getApplication()).post(`${baseUrl}/manage/${token}/reschedule`).send(body);

        it("Moves the booking and its event to the new slot, bumps the sequence and re-sends the invite.", async () => {
            const bookingType = await createBookingType();
            const created = await book(bookingType.slug, validBooking(SLOT_1));
            mailTransport.sent = [];

            const result = await reschedule(created.body.manageToken, { start: SLOT_2 });

            expect(result.status).toBe(200);
            expect(result.body.startDate).toBe(SLOT_2);

            const events = await calendarEventRepo.find();
            expect(events).toHaveLength(1);
            expect(events[0].startDate.toISOString()).toBe(SLOT_2);
            expect(events[0].sequence).toBe(1);
            expect(events[0].inviteSequenceSent).toBe(1);
            expect(mailTransport.sent).toHaveLength(1);
        });

        it("Does not treat the booking's own event as a conflict with itself.", async () => {
            const bookingType = await createBookingType({ bufferBeforeMinutes: 120, bufferAfterMinutes: 120 });
            const created = await book(bookingType.slug, validBooking(SLOT_1));

            // Rescheduling onto the very same slot would collide with its own event were it not excluded.
            const result = await reschedule(created.body.manageToken, { start: SLOT_1 });

            expect(result.status).toBe(200);
        });

        it("Rejects a new start that is not an offered slot (409).", async () => {
            const bookingType = await createBookingType();
            const created = await book(bookingType.slug, validBooking());

            const result = await reschedule(created.body.manageToken, { start: NOT_A_SLOT });

            expect(result.status).toBe(409);
        });

        it("Rejects a missing start (400).", async () => {
            const bookingType = await createBookingType();
            const created = await book(bookingType.slug, validBooking());

            const result = await reschedule(created.body.manageToken, {});

            expect(result.status).toBe(400);
        });

        it("Rejects rescheduling a cancelled booking (400).", async () => {
            const bookingType = await createBookingType();
            const created = await book(bookingType.slug, validBooking());
            await request(server.getApplication()).post(`${baseUrl}/manage/${created.body.manageToken}/cancel`);

            const result = await reschedule(created.body.manageToken, { start: SLOT_2 });

            expect(result.status).toBe(400);
        });

        it("Returns 404 for a token that matches nothing.", async () => {
            const result = await reschedule(uuid.v4(), { start: SLOT_2 });

            expect(result.status).toBe(404);
        });

        it("Returns 404 once the booking type has been disabled.", async () => {
            const bookingType = await createBookingType();
            const created = await book(bookingType.slug, validBooking());
            await bookingTypeRepo.update({ uid: bookingType.uid }, { enabled: false });

            const result = await reschedule(created.body.manageToken, { start: SLOT_2 });

            expect(result.status).toBe(404);
        });

        it("Returns 404 when the booking's calendar event has been deleted out from under it.", async () => {
            const bookingType = await createBookingType();
            const created = await book(bookingType.slug, validBooking());
            await calendarEventRepo.clear();

            const result = await reschedule(created.body.manageToken, { start: SLOT_2 });

            expect(result.status).toBe(404);
        });
    });

    it("Provisions the calendar folder itself when the mailbox does not have one yet.", async () => {
        const bookingType = await createBookingType();
        await folderRepo.clear();

        const result = await book(bookingType.slug, validBooking());

        expect(result.status).toBe(200);
        const folders = await folderRepo.find();
        expect(folders).toHaveLength(1);
        expect(folders[0].type).toBe(FolderType.CALENDAR);
    });

    it("Rate limits repeated booking attempts against the same booking type (429).", async () => {
        // Proves `@RateLimit()` is actually wired onto this endpoint. The shared `rateLimit` config is set
        // deliberately high for the rest of the suite (see test/config-defaults.ts), so this narrows it for
        // one test only, and disables the per-IP layer so the counter under test is unambiguously the
        // per-`METHOD path` one the decorator keys on.
        const rateLimiter: any = objectFactory.getInstance(RateLimiter);
        const original = rateLimiter.config;
        rateLimiter.config = { enabled: true, maxAttempts: 2, windowSeconds: 300, ip: { enabled: false } };
        try {
            const bookingType = await createBookingType();

            expect((await book(bookingType.slug, validBooking(SLOT_1))).status).toBe(200);
            expect((await book(bookingType.slug, validBooking(SLOT_2))).status).toBe(200);
            const third = await book(bookingType.slug, validBooking(NEXT_DAY_SLOT_1));

            expect(third.status).toBe(429);
        } finally {
            rateLimiter.config = original;
        }
    });

    it("Logs rather than throws when the mail transport refuses the confirmation's recipient.", async () => {
        const bookingType = await createBookingType();

        const result = await book(bookingType.slug, { ...validBooking(), bookerEmail: "reject@example.com" });

        // The booking itself has already been committed - a mail failure must not be surfaced to the booker.
        expect(result.status).toBe(200);
        expect(mailTransport.sent).toHaveLength(0);
    });

    it("Logs rather than throws when sending the confirmation fails outright.", async () => {
        const bookingType = await createBookingType();
        vi.spyOn(mailTransport, "send").mockRejectedValueOnce(new Error("smtp is down"));

        const result = await book(bookingType.slug, validBooking());

        // Same reasoning as above, for the harder failure: the write has already been committed by the time
        // the mail is attempted, so there is nothing a thrown error could usefully undo.
        expect(result.status).toBe(200);
        expect(mailTransport.sent).toHaveLength(0);
    });
    bookingSecuritySuite({
        app: () => server.getApplication(),
        baseUrl,
        mailboxUid: () => mailbox.uid,
        calendarFolderUid: () => calendarFolder.uid,
        createBookingType,
        createEvent,
        createEvents: async (data: any[]) => {
            for (let i = 0; i < data.length; i += 50) {
                await Promise.all(data.slice(i, i + 50).map((d) => createEvent(d)));
            }
        },
        createFolder: async (data: any) =>
            await folderRepo.save(new FolderSQL({ unreadCount: 0, totalCount: 0, syncKeyVersion: 0, ...data })),
        findEvents: async () => await calendarEventRepo.find(),
        findBookings: async () => await bookingRepo.find(),
        rateLimiter: () => objectFactory.getInstance(RateLimiter),
    });
});
