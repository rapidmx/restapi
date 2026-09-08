///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { buildEventIcs, parseIcsEvent } from "../../src/util/IcsUtils.js";
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

        it("Falls back to treating the value as UTC when TZID isn't a recognized IANA name.", () => {
            const raw = [
                "BEGIN:VCALENDAR",
                "METHOD:REQUEST",
                "BEGIN:VEVENT",
                "UID:u1",
                "DTSTART;TZID=Pacific Standard Time:20260615T120000",
                "SEQUENCE:0",
                "END:VEVENT",
                "END:VCALENDAR",
            ].join("\r\n");
            const parsed = parseIcsEvent(raw)!;
            expect(parsed.startDate!.toISOString()).toBe("2026-06-15T12:00:00.000Z");
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
});
