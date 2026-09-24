///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { computeBusyIntervals, computeBusyWindows, mergeBusyIntervals, type BusyInterval } from "../../src/util/FreeBusyUtils.js";
import {
    AttendeeResponseStatus,
    AttendeeRole,
    BusyStatus,
    CalendarEvent,
    CalendarEventStatus,
    RecipientType,
    RecurrenceFrequency,
} from "../../src/models/types.js";

/** A one-hour confirmed/busy event - the baseline every test varies one field of. */
function makeEvent(overrides?: Partial<CalendarEvent>): CalendarEvent {
    return {
        uid: "evt-1",
        version: 0,
        deleted: false,
        folderUid: "fld-1",
        mailboxUid: "mbx-1",
        title: "Standup",
        startDate: new Date("2026-06-01T13:00:00.000Z"),
        endDate: new Date("2026-06-01T14:00:00.000Z"),
        allDay: false,
        timezone: "UTC",
        organizer: { address: "boss@example.com", type: RecipientType.TO },
        attendees: [],
        status: CalendarEventStatus.CONFIRMED,
        busyStatus: BusyStatus.BUSY,
        icalUid: "ical-1",
        sequence: 0,
        ...overrides,
    } as CalendarEvent;
}

const attendee = (address: string, responseStatus: AttendeeResponseStatus, isOrganizer: boolean = false) => ({
    address,
    role: AttendeeRole.REQUIRED,
    responseStatus,
    isOrganizer,
});

const WINDOW_START = new Date("2026-06-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-06-30T00:00:00.000Z");
const ME = new Set(["me@example.com", "alias@example.com"]);
const at = (hour: number, day: number = 1): Date => new Date(Date.UTC(2026, 5, day, hour));
const interval = (start: Date, end: Date, tentative: boolean = false): BusyInterval => ({ start, end, tentative });

describe("computeBusyIntervals() Tests", () => {
    it("Reports the same windows as computeBusyWindows(), none of them tentative for a plain busy event.", () => {
        const events = [makeEvent(), makeEvent({ uid: "evt-2", icalUid: "ical-2", startDate: at(16), endDate: at(17) })];

        const intervals = computeBusyIntervals(events, WINDOW_START, WINDOW_END);

        expect(intervals.map((window) => [window.start, window.end, window.tentative])).toEqual([
            [at(13), at(14), false],
            [at(16), at(17), false],
        ]);
        expect(computeBusyWindows(events, WINDOW_START, WINDOW_END)).toEqual([
            { start: at(13), end: at(14) },
            { start: at(16), end: at(17) },
        ]);
    });

    it("Marks a tentative busyStatus as tentative and still skips cancelled and free events.", () => {
        const intervals = computeBusyIntervals(
            [
                makeEvent({ busyStatus: BusyStatus.TENTATIVE }),
                makeEvent({ uid: "evt-2", icalUid: "ical-2", status: CalendarEventStatus.CANCELLED }),
                makeEvent({ uid: "evt-3", icalUid: "ical-3", busyStatus: BusyStatus.FREE }),
                makeEvent({ uid: "evt-4", icalUid: "ical-4", busyStatus: BusyStatus.OUT_OF_OFFICE, startDate: at(20), endDate: at(21) }),
            ],
            WINDOW_START,
            WINDOW_END,
        );

        expect(intervals.map((window) => [window.start, window.tentative])).toEqual([
            [at(13), true],
            [at(20), false],
        ]);
    });

    it("Skips an event the owner declined - by any of their addresses - and marks unanswered or tentative answers tentative.", () => {
        const events = [
            makeEvent({ uid: "declined", icalUid: "i1", attendees: [attendee("Alias@Example.com", AttendeeResponseStatus.DECLINED)] }),
            makeEvent({ uid: "unanswered", icalUid: "i2", startDate: at(15), endDate: at(16), attendees: [attendee("me@example.com", AttendeeResponseStatus.NEEDS_ACTION)] }),
            makeEvent({ uid: "maybe", icalUid: "i3", startDate: at(17), endDate: at(18), attendees: [attendee("me@example.com", AttendeeResponseStatus.TENTATIVE)] }),
            makeEvent({ uid: "yes", icalUid: "i4", startDate: at(19), endDate: at(20), attendees: [attendee("me@example.com", AttendeeResponseStatus.ACCEPTED)] }),
            makeEvent({ uid: "other", icalUid: "i5", startDate: at(21), endDate: at(22), attendees: [attendee("someone@example.com", AttendeeResponseStatus.DECLINED)] }),
        ];

        const intervals = computeBusyIntervals(events, WINDOW_START, WINDOW_END, ME);

        expect(intervals.map((window) => [window.start, window.tentative])).toEqual([
            [at(15), true],
            [at(17), true],
            [at(19), false],
            [at(21), false],
        ]);
    });

    it("Ignores the owner's answer on an event they organize, and needs no answer at all without owner addresses.", () => {
        const organized = makeEvent({
            organizer: { address: "ME@example.com", type: RecipientType.TO },
            attendees: [attendee("me@example.com", AttendeeResponseStatus.NEEDS_ACTION), attendee("x@example.com", AttendeeResponseStatus.DECLINED)],
        });
        const flagged = makeEvent({
            uid: "flagged",
            icalUid: "i2",
            startDate: at(15),
            endDate: at(16),
            attendees: [attendee("me@example.com", AttendeeResponseStatus.DECLINED, true)],
        });

        expect(computeBusyIntervals([organized, flagged], WINDOW_START, WINDOW_END, ME).map((window) => window.tentative)).toEqual([false, false]);
        expect(computeBusyIntervals([flagged], WINDOW_START, WINDOW_END, new Set())).toHaveLength(1);
        expect(computeBusyIntervals([flagged], WINDOW_START, WINDOW_END)).toHaveLength(1);
        expect(computeBusyIntervals([makeEvent({ attendees: undefined, organizer: undefined })], WINDOW_START, WINDOW_END, ME)).toHaveLength(1);
    });

    it("Expands recurrence with a moved occurrence taking the master's place, the override's own answer deciding tentativeness.", () => {
        const master = makeEvent({
            uid: "master",
            icalUid: "series",
            recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, count: 3, exceptions: [at(13, 3)] },
        });
        const moved = makeEvent({
            uid: "moved",
            icalUid: "series",
            recurrenceId: at(13, 2),
            startDate: at(18, 2),
            endDate: at(19, 2),
            busyStatus: BusyStatus.TENTATIVE,
        });

        const intervals = computeBusyIntervals([master, moved], WINDOW_START, WINDOW_END, ME);

        expect(intervals.map((window) => [window.start, window.tentative]).sort((a, b) => (a[0] as Date).getTime() - (b[0] as Date).getTime())).toEqual([
            [at(13, 1), false],
            [at(18, 2), true],
        ]);
    });
});

describe("mergeBusyIntervals() Tests", () => {
    const shape = (windows: BusyInterval[]) => windows.map((window) => [window.start.toISOString().slice(11, 13), window.end.toISOString().slice(11, 13), window.tentative]);

    it("Sorts, and joins overlapping and touching windows of the same kind.", () => {
        const merged = mergeBusyIntervals(
            [interval(at(15), at(16)), interval(at(9), at(11)), interval(at(10), at(12)), interval(at(12), at(13)), interval(at(14), at(15))],
            WINDOW_START,
            WINDOW_END,
        );

        expect(shape(merged)).toEqual([
            ["09", "13", false],
            ["14", "16", false],
        ]);
    });

    it("Clips to the window and drops windows outside it and empty ones.", () => {
        const merged = mergeBusyIntervals(
            [
                interval(at(8), at(10)),
                interval(at(22), at(23, 2)),
                interval(at(1, 5), at(2, 5)),
                interval(at(12), at(12)),
                interval(at(13), at(12)),
            ],
            at(9),
            at(23),
        );

        expect(merged.map((window) => [window.start, window.end])).toEqual([
            [at(9), at(10)],
            [at(22), at(23)],
        ]);
    });

    it("Keeps a tentative window tentative alone, and firm where a firm window covers it.", () => {
        const merged = mergeBusyIntervals(
            [interval(at(9), at(13), true), interval(at(11), at(12)), interval(at(14), at(15), true), interval(at(15), at(16), true)],
            WINDOW_START,
            WINDOW_END,
        );

        expect(shape(merged)).toEqual([
            ["09", "11", true],
            ["11", "12", false],
            ["12", "13", true],
            ["14", "16", true],
        ]);
    });

    it("Returns nothing for nothing.", () => {
        expect(mergeBusyIntervals([], WINDOW_START, WINDOW_END)).toEqual([]);
    });
});
