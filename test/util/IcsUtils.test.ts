///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    buildEventIcs,
    convertLocalToUtc,
    expandOccurrences,
    expandOccurrencesDetailed,
    parseIcsEvent,
    resolveTimeZone,
} from "../../src/util/IcsUtils.js";
import {
    Attendee,
    AttendeeResponseStatus,
    AttendeeRole,
    CalendarEvent,
    CalendarEventStatus,
    BusyStatus,
    RecipientType,
    RecurrenceFrequency,
} from "../../src/models/types.js";

function makeAttendee(overrides: Partial<Attendee> = {}): Attendee {
    return {
        address: "attendee@example.com",
        displayName: "Attendee",
        role: AttendeeRole.REQUIRED,
        responseStatus: AttendeeResponseStatus.NEEDS_ACTION,
        isOrganizer: false,
        ...overrides,
    };
}

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
    return {
        uid: "event-1",
        version: 0,
        dateCreated: new Date(),
        dateModified: new Date(),
        deleted: false,
        folderUid: "folder-1",
        mailboxUid: "mbx-1",
        title: "Team Sync",
        location: "Room 100",
        startDate: new Date("2026-06-15T19:00:00.000Z"),
        endDate: new Date("2026-06-15T20:00:00.000Z"),
        allDay: false,
        timezone: "UTC",
        organizer: { address: "organizer@example.com", displayName: "Organizer", type: RecipientType.TO },
        attendees: [makeAttendee()],
        status: CalendarEventStatus.CONFIRMED,
        busyStatus: BusyStatus.BUSY,
        icalUid: "ical-uid-1",
        sequence: 0,
        ...overrides,
    };
}

describe("buildEventIcs() / parseIcsEvent() Tests", () => {
    it("Round-trips a REQUEST for a simple non-recurring event.", () => {
        const event = makeEvent();
        const ics = buildEventIcs(event, "REQUEST");

        expect(ics).toContain("METHOD:REQUEST");
        expect(ics).toContain(`UID:${event.icalUid}`);

        const parsed = parseIcsEvent(ics)!;
        expect(parsed.method).toBe("REQUEST");
        expect(parsed.uid).toBe(event.icalUid);
        expect(parsed.sequence).toBe(0);
        expect(parsed.summary).toBe("Team Sync");
        expect(parsed.location).toBe("Room 100");
        expect(parsed.startDate!.getTime()).toBe(event.startDate.getTime());
        expect(parsed.endDate!.getTime()).toBe(event.endDate.getTime());
        expect(parsed.organizer).toEqual({ address: "organizer@example.com", displayName: "Organizer" });
        expect(parsed.attendees).toEqual([{ address: "attendee@example.com", displayName: "Attendee", partstat: AttendeeResponseStatus.NEEDS_ACTION }]);
        expect(parsed.recurrenceId).toBeUndefined();
        expect(parsed.recurrenceRule).toBeUndefined();
    });

    it("Builds a valid ICS payload when startDate/endDate/recurrenceId/until come back as plain strings, not Date objects.", () => {
        // `CalendarEventMongo` persists (and returns) `startDate`/`endDate`/`recurrenceId` as plain
        // strings despite being typed `Date` - every real caller of `buildEventIcs()` (`respond()`,
        // `MeetingSchedulingJob`, `BaseBookingRoute`, `ScanQueueJob`) passes a value read straight off a
        // persisted `CalendarEvent`, so this is the shape that actually reaches `buildEventIcs()` in
        // production, not the always-a-real-`Date` shape every other test in this file constructs by hand.
        const event = makeEvent({
            startDate: "2026-06-15T19:00:00.000Z" as unknown as Date,
            endDate: "2026-06-15T20:00:00.000Z" as unknown as Date,
            recurrenceId: "2026-06-22T19:00:00.000Z" as unknown as Date,
            recurrenceRule: undefined,
        });

        const ics = buildEventIcs(event, "REQUEST");
        expect(ics).toContain("DTSTART:20260615T190000Z");
        expect(ics).toContain("DTEND:20260615T200000Z");
        expect(ics).toContain("RECURRENCE-ID:20260622T190000Z");
    });

    it("Builds a valid ICS payload when a persisted RecurrenceRule's until/exceptions come back as strings.", () => {
        const event = makeEvent({
            recurrenceRule: {
                freq: RecurrenceFrequency.DAILY,
                interval: 1,
                until: "2026-12-31T00:00:00.000Z" as unknown as Date,
                exceptions: ["2026-07-01T19:00:00.000Z" as unknown as Date],
            },
        });

        const ics = buildEventIcs(event, "REQUEST");
        expect(ics).toContain("UNTIL=20261231T000000Z");
        expect(ics).toContain("EXDATE:20260701T190000Z");
    });

    it("Emits one ATTENDEE line per attendee for REQUEST/CANCEL.", () => {
        const event = makeEvent({
            attendees: [makeAttendee({ address: "a@example.com" }), makeAttendee({ address: "b@example.com" })],
        });

        for (const method of ["REQUEST", "CANCEL"] as const) {
            const parsed = parseIcsEvent(buildEventIcs(event, method))!;
            expect(parsed.attendees.map((a) => a.address)).toEqual(["a@example.com", "b@example.com"]);
        }
    });

    it("REPLY emits exactly one ATTENDEE line (the responding attendee), not the whole list.", () => {
        const event = makeEvent({
            attendees: [makeAttendee({ address: "a@example.com" }), makeAttendee({ address: "b@example.com" })],
        });
        const onlyAttendee = makeAttendee({ address: "b@example.com", responseStatus: AttendeeResponseStatus.ACCEPTED });

        const ics = buildEventIcs(event, "REPLY", { onlyAttendee });
        const parsed = parseIcsEvent(ics)!;

        expect(parsed.method).toBe("REPLY");
        expect(parsed.attendees).toEqual([{ address: "b@example.com", displayName: "Attendee", partstat: AttendeeResponseStatus.ACCEPTED }]);
    });

    it("REPLY with no onlyAttendee given emits zero ATTENDEE lines.", () => {
        const event = makeEvent();
        const parsed = parseIcsEvent(buildEventIcs(event, "REPLY"))!;
        expect(parsed.attendees).toEqual([]);
    });

    it("Sets STATUS:CANCELLED for a CANCEL regardless of the event's own status field.", () => {
        const event = makeEvent({ status: CalendarEventStatus.CONFIRMED });
        const parsed = parseIcsEvent(buildEventIcs(event, "CANCEL"))!;
        expect(parsed.status).toBe("CANCELLED");
    });

    it("Escapes and unescapes TEXT values (comma, semicolon, backslash, newline) round-trip.", () => {
        const event = makeEvent({ title: 'Budget, Q3; "urgent"\\review', location: "Line one\nLine two" });
        const parsed = parseIcsEvent(buildEventIcs(event, "REQUEST"))!;
        expect(parsed.summary).toBe('Budget, Q3; "urgent"\\review');
        expect(parsed.location).toBe("Line one\nLine two");
    });

    it("Unfolds RFC 5545 folded continuation lines (a line starting with a single space).", () => {
        // Per RFC 5545, unfolding removes the CRLF *and* the single fold-marker whitespace character that
        // immediately follows it - any real space belongs at the end of the preceding fragment, not the start
        // of the folded one (hence the trailing space on the first fragment below).
        const raw = [
            "BEGIN:VCALENDAR",
            "METHOD:REQUEST",
            "BEGIN:VEVENT",
            "UID:folded-uid",
            "SUMMARY:This is a very long ",
            " summary that got folded",
            "SEQUENCE:0",
            "END:VEVENT",
            "END:VCALENDAR",
        ].join("\r\n");
        const parsed = parseIcsEvent(raw)!;
        expect(parsed.summary).toBe("This is a very long summary that got folded");
    });

    it("Returns undefined for a payload with no recognizable UID/METHOD.", () => {
        expect(parseIcsEvent("BEGIN:VCALENDAR\r\nEND:VCALENDAR")).toBeUndefined();
    });

    describe("Recurring meetings", () => {
        it("Round-trips RRULE + EXDATE for a master (whole-series) event.", () => {
            const event = makeEvent({
                recurrenceRule: {
                    freq: RecurrenceFrequency.WEEKLY,
                    interval: 2,
                    byDay: ["MO", "WE"],
                    count: 10,
                    exceptions: [new Date("2026-07-01T19:00:00.000Z")],
                },
            });

            const ics = buildEventIcs(event, "REQUEST");
            expect(ics).toContain("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10");
            expect(ics).toContain("EXDATE:20260701T190000Z");
            expect(ics).not.toContain("RECURRENCE-ID");

            const parsed = parseIcsEvent(ics)!;
            expect(parsed.recurrenceRule).toEqual({
                freq: RecurrenceFrequency.WEEKLY,
                interval: 2,
                byDay: ["MO", "WE"],
                byMonthDay: undefined,
                byMonth: undefined,
                count: 10,
                until: undefined,
                exceptions: [new Date("2026-07-01T19:00:00.000Z")],
            });
            expect(parsed.recurrenceId).toBeUndefined();
        });

        it("Round-trips RECURRENCE-ID for a single-occurrence override, with no RRULE/EXDATE.", () => {
            const event = makeEvent({ recurrenceId: new Date("2026-06-22T19:00:00.000Z"), recurrenceRule: undefined });

            const ics = buildEventIcs(event, "REQUEST");
            expect(ics).toContain("RECURRENCE-ID:20260622T190000Z");
            expect(ics).not.toContain("RRULE");
            expect(ics).not.toContain("EXDATE");

            const parsed = parseIcsEvent(ics)!;
            expect(parsed.recurrenceId!.getTime()).toBe(new Date("2026-06-22T19:00:00.000Z").getTime());
            expect(parsed.recurrenceRule).toBeUndefined();
        });

        it("A generated VEVENT never emits both RRULE and RECURRENCE-ID together.", () => {
            // recurrenceId takes precedence when (incorrectly) both are set on the same row.
            const event = makeEvent({
                recurrenceId: new Date("2026-06-22T19:00:00.000Z"),
                recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, exceptions: [] },
            });
            const ics = buildEventIcs(event, "REQUEST");
            expect(ics).toContain("RECURRENCE-ID");
            expect(ics).not.toContain("RRULE");
        });

        it("Round-trips an UNTIL-bounded RRULE.", () => {
            const event = makeEvent({
                recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, until: new Date("2026-12-31T00:00:00.000Z"), exceptions: [] },
            });
            const parsed = parseIcsEvent(buildEventIcs(event, "REQUEST"))!;
            expect(parsed.recurrenceRule!.until!.getTime()).toBe(new Date("2026-12-31T00:00:00.000Z").getTime());
            expect(parsed.recurrenceRule!.count).toBeUndefined();
        });

        it("Round-trips BYMONTHDAY/BYMONTH as numbers.", () => {
            const event = makeEvent({
                recurrenceRule: { freq: RecurrenceFrequency.YEARLY, interval: 1, byMonthDay: [15], byMonth: [6], exceptions: [] },
            });
            const parsed = parseIcsEvent(buildEventIcs(event, "REQUEST"))!;
            expect(parsed.recurrenceRule!.byMonthDay).toEqual([15]);
            expect(parsed.recurrenceRule!.byMonth).toEqual([6]);
        });
    });

    describe("Date/timezone parsing", () => {
        it("Parses a Z-suffixed UTC DTSTART directly.", () => {
            const raw = ["BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:u1", "DTSTART:20260615T120000Z", "SEQUENCE:0", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
            const parsed = parseIcsEvent(raw)!;
            expect(parsed.startDate!.toISOString()).toBe("2026-06-15T12:00:00.000Z");
        });

        it("Converts a TZID-qualified local time to UTC using a real IANA timezone.", () => {
            // 2026-06-15 noon in America/Los_Angeles is PDT (UTC-7) -> 19:00 UTC.
            const raw = [
                "BEGIN:VCALENDAR",
                "METHOD:REQUEST",
                "BEGIN:VEVENT",
                "UID:u1",
                "DTSTART;TZID=America/Los_Angeles:20260615T120000",
                "SEQUENCE:0",
                "END:VEVENT",
                "END:VCALENDAR",
            ].join("\r\n");
            const parsed = parseIcsEvent(raw)!;
            expect(parsed.startDate!.toISOString()).toBe("2026-06-15T19:00:00.000Z");
        });

        it("Falls back to treating the value as UTC when TZID is neither an IANA name nor a known Windows zone name.", () => {
            const raw = [
                "BEGIN:VCALENDAR",
                "METHOD:REQUEST",
                "BEGIN:VEVENT",
                "UID:u1",
                "DTSTART;TZID=Not A Real Zone:20260615T120000",
                "SEQUENCE:0",
                "END:VEVENT",
                "END:VCALENDAR",
            ].join("\r\n");
            const parsed = parseIcsEvent(raw)!;
            expect(parsed.startDate!.toISOString()).toBe("2026-06-15T12:00:00.000Z");
            expect(parsed.timezone).toBeUndefined();
        });

        it("Maps a Windows zone name TZID (as classic Outlook emits) to its IANA zone.", () => {
            const raw = [
                "BEGIN:VCALENDAR",
                "METHOD:REQUEST",
                "BEGIN:VEVENT",
                "UID:u1",
                "DTSTART;TZID=Pacific Standard Time:20260615T120000",
                'DTEND;TZID="W. Europe Standard Time":20260615T210000',
                "SEQUENCE:0",
                "END:VEVENT",
                "END:VCALENDAR",
            ].join("\r\n");
            const parsed = parseIcsEvent(raw)!;
            expect(parsed.startDate!.toISOString()).toBe("2026-06-15T19:00:00.000Z");
            // 21:00 CEST (UTC+2) -> 19:00 UTC.
            expect(parsed.endDate!.toISOString()).toBe("2026-06-15T19:00:00.000Z");
            expect(parsed.timezone).toBe("America/Los_Angeles");
        });

        it("Strips a DQUOTE-wrapped TZID value, and other quoted parameter values (even ones containing ':' or ';').", () => {
            const raw = [
                "BEGIN:VCALENDAR",
                "METHOD:REQUEST",
                "BEGIN:VEVENT",
                "UID:u1",
                'DTSTART;TZID="America/New_York":20260115T090000',
                'ORGANIZER;CN="Doe; John: Org":mailto:org@example.com',
                "SEQUENCE:0",
                "END:VEVENT",
                "END:VCALENDAR",
            ].join("\r\n");
            const parsed = parseIcsEvent(raw)!;
            expect(parsed.startDate!.toISOString()).toBe("2026-01-15T14:00:00.000Z");
            expect(parsed.timezone).toBe("America/New_York");
            expect(parsed.organizer).toEqual({ address: "org@example.com", displayName: "Doe; John: Org" });
        });

        it("resolveTimeZone() handles IANA names, Windows names (case-insensitive), quotes, and junk.", () => {
            expect(resolveTimeZone("Europe/Paris")).toBe("Europe/Paris");
            expect(resolveTimeZone('"Eastern Standard Time"')).toBe("America/New_York");
            expect(resolveTimeZone("tokyo standard time")).toBe("Asia/Tokyo");
            expect(resolveTimeZone("UTC")).toBe("UTC");
            expect(resolveTimeZone("AUS Eastern Standard Time")).toBe("Australia/Sydney");
            expect(resolveTimeZone("Not/AZone")).toBeUndefined();
            expect(resolveTimeZone('""')).toBeUndefined();
            expect(resolveTimeZone(undefined)).toBeUndefined();
        });

        it("convertLocalToUtc() is correct right around DST transitions (skipped and repeated wall-clock times).", () => {
            // 2026-03-08 02:30 doesn't exist in New York (clocks jump 02:00 EST -> 03:00 EDT): RFC 5545 says use
            // the pre-gap offset (EST, -5) -> 07:30Z.
            expect(convertLocalToUtc(2026, 3, 8, 2, 30, 0, "America/New_York")!.toISOString()).toBe("2026-03-08T07:30:00.000Z");
            // Just after the jump - 03:30 EDT (-4).
            expect(convertLocalToUtc(2026, 3, 8, 3, 30, 0, "America/New_York")!.toISOString()).toBe("2026-03-08T07:30:00.000Z");
            // Just before - 01:30 EST (-5).
            expect(convertLocalToUtc(2026, 3, 8, 1, 30, 0, "America/New_York")!.toISOString()).toBe("2026-03-08T06:30:00.000Z");
            // 2026-11-01 01:30 happens twice: the first (EDT, -4) wins.
            expect(convertLocalToUtc(2026, 11, 1, 1, 30, 0, "America/New_York")!.toISOString()).toBe("2026-11-01T05:30:00.000Z");
            expect(convertLocalToUtc(2026, 11, 1, 2, 30, 0, "America/New_York")!.toISOString()).toBe("2026-11-01T07:30:00.000Z");
            expect(convertLocalToUtc(2026, 1, 1, 0, 0, 0, "Bogus/Zone")).toBeUndefined();
        });

        it("Falls back to UTC for a bare DATE-TIME value with no Z and no TZID.", () => {
            const raw = ["BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:u1", "DTSTART:20260615T120000", "SEQUENCE:0", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
            const parsed = parseIcsEvent(raw)!;
            expect(parsed.startDate!.toISOString()).toBe("2026-06-15T12:00:00.000Z");
        });

        it("Parses a date-only (all-day) DTSTART value as midnight UTC.", () => {
            const raw = ["BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:u1", "DTSTART:20260615", "SEQUENCE:0", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
            const parsed = parseIcsEvent(raw)!;
            expect(parsed.startDate!.toISOString()).toBe("2026-06-15T00:00:00.000Z");
        });

        it("Leaves startDate undefined for a malformed DTSTART value.", () => {
            const raw = ["BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:u1", "DTSTART:not-a-date", "SEQUENCE:0", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
            const parsed = parseIcsEvent(raw)!;
            expect(parsed.startDate).toBeUndefined();
        });
    });

    describe("expandOccurrences()", () => {
        // 2026-06-15 is a Monday.
        const startDate = new Date("2026-06-15T19:00:00.000Z");
        const endDate = new Date("2026-06-15T20:00:00.000Z");

        it("A non-recurring event yields its own single occurrence when it overlaps the window.", () => {
            const occurrences = expandOccurrences({ startDate, endDate }, new Date("2026-06-01T00:00:00.000Z"), new Date("2026-07-01T00:00:00.000Z"));
            expect(occurrences).toEqual([{ start: startDate, end: endDate }]);
        });

        it("A non-recurring event yields nothing when it's entirely outside the window.", () => {
            const occurrences = expandOccurrences({ startDate, endDate }, new Date("2026-07-01T00:00:00.000Z"), new Date("2026-08-01T00:00:00.000Z"));
            expect(occurrences).toEqual([]);
        });

        it("A non-recurring event yields nothing when excluded via excludeDates matching its exact start.", () => {
            const occurrences = expandOccurrences(
                { startDate, endDate },
                new Date("2026-06-01T00:00:00.000Z"),
                new Date("2026-07-01T00:00:00.000Z"),
                [startDate],
            );
            expect(occurrences).toEqual([]);
        });

        it("DAILY with interval > 1 steps by that many days.", () => {
            const occurrences = expandOccurrences(
                { startDate, endDate, recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 3, exceptions: [] } },
                startDate,
                new Date("2026-06-24T23:59:59.000Z"),
            );
            expect(occurrences.map((o) => o.start.toISOString())).toEqual([
                "2026-06-15T19:00:00.000Z",
                "2026-06-18T19:00:00.000Z",
                "2026-06-21T19:00:00.000Z",
                "2026-06-24T19:00:00.000Z",
            ]);
        });

        it("WEEKLY with BYDAY and interval > 1 only matches the named weekdays in an active (every Nth) week.", () => {
            const occurrences = expandOccurrences(
                {
                    startDate,
                    endDate,
                    recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 2, byDay: ["MO", "WE"], exceptions: [] },
                },
                startDate,
                new Date("2026-07-02T23:59:59.000Z"),
            );
            expect(occurrences.map((o) => o.start.toISOString())).toEqual([
                "2026-06-15T19:00:00.000Z",
                "2026-06-17T19:00:00.000Z",
                "2026-06-29T19:00:00.000Z",
                "2026-07-01T19:00:00.000Z",
            ]);
        });

        it("WEEKLY with no BYDAY repeats only on the start's own weekday.", () => {
            const occurrences = expandOccurrences(
                { startDate, endDate, recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, exceptions: [] } },
                startDate,
                new Date("2026-06-29T23:59:59.000Z"),
            );
            expect(occurrences.map((o) => o.start.toISOString())).toEqual([
                "2026-06-15T19:00:00.000Z",
                "2026-06-22T19:00:00.000Z",
                "2026-06-29T19:00:00.000Z",
            ]);
        });

        it("MONTHLY with BYMONTHDAY repeats on that day-of-month every interval months.", () => {
            const occurrences = expandOccurrences(
                { startDate, endDate, recurrenceRule: { freq: RecurrenceFrequency.MONTHLY, interval: 1, byMonthDay: [15], exceptions: [] } },
                startDate,
                new Date("2026-08-15T23:59:59.000Z"),
            );
            expect(occurrences.map((o) => o.start.toISOString())).toEqual([
                "2026-06-15T19:00:00.000Z",
                "2026-07-15T19:00:00.000Z",
                "2026-08-15T19:00:00.000Z",
            ]);
        });

        it("MONTHLY with a plain (non-ordinal) BYDAY matches every occurrence of that weekday in the month.", () => {
            const occurrences = expandOccurrences(
                { startDate, endDate, recurrenceRule: { freq: RecurrenceFrequency.MONTHLY, interval: 1, byDay: ["MO"], exceptions: [] } },
                startDate,
                new Date("2026-06-30T23:59:59.000Z"),
            );
            expect(occurrences.map((o) => o.start.toISOString())).toEqual([
                "2026-06-15T19:00:00.000Z",
                "2026-06-22T19:00:00.000Z",
                "2026-06-29T19:00:00.000Z",
            ]);
        });

        it("MONTHLY with neither BYMONTHDAY nor BYDAY repeats on the start's own day-of-month.", () => {
            const occurrences = expandOccurrences(
                { startDate, endDate, recurrenceRule: { freq: RecurrenceFrequency.MONTHLY, interval: 2, exceptions: [] } },
                startDate,
                new Date("2026-10-15T23:59:59.000Z"),
            );
            expect(occurrences.map((o) => o.start.toISOString())).toEqual(["2026-06-15T19:00:00.000Z", "2026-08-15T19:00:00.000Z", "2026-10-15T19:00:00.000Z"]);
        });

        it("YEARLY with BYMONTH and BYMONTHDAY repeats on that month/day every interval years.", () => {
            const occurrences = expandOccurrences(
                { startDate, endDate, recurrenceRule: { freq: RecurrenceFrequency.YEARLY, interval: 1, byMonth: [6], byMonthDay: [15], exceptions: [] } },
                startDate,
                new Date("2028-06-15T23:59:59.000Z"),
            );
            expect(occurrences.map((o) => o.start.toISOString())).toEqual([
                "2026-06-15T19:00:00.000Z",
                "2027-06-15T19:00:00.000Z",
                "2028-06-15T19:00:00.000Z",
            ]);
        });

        it("YEARLY with BYDAY (no BYMONTHDAY) matches every occurrence of that weekday within the matching year(s).", () => {
            const occurrences = expandOccurrences(
                { startDate, endDate, recurrenceRule: { freq: RecurrenceFrequency.YEARLY, interval: 1, byMonth: [6], byDay: ["MO"], exceptions: [] } },
                startDate,
                new Date("2026-06-30T23:59:59.000Z"),
            );
            expect(occurrences.map((o) => o.start.toISOString())).toEqual([
                "2026-06-15T19:00:00.000Z",
                "2026-06-22T19:00:00.000Z",
                "2026-06-29T19:00:00.000Z",
            ]);
        });

        it("YEARLY with interval > 1 skips the off years.", () => {
            const occurrences = expandOccurrences(
                { startDate, endDate, recurrenceRule: { freq: RecurrenceFrequency.YEARLY, interval: 2, byMonth: [6], byMonthDay: [15], exceptions: [] } },
                startDate,
                new Date("2028-06-15T23:59:59.000Z"),
            );
            expect(occurrences.map((o) => o.start.toISOString())).toEqual(["2026-06-15T19:00:00.000Z", "2028-06-15T19:00:00.000Z"]);
        });

        it("An unrecognized recurrence frequency never matches any candidate day.", () => {
            const occurrences = expandOccurrences(
                { startDate, endDate, recurrenceRule: { freq: "bogus" as RecurrenceFrequency, interval: 1, exceptions: [] } },
                startDate,
                new Date("2026-07-01T00:00:00.000Z"),
            );
            expect(occurrences).toEqual([]);
        });

        it("YEARLY with neither BYMONTH/BYMONTHDAY/BYDAY repeats on the start's own month and day-of-month.", () => {
            const occurrences = expandOccurrences(
                { startDate, endDate, recurrenceRule: { freq: RecurrenceFrequency.YEARLY, interval: 1, exceptions: [] } },
                startDate,
                new Date("2028-06-15T23:59:59.000Z"),
            );
            expect(occurrences.map((o) => o.start.toISOString())).toEqual([
                "2026-06-15T19:00:00.000Z",
                "2027-06-15T19:00:00.000Z",
                "2028-06-15T19:00:00.000Z",
            ]);
        });

        it("Stops producing occurrences once COUNT has been reached, regardless of window size.", () => {
            const occurrences = expandOccurrences(
                { startDate, endDate, recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, count: 3, exceptions: [] } },
                startDate,
                new Date("2026-12-31T23:59:59.000Z"),
            );
            expect(occurrences.map((o) => o.start.toISOString())).toEqual([
                "2026-06-15T19:00:00.000Z",
                "2026-06-16T19:00:00.000Z",
                "2026-06-17T19:00:00.000Z",
            ]);
        });

        it("Stops producing occurrences once UNTIL is exceeded, inclusive of the exact UNTIL instant.", () => {
            const occurrences = expandOccurrences(
                {
                    startDate,
                    endDate,
                    recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, until: new Date("2026-06-17T19:00:00.000Z"), exceptions: [] },
                },
                startDate,
                new Date("2026-12-31T23:59:59.000Z"),
            );
            expect(occurrences.map((o) => o.start.toISOString())).toEqual([
                "2026-06-15T19:00:00.000Z",
                "2026-06-16T19:00:00.000Z",
                "2026-06-17T19:00:00.000Z",
            ]);
        });

        it("Does not consult RecurrenceRule.exceptions on its own - the caller must fold it into excludeDates.", () => {
            const rule = { freq: RecurrenceFrequency.DAILY, interval: 1, exceptions: [new Date("2026-06-16T19:00:00.000Z")] };
            const withoutExcludeDates = expandOccurrences({ startDate, endDate, recurrenceRule: rule }, startDate, new Date("2026-06-17T23:59:59.000Z"));
            expect(withoutExcludeDates.map((o) => o.start.toISOString())).toEqual([
                "2026-06-15T19:00:00.000Z",
                "2026-06-16T19:00:00.000Z",
                "2026-06-17T19:00:00.000Z",
            ]);

            const withExcludeDates = expandOccurrences(
                { startDate, endDate, recurrenceRule: rule },
                startDate,
                new Date("2026-06-17T23:59:59.000Z"),
                rule.exceptions,
            );
            expect(withExcludeDates.map((o) => o.start.toISOString())).toEqual(["2026-06-15T19:00:00.000Z", "2026-06-17T19:00:00.000Z"]);
        });

        it("Skips an occurrence via the excludeDates parameter independent of the rule's own exceptions - the mechanism a sibling override row's RECURRENCE-ID reuses.", () => {
            const occurrences = expandOccurrences(
                { startDate, endDate, recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, exceptions: [] } },
                startDate,
                new Date("2026-06-17T23:59:59.000Z"),
                [new Date("2026-06-16T19:00:00.000Z")],
            );
            expect(occurrences.map((o) => o.start.toISOString())).toEqual(["2026-06-15T19:00:00.000Z", "2026-06-17T19:00:00.000Z"]);
        });

        it("An indefinitely-recurring rule (no COUNT/UNTIL) is bounded by MAX_OCCURRENCES rather than hanging.", () => {
            const occurrences = expandOccurrences(
                { startDate, endDate, recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, exceptions: [] } },
                startDate,
                new Date("2036-06-15T23:59:59.000Z"),
            );
            expect(occurrences.length).toBe(500);
        });

        it("Expands a long-running series (started years before the window) in today's window - no scan cap from the series start.", () => {
            const occurrences = expandOccurrences(
                {
                    startDate: new Date("2019-01-07T15:00:00.000Z"),
                    endDate: new Date("2019-01-07T15:15:00.000Z"),
                    recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, exceptions: [] },
                },
                new Date("2026-06-15T00:00:00.000Z"),
                new Date("2026-06-17T00:00:00.000Z"),
            );
            expect(occurrences.map((o) => o.start.toISOString())).toEqual(["2026-06-15T15:00:00.000Z", "2026-06-16T15:00:00.000Z"]);

            const weekly = expandOccurrences(
                {
                    startDate: new Date("2018-01-03T15:00:00.000Z"), // a Wednesday
                    endDate: new Date("2018-01-03T16:00:00.000Z"),
                    recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 2, byDay: ["WE"], exceptions: [] },
                },
                new Date("2026-06-01T00:00:00.000Z"),
                new Date("2026-06-30T00:00:00.000Z"),
            );
            // Every other Wednesday from 2018-01-03 (2026-06-10 is exactly 440 weeks later).
            expect(weekly.map((o) => o.start.toISOString())).toEqual(["2026-06-10T15:00:00.000Z", "2026-06-24T15:00:00.000Z"]);

            const monthly = expandOccurrences(
                {
                    startDate: new Date("2010-03-31T12:00:00.000Z"),
                    endDate: new Date("2010-03-31T13:00:00.000Z"),
                    recurrenceRule: { freq: RecurrenceFrequency.MONTHLY, interval: 3, exceptions: [] },
                },
                new Date("2026-01-01T00:00:00.000Z"),
                new Date("2027-01-01T00:00:00.000Z"),
            );
            // Every 3rd month on the 31st - months without a 31st (June, September) are skipped, per RFC 5545.
            expect(monthly.map((o) => o.start.toISOString())).toEqual(["2026-03-31T12:00:00.000Z", "2026-12-31T12:00:00.000Z"]);
        });

        it("COUNT is still counted from the series start even when the window is far later.", () => {
            const rule = { freq: RecurrenceFrequency.DAILY, interval: 1, count: 2000, exceptions: [] };
            const event = { startDate: new Date("2020-01-01T10:00:00.000Z"), endDate: new Date("2020-01-01T11:00:00.000Z"), recurrenceRule: rule };
            // Occurrence #2000 is 2020-01-01 + 1999 days = 2025-06-22.
            const occurrences = expandOccurrences(event, new Date("2025-06-20T00:00:00.000Z"), new Date("2025-06-30T00:00:00.000Z"));
            expect(occurrences.map((o) => o.start.toISOString())).toEqual([
                "2025-06-20T10:00:00.000Z",
                "2025-06-21T10:00:00.000Z",
                "2025-06-22T10:00:00.000Z",
            ]);
        });

        it("MONTHLY with an ordinal BYDAY (2TU = second Tuesday, -1FR = last Friday).", () => {
            const secondTuesday = expandOccurrences(
                {
                    startDate: new Date("2026-01-13T17:00:00.000Z"),
                    endDate: new Date("2026-01-13T18:00:00.000Z"),
                    recurrenceRule: { freq: RecurrenceFrequency.MONTHLY, interval: 1, byDay: ["2TU"], exceptions: [] },
                },
                new Date("2026-01-01T00:00:00.000Z"),
                new Date("2026-04-30T00:00:00.000Z"),
            );
            expect(secondTuesday.map((o) => o.start.toISOString())).toEqual([
                "2026-01-13T17:00:00.000Z",
                "2026-02-10T17:00:00.000Z",
                "2026-03-10T17:00:00.000Z",
                "2026-04-14T17:00:00.000Z",
            ]);

            const lastFriday = expandOccurrences(
                {
                    startDate: new Date("2026-01-30T17:00:00.000Z"),
                    endDate: new Date("2026-01-30T18:00:00.000Z"),
                    recurrenceRule: { freq: RecurrenceFrequency.MONTHLY, interval: 1, byDay: ["-1FR"], count: 3, exceptions: [] },
                },
                new Date("2026-01-01T00:00:00.000Z"),
                new Date("2026-12-31T00:00:00.000Z"),
            );
            expect(lastFriday.map((o) => o.start.toISOString())).toEqual(["2026-01-30T17:00:00.000Z", "2026-02-27T17:00:00.000Z", "2026-03-27T17:00:00.000Z"]);
        });

        it("MONTHLY with a negative BYMONTHDAY (-1 = last day of the month).", () => {
            const occurrences = expandOccurrences(
                {
                    startDate: new Date("2026-01-31T09:00:00.000Z"),
                    endDate: new Date("2026-01-31T10:00:00.000Z"),
                    recurrenceRule: { freq: RecurrenceFrequency.MONTHLY, interval: 1, byMonthDay: [-1], exceptions: [] },
                },
                new Date("2026-01-01T00:00:00.000Z"),
                new Date("2026-03-31T23:00:00.000Z"),
            );
            expect(occurrences.map((o) => o.start.toISOString())).toEqual(["2026-01-31T09:00:00.000Z", "2026-02-28T09:00:00.000Z", "2026-03-31T09:00:00.000Z"]);
        });

        it("YEARLY with BYMONTH + ordinal BYDAY (US Thanksgiving: 4th Thursday of November).", () => {
            const occurrences = expandOccurrences(
                {
                    startDate: new Date("2026-11-26T17:00:00.000Z"),
                    endDate: new Date("2026-11-26T18:00:00.000Z"),
                    recurrenceRule: { freq: RecurrenceFrequency.YEARLY, interval: 1, byMonth: [11], byDay: ["4TH"], exceptions: [] },
                },
                new Date("2026-01-01T00:00:00.000Z"),
                new Date("2028-12-31T00:00:00.000Z"),
            );
            expect(occurrences.map((o) => o.start.toISOString())).toEqual(["2026-11-26T17:00:00.000Z", "2027-11-25T17:00:00.000Z", "2028-11-23T17:00:00.000Z"]);
        });

        it("Steps in the event's own time zone, so local time of day survives a DST change (America/New_York).", () => {
            // Mondays 09:00 New York: EST (UTC-5) before 2026-03-08, EDT (UTC-4) after.
            const occurrences = expandOccurrences(
                {
                    startDate: new Date("2026-03-02T14:00:00.000Z"),
                    endDate: new Date("2026-03-02T15:00:00.000Z"),
                    timezone: "America/New_York",
                    recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, exceptions: [] },
                },
                new Date("2026-03-01T00:00:00.000Z"),
                new Date("2026-03-17T00:00:00.000Z"),
                [new Date("2026-03-16T13:00:00.000Z")],
            );
            expect(occurrences.map((o) => [o.start.toISOString(), o.end.toISOString()])).toEqual([
                ["2026-03-02T14:00:00.000Z", "2026-03-02T15:00:00.000Z"],
                ["2026-03-09T13:00:00.000Z", "2026-03-09T14:00:00.000Z"],
            ]);
        });

        it("Accepts a Windows zone name as the event timezone, and matches BYDAY against the local (not UTC) weekday.", () => {
            // Tuesday 2026-06-16 18:00 in Los Angeles is Wednesday 01:00 UTC - BYDAY=TU must match the local day.
            const occurrences = expandOccurrences(
                {
                    startDate: new Date("2026-06-17T01:00:00.000Z"),
                    endDate: new Date("2026-06-17T02:00:00.000Z"),
                    timezone: "Pacific Standard Time",
                    recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, byDay: ["TU"], exceptions: [] },
                },
                new Date("2026-06-16T00:00:00.000Z"),
                new Date("2026-06-25T00:00:00.000Z"),
            );
            expect(occurrences.map((o) => o.start.toISOString())).toEqual(["2026-06-17T01:00:00.000Z", "2026-06-24T01:00:00.000Z"]);
        });

        it("Expands an allDay event in UTC regardless of its timezone, and coerces string-typed persisted dates.", () => {
            const occurrences = expandOccurrences(
                {
                    startDate: "2026-03-07T00:00:00.000Z",
                    endDate: "2026-03-08T00:00:00.000Z",
                    allDay: true,
                    timezone: "America/New_York",
                    recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, until: "2026-03-09T00:00:00.000Z" as any, exceptions: [] },
                },
                new Date("2026-03-01T00:00:00.000Z"),
                new Date("2026-03-20T00:00:00.000Z"),
                ["2026-03-08T00:00:00.000Z"],
            );
            expect(occurrences.map((o) => o.start.toISOString())).toEqual(["2026-03-07T00:00:00.000Z", "2026-03-09T00:00:00.000Z"]);
        });

        it("WEEKLY interval > 1 aligns weeks on Monday (WKST=MO) - a Monday BYDAY before a mid-week start belongs to the start's own week.", () => {
            // Starts Wednesday 2026-06-17, every 2 weeks on MO,WE: week of 06-15 (its Monday is before DTSTART, so
            // skipped), then week of 06-29.
            const occurrences = expandOccurrences(
                {
                    startDate: new Date("2026-06-17T19:00:00.000Z"),
                    endDate: new Date("2026-06-17T20:00:00.000Z"),
                    recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 2, byDay: ["MO", "WE"], exceptions: [] },
                },
                new Date("2026-06-01T00:00:00.000Z"),
                new Date("2026-07-05T00:00:00.000Z"),
            );
            expect(occurrences.map((o) => o.start.toISOString())).toEqual(["2026-06-17T19:00:00.000Z", "2026-06-29T19:00:00.000Z", "2026-07-01T19:00:00.000Z"]);
        });

        it("MONTHLY with both BYMONTHDAY and BYDAY matches only their intersection (Friday the 13th).", () => {
            const occurrences = expandOccurrences(
                { startDate, endDate, recurrenceRule: { freq: RecurrenceFrequency.MONTHLY, interval: 1, byMonthDay: [13], byDay: ["FR"], exceptions: [] } },
                startDate,
                new Date("2027-01-01T00:00:00.000Z"),
            );
            expect(occurrences.map((o) => o.start.toISOString())).toEqual(["2026-11-13T19:00:00.000Z"]);
        });

        it("DAILY with BYMONTHDAY and BYDAY only keeps days matching both (a month's last day that's also a Tuesday).", () => {
            const occurrences = expandOccurrences(
                { startDate, endDate, recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, byMonthDay: [-1], byDay: ["TU"], exceptions: [] } },
                startDate,
                new Date("2026-07-31T23:59:59.000Z"),
            );
            expect(occurrences.map((o) => o.start.toISOString())).toEqual(["2026-06-30T19:00:00.000Z"]);
        });

        it("DAILY with BYMONTH only keeps days in the named month(s), counting COUNT from there.", () => {
            const occurrences = expandOccurrences(
                { startDate, endDate, recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, byMonth: [7], count: 2, exceptions: [] } },
                startDate,
                new Date("2026-12-31T23:59:59.000Z"),
            );
            expect(occurrences.map((o) => o.start.toISOString())).toEqual(["2026-07-01T19:00:00.000Z", "2026-07-02T19:00:00.000Z"]);
        });

        it("YEARLY with BYMONTHDAY but no BYMONTH repeats on that day of every month.", () => {
            const occurrences = expandOccurrences(
                { startDate, endDate, recurrenceRule: { freq: RecurrenceFrequency.YEARLY, interval: 1, byMonthDay: [15], exceptions: [] } },
                startDate,
                new Date("2026-08-16T00:00:00.000Z"),
            );
            expect(occurrences.map((o) => o.start.toISOString())).toEqual(["2026-06-15T19:00:00.000Z", "2026-07-15T19:00:00.000Z", "2026-08-15T19:00:00.000Z"]);
        });

        it("YEARLY with an ordinal BYDAY but no BYMONTH counts within the whole year (20th Monday).", () => {
            const occurrences = expandOccurrences(
                { startDate, endDate, recurrenceRule: { freq: RecurrenceFrequency.YEARLY, interval: 1, byDay: ["20MO"], exceptions: [] } },
                startDate,
                new Date("2027-12-31T23:59:59.000Z"),
            );
            // 2026's 20th Monday (May 18) is before DTSTART; 2027's is May 17.
            expect(occurrences.map((o) => o.start.toISOString())).toEqual(["2027-05-17T19:00:00.000Z"]);
        });

        it("YEARLY with no COUNT jumps straight to a window years after the series start.", () => {
            const occurrences = expandOccurrences(
                { startDate, endDate, recurrenceRule: { freq: RecurrenceFrequency.YEARLY, interval: 1, exceptions: [] } },
                new Date("2030-01-01T00:00:00.000Z"),
                new Date("2031-12-31T23:59:59.000Z"),
            );
            expect(occurrences.map((o) => o.start.toISOString())).toEqual(["2030-06-15T19:00:00.000Z", "2031-06-15T19:00:00.000Z"]);
        });
    });

    describe("resolveTimeZone() formatter cache", () => {
        it("Keeps resolving correctly after the cache is reset by a flood of distinct unknown zone names.", () => {
            for (let i = 0; i < 1002; i++) {
                expect(resolveTimeZone(`Not/A_Real_Zone_${i}`)).toBeUndefined();
            }
            expect(resolveTimeZone("America/New_York")).toBe("America/New_York");
            expect(resolveTimeZone("Not/A_Real_Zone_0")).toBeUndefined();
        });
    });

    describe("Component (BEGIN/END) tracking", () => {
        const wrap = (...body: string[]): string => ["BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST", ...body, "END:VCALENDAR"].join("\r\n");

        it("Never applies a VTIMEZONE's own DTSTART/RRULE to the event.", () => {
            const raw = wrap(
                "BEGIN:VTIMEZONE",
                "TZID:America/New_York",
                "BEGIN:STANDARD",
                "DTSTART:19701101T020000",
                "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
                "TZOFFSETFROM:-0400",
                "TZOFFSETTO:-0500",
                "END:STANDARD",
                "BEGIN:DAYLIGHT",
                "DTSTART:19700308T020000",
                "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
                "END:DAYLIGHT",
                "END:VTIMEZONE",
                "BEGIN:VEVENT",
                "UID:tz-uid",
                "DTSTART;TZID=America/New_York:20260615T090000",
                "DTEND;TZID=America/New_York:20260615T100000",
                "END:VEVENT",
            );
            const parsed = parseIcsEvent(raw)!;
            expect(parsed.recurrenceRule).toBeUndefined();
            expect(parsed.startDate!.toISOString()).toBe("2026-06-15T13:00:00.000Z");
            expect(parsed.timezone).toBe("America/New_York");
        });

        it("Never treats a VALARM's ATTENDEE/SUMMARY lines as the event's own.", () => {
            const raw = wrap(
                "BEGIN:VEVENT",
                "UID:alarm-uid",
                "SUMMARY:Real title",
                "DTSTART:20260615T120000Z",
                "ATTENDEE;PARTSTAT=ACCEPTED:mailto:real@example.com",
                "BEGIN:VALARM",
                "ACTION:EMAIL",
                "SUMMARY:Alarm title",
                "ATTENDEE:mailto:alarm-recipient@example.com",
                "END:VALARM",
                "ATTENDEE:mailto:after-alarm@example.com",
                "END:VEVENT",
            );
            const parsed = parseIcsEvent(raw)!;
            expect(parsed.summary).toBe("Real title");
            expect(parsed.attendees.map((a) => a.address)).toEqual(["real@example.com", "after-alarm@example.com"]);
        });

        it("Uses the first VEVENT without RECURRENCE-ID as the master and returns the others as overrides, never merging them.", () => {
            const raw = wrap(
                "BEGIN:VEVENT",
                "UID:series-uid",
                "RECURRENCE-ID:20260622T190000Z",
                "SEQUENCE:2",
                "SUMMARY:Moved occurrence",
                "DTSTART:20260622T210000Z",
                "DTEND:20260622T220000Z",
                "ATTENDEE:mailto:override-only@example.com",
                "END:VEVENT",
                "BEGIN:VEVENT",
                "UID:series-uid",
                "SEQUENCE:1",
                "SUMMARY:Weekly",
                "DTSTAMP:20260601T101500Z",
                "DTSTART:20260615T190000Z",
                "DTEND:20260615T200000Z",
                "RRULE:FREQ=WEEKLY;COUNT=4",
                "EXDATE:20260629T190000Z",
                "ATTENDEE:mailto:master@example.com",
                "END:VEVENT",
                "BEGIN:VEVENT",
                "UID:some-other-uid",
                "RECURRENCE-ID:20260622T190000Z",
                "DTSTART:20260622T190000Z",
                "END:VEVENT",
            );
            const parsed = parseIcsEvent(raw)!;
            expect(parsed.uid).toBe("series-uid");
            expect(parsed.summary).toBe("Weekly");
            expect(parsed.sequence).toBe(1);
            expect(parsed.recurrenceId).toBeUndefined();
            expect(parsed.startDate!.toISOString()).toBe("2026-06-15T19:00:00.000Z");
            expect(parsed.recurrenceRule!.count).toBe(4);
            expect(parsed.recurrenceRule!.exceptions).toEqual([new Date("2026-06-29T19:00:00.000Z")]);
            expect(parsed.attendees.map((a) => a.address)).toEqual(["master@example.com"]);
            expect(parsed.dtstamp!.toISOString()).toBe("2026-06-01T10:15:00.000Z");

            expect(parsed.overrides).toHaveLength(1);
            const override = parsed.overrides![0];
            expect(override.recurrenceId!.toISOString()).toBe("2026-06-22T19:00:00.000Z");
            expect(override.summary).toBe("Moved occurrence");
            expect(override.sequence).toBe(2);
            expect(override.recurrenceRule).toBeUndefined();
            expect(override.attendees.map((a) => a.address)).toEqual(["override-only@example.com"]);
        });

        it("Falls back to the first VEVENT when every VEVENT has a RECURRENCE-ID (a single-occurrence message).", () => {
            const raw = wrap(
                "BEGIN:VEVENT",
                "UID:occ-uid",
                "RECURRENCE-ID:20260622T190000Z",
                "SUMMARY:First",
                "END:VEVENT",
                "BEGIN:VEVENT",
                "UID:occ-uid",
                "RECURRENCE-ID:20260629T190000Z",
                "SUMMARY:Second",
                "END:VEVENT",
            );
            const parsed = parseIcsEvent(raw)!;
            expect(parsed.summary).toBe("First");
            expect(parsed.recurrenceId!.toISOString()).toBe("2026-06-22T19:00:00.000Z");
            expect(parsed.overrides!.map((o) => o.summary)).toEqual(["Second"]);
        });

        it("Omits overrides and dtstamp for a plain single-VEVENT message without DTSTAMP.", () => {
            const parsed = parseIcsEvent(wrap("BEGIN:VEVENT", "UID:plain", "DTSTART:20260615T120000Z", "END:VEVENT"))!;
            expect(parsed.overrides).toBeUndefined();
            expect(parsed.dtstamp).toBeUndefined();
        });

        it("Parses DTSTAMP from a generated payload.", () => {
            const before = Date.now() - 1000;
            const parsed = parseIcsEvent(buildEventIcs(makeEvent(), "REQUEST"))!;
            expect(parsed.dtstamp!.getTime()).toBeGreaterThanOrEqual(before);
        });

        it("Skips unrecognized properties and malformed (non content-line) lines inside a VEVENT.", () => {
            const parsed = parseIcsEvent(
                wrap("BEGIN:VEVENT", "UID:x-uid", "X-MICROSOFT-CDO-BUSYSTATUS:BUSY", "this line has no colon", "SUMMARY:Kept", "END:VEVENT"),
            )!;
            expect(parsed.uid).toBe("x-uid");
            expect(parsed.summary).toBe("Kept");
        });

        it("Tolerates a bare VEVENT with no VCALENDAR wrapper, and a stray END with no matching BEGIN.", () => {
            const raw = ["METHOD:REQUEST", "BEGIN:VEVENT", "UID:bare", "END:VALARM", "SUMMARY:Still in the event", "END:VEVENT"].join("\n");
            const parsed = parseIcsEvent(raw)!;
            expect(parsed.method).toBe("REQUEST");
            expect(parsed.uid).toBe("bare");
            expect(parsed.summary).toBe("Still in the event");
        });

        it("Ignores a VEVENT nested inside some other component.", () => {
            const nestedInTodo = wrap("BEGIN:VTODO", "BEGIN:VEVENT", "UID:nested", "END:VEVENT", "END:VTODO");
            expect(parseIcsEvent(nestedInTodo)).toBeUndefined();
            const deeplyNested = wrap("BEGIN:VEVENT", "UID:outer", "BEGIN:VALARM", "BEGIN:VEVENT", "UID:inner", "SUMMARY:Inner", "END:VEVENT", "END:VALARM", "END:VEVENT");
            const parsed = parseIcsEvent(deeplyNested)!;
            expect(parsed.uid).toBe("outer");
            expect(parsed.summary).toBeUndefined();
            expect(parsed.overrides).toBeUndefined();
        });

        it("Ignores a METHOD line nested inside a VEVENT.", () => {
            const raw = ["BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:m", "METHOD:CANCEL", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
            expect(parseIcsEvent(raw)!.method).toBe("REQUEST");
        });

        it("Returns undefined when there is no VEVENT at all, even if a UID appears elsewhere.", () => {
            expect(parseIcsEvent(wrap("BEGIN:VTODO", "UID:todo-uid", "END:VTODO"))).toBeUndefined();
        });
    });

    describe("Generated-output injection hardening", () => {
        const contentLines = (ics: string): string[] => ics.split("\r\n");

        it("A CR/LF in a TEXT value can't start a new content line.", () => {
            const event = makeEvent({ title: "Hi\r\nATTENDEE:mailto:evil@evil.com\rORGANIZER:mailto:evil@evil.com", location: "A\nB" });
            const ics = buildEventIcs(event, "REQUEST");
            expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
            expect(contentLines(ics).some((line) => line.startsWith("ATTENDEE:mailto:evil"))).toBe(false);
            expect(contentLines(ics).some((line) => line.startsWith("ORGANIZER:mailto:evil"))).toBe(false);

            const parsed = parseIcsEvent(ics)!;
            expect(parsed.summary).toBe("Hi\nATTENDEE:mailto:evil@evil.com\nORGANIZER:mailto:evil@evil.com");
            expect(parsed.location).toBe("A\nB");
            expect(parsed.attendees.map((a) => a.address)).toEqual(["attendee@example.com"]);
            expect(parsed.organizer!.address).toBe("organizer@example.com");
        });

        it("A display name can't inject parameters or properties via quotes, ';', ':' or CR/LF.", () => {
            const event = makeEvent({
                organizer: { address: "organizer@example.com", displayName: 'Org";SENT-BY="mailto:evil@evil.com', type: RecipientType.TO },
                attendees: [
                    makeAttendee({
                        displayName: 'Evil";PARTSTAT=ACCEPTED:mailto:x@x.com\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:evil@evil.com',
                    }),
                ],
            });
            const ics = buildEventIcs(event, "REQUEST");
            expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);

            const parsed = parseIcsEvent(ics)!;
            expect(parsed.attendees).toHaveLength(1);
            expect(parsed.attendees[0].address).toBe("attendee@example.com");
            expect(parsed.attendees[0].partstat).toBe(AttendeeResponseStatus.NEEDS_ACTION);
            expect(parsed.attendees[0].displayName).toBe("Evil;PARTSTAT=ACCEPTED:mailto:x@x.comATTENDEE;PARTSTAT=ACCEPTED:mailto:evil@evil.com");
            expect(parsed.organizer).toEqual({ address: "organizer@example.com", displayName: "Org;SENT-BY=mailto:evil@evil.com" });
        });

        it("Round-trips a display name containing a comma exactly (quoted, not backslash-escaped).", () => {
            const event = makeEvent({ attendees: [makeAttendee({ displayName: "Doe, John" })] });
            const ics = buildEventIcs(event, "REQUEST");
            expect(ics).toContain('CN="Doe, John"');
            expect(parseIcsEvent(ics)!.attendees[0].displayName).toBe("Doe, John");
        });

        it("Strips CR/LF from an address or UID interpolated into a content line.", () => {
            const event = makeEvent({ icalUid: "uid-1\r\nATTENDEE:mailto:evil@evil.com", attendees: [makeAttendee({ address: "a@example.com\r\nX-EVIL:1" })] });
            const ics = buildEventIcs(event, "REQUEST");
            expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
            expect(contentLines(ics).some((line) => line.startsWith("X-EVIL") || line.startsWith("ATTENDEE:mailto:evil"))).toBe(false);
        });
    });

    describe("DATE-form UNTIL", () => {
        it("Is the end of that local day in the event's TZID, so an occurrence later that day is included.", () => {
            const raw = [
                "BEGIN:VCALENDAR",
                "METHOD:REQUEST",
                "BEGIN:VEVENT",
                "UID:until-uid",
                "RRULE:FREQ=DAILY;UNTIL=20261231",
                "DTSTART;TZID=America/Los_Angeles:20261230T170000",
                "DTEND;TZID=America/Los_Angeles:20261230T180000",
                "END:VEVENT",
                "END:VCALENDAR",
            ].join("\r\n");
            const parsed = parseIcsEvent(raw)!;
            expect(parsed.recurrenceRule!.until!.toISOString()).toBe("2027-01-01T07:59:59.999Z");

            const occurrences = expandOccurrences(
                { startDate: parsed.startDate!, endDate: parsed.endDate!, recurrenceRule: parsed.recurrenceRule, timezone: parsed.timezone },
                new Date("2026-12-01T00:00:00.000Z"),
                new Date("2027-02-01T00:00:00.000Z"),
            );
            expect(occurrences.map((o) => o.start.toISOString())).toEqual(["2026-12-31T01:00:00.000Z", "2027-01-01T01:00:00.000Z"]);
        });

        it("Is the end of that UTC day for a UTC DTSTART.", () => {
            const raw = [
                "BEGIN:VCALENDAR",
                "METHOD:REQUEST",
                "BEGIN:VEVENT",
                "UID:until-utc",
                "DTSTART:20261230T170000Z",
                "DTEND:20261230T180000Z",
                "RRULE:FREQ=DAILY;UNTIL=20261231",
                "END:VEVENT",
                "END:VCALENDAR",
            ].join("\r\n");
            const parsed = parseIcsEvent(raw)!;
            expect(parsed.recurrenceRule!.until!.toISOString()).toBe("2026-12-31T23:59:59.999Z");
            const occurrences = expandOccurrences(
                { startDate: parsed.startDate!, endDate: parsed.endDate!, recurrenceRule: parsed.recurrenceRule },
                new Date("2026-12-01T00:00:00.000Z"),
                new Date("2027-02-01T00:00:00.000Z"),
            );
            expect(occurrences).toHaveLength(2);
        });

        it("Falls back to the end of the UTC day when the event's TZID is unrecognizable.", () => {
            const raw = [
                "BEGIN:VCALENDAR",
                "METHOD:REQUEST",
                "BEGIN:VEVENT",
                "UID:until-junk-tz",
                "DTSTART;TZID=Not A Real Zone:20261230T170000",
                "RRULE:FREQ=DAILY;UNTIL=20261231",
                "END:VEVENT",
                "END:VCALENDAR",
            ].join("\r\n");
            expect(parseIcsEvent(raw)!.recurrenceRule!.until!.toISOString()).toBe("2026-12-31T23:59:59.999Z");
        });

        it("Still reads a Z-suffixed DATE-TIME UNTIL as an exact UTC instant.", () => {
            const raw = [
                "BEGIN:VCALENDAR",
                "METHOD:REQUEST",
                "BEGIN:VEVENT",
                "UID:until-exact",
                "DTSTART;TZID=America/Los_Angeles:20261230T170000",
                "RRULE:FREQ=DAILY;UNTIL=20261231T010000Z",
                "END:VEVENT",
                "END:VCALENDAR",
            ].join("\r\n");
            expect(parseIcsEvent(raw)!.recurrenceRule!.until!.toISOString()).toBe("2026-12-31T01:00:00.000Z");
        });
    });

    describe("expandOccurrencesDetailed() truncation", () => {
        const startDate = new Date("2026-01-01T09:00:00.000Z");
        const endDate = new Date("2026-01-01T10:00:00.000Z");

        it("Reports truncated=true when MAX_OCCURRENCES (500) is hit.", () => {
            const windowStart = new Date("2026-01-01T00:00:00.000Z");
            const windowEnd = new Date(windowStart.getTime() + 731 * 24 * 60 * 60 * 1000);
            const result = expandOccurrencesDetailed(
                { startDate, endDate, recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, exceptions: [] } },
                windowStart,
                windowEnd,
            );
            expect(result.truncated).toBe(true);
            expect(result.occurrences).toHaveLength(500);
        });

        it("Reports truncated=false for exactly MAX_OCCURRENCES occurrences, and true only once another one exists.", () => {
            const windowStart = new Date("2026-01-01T00:00:00.000Z");
            const rule = { freq: RecurrenceFrequency.DAILY, interval: 1, exceptions: [] };
            const exact = expandOccurrencesDetailed({ startDate, endDate, recurrenceRule: rule }, windowStart, new Date(windowStart.getTime() + 500 * 24 * 60 * 60 * 1000));
            expect(exact.truncated).toBe(false);
            expect(exact.occurrences).toHaveLength(500);
            const oneMore = expandOccurrencesDetailed({ startDate, endDate, recurrenceRule: rule }, windowStart, new Date(windowStart.getTime() + 501 * 24 * 60 * 60 * 1000));
            expect(oneMore.truncated).toBe(true);
            expect(oneMore.occurrences).toHaveLength(500);
        });

        it("Reports truncated=false when the whole window fits under the caps.", () => {
            const windowStart = new Date("2026-01-01T00:00:00.000Z");
            const windowEnd = new Date("2026-03-01T00:00:00.000Z");
            const daily = expandOccurrencesDetailed(
                { startDate, endDate, recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, exceptions: [] } },
                windowStart,
                windowEnd,
            );
            expect(daily.truncated).toBe(false);
            expect(daily.occurrences).toHaveLength(59);

            const counted = expandOccurrencesDetailed(
                { startDate, endDate, recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, count: 3, exceptions: [] } },
                windowStart,
                new Date(windowStart.getTime() + 731 * 24 * 60 * 60 * 1000),
            );
            expect(counted.truncated).toBe(false);
            expect(counted.occurrences).toHaveLength(3);

            const single = expandOccurrencesDetailed({ startDate, endDate }, windowStart, windowEnd);
            expect(single).toEqual({ occurrences: [{ start: startDate, end: endDate }], truncated: false });
        });

        it("Reports truncated=true when MAX_PERIODS is hit by a rule that can never match over a huge window.", () => {
            // February never has a 31st, so every one of the 50,000 walked days is a non-match.
            const result = expandOccurrencesDetailed(
                { startDate, endDate, recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, byMonth: [2], byMonthDay: [31], exceptions: [] } },
                new Date("2026-01-01T00:00:00.000Z"),
                new Date("2250-01-01T00:00:00.000Z"),
            );
            expect(result.occurrences).toEqual([]);
            expect(result.truncated).toBe(true);
        });

        it("Reports truncated=false when COUNT runs out before the window even starts.", () => {
            const result = expandOccurrencesDetailed(
                { startDate, endDate, recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, count: 3, exceptions: [] } },
                new Date("2027-01-01T00:00:00.000Z"),
                new Date("2027-02-01T00:00:00.000Z"),
            );
            expect(result).toEqual({ occurrences: [], truncated: false });
        });

        it("expandOccurrences() returns the same occurrences as expandOccurrencesDetailed().", () => {
            const event = { startDate, endDate, recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, exceptions: [] } };
            const windowStart = new Date("2026-01-01T00:00:00.000Z");
            const windowEnd = new Date("2026-06-01T00:00:00.000Z");
            expect(expandOccurrences(event, windowStart, windowEnd)).toEqual(expandOccurrencesDetailed(event, windowStart, windowEnd).occurrences);
        });
    });
});
