///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { computeBusyWindows } from "../../src/util/FreeBusyUtils.js";
import {
    BusyStatus,
    CalendarEvent,
    CalendarEventStatus,
    RecipientType,
    RecurrenceFrequency,
    type RecurrenceRule,
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
        organizer: { address: "ada@example.com", type: RecipientType.TO },
        attendees: [],
        status: CalendarEventStatus.CONFIRMED,
        busyStatus: BusyStatus.BUSY,
        icalUid: "ical-1",
        sequence: 0,
        ...overrides,
    } as CalendarEvent;
}

const WINDOW_START = new Date("2026-06-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-06-30T00:00:00.000Z");

const isoStarts = (windows: { start: Date }[]): string[] => windows.map((window) => window.start.toISOString());

describe("computeBusyWindows() Tests", () => {
    it("Returns a single window for a single non-recurring event.", () => {
        const busy = computeBusyWindows([makeEvent()], WINDOW_START, WINDOW_END);

        expect(isoStarts(busy)).toEqual(["2026-06-01T13:00:00.000Z"]);
        expect(busy[0].end.toISOString()).toBe("2026-06-01T14:00:00.000Z");
    });

    it("Returns nothing for an event entirely outside the window.", () => {
        const event = makeEvent({
            startDate: new Date("2026-07-01T13:00:00.000Z"),
            endDate: new Date("2026-07-01T14:00:00.000Z"),
        });

        expect(computeBusyWindows([event], WINDOW_START, WINDOW_END)).toEqual([]);
    });

    it("Skips a cancelled event - it no longer occupies the owner's time.", () => {
        expect(computeBusyWindows([makeEvent({ status: CalendarEventStatus.CANCELLED })], WINDOW_START, WINDOW_END)).toEqual([]);
    });

    it("Skips an event marked free, even though it is confirmed.", () => {
        expect(computeBusyWindows([makeEvent({ busyStatus: BusyStatus.FREE })], WINDOW_START, WINDOW_END)).toEqual([]);
    });

    it("Keeps a tentative event - a held slot is still not offerable.", () => {
        const busy = computeBusyWindows(
            [makeEvent({ status: CalendarEventStatus.TENTATIVE, busyStatus: BusyStatus.TENTATIVE })],
            WINDOW_START,
            WINDOW_END,
        );

        expect(busy).toHaveLength(1);
    });

    describe("recurring series", () => {
        const dailyRule: RecurrenceRule = { freq: RecurrenceFrequency.DAILY, interval: 1, count: 3 };

        it("Expands every occurrence of a recurring master, not just its first.", () => {
            const busy = computeBusyWindows([makeEvent({ recurrenceRule: dailyRule })], WINDOW_START, WINDOW_END);

            expect(isoStarts(busy)).toEqual([
                "2026-06-01T13:00:00.000Z",
                "2026-06-02T13:00:00.000Z",
                "2026-06-03T13:00:00.000Z",
            ]);
        });

        it("Honors the master's own EXDATE exceptions.", () => {
            const rule: RecurrenceRule = { ...dailyRule, exceptions: [new Date("2026-06-02T13:00:00.000Z")] };
            const busy = computeBusyWindows([makeEvent({ recurrenceRule: rule })], WINDOW_START, WINDOW_END);

            expect(isoStarts(busy)).toEqual(["2026-06-01T13:00:00.000Z", "2026-06-03T13:00:00.000Z"]);
        });

        it("Lets a sibling override row replace the master's occurrence rather than double-counting it.", () => {
            const master = makeEvent({ recurrenceRule: dailyRule });
            // The 2nd of June occurrence was individually moved to 16:00Z.
            const override = makeEvent({
                uid: "evt-2",
                icalUid: "ical-1",
                recurrenceId: new Date("2026-06-02T13:00:00.000Z"),
                startDate: new Date("2026-06-02T16:00:00.000Z"),
                endDate: new Date("2026-06-02T17:00:00.000Z"),
            });

            const busy = computeBusyWindows([master, override], WINDOW_START, WINDOW_END);

            expect(isoStarts(busy).sort()).toEqual([
                "2026-06-01T13:00:00.000Z",
                "2026-06-02T16:00:00.000Z",
                "2026-06-03T13:00:00.000Z",
            ]);
        });

        it("Does not let an unrelated series' override suppress this master's occurrence.", () => {
            const master = makeEvent({ recurrenceRule: dailyRule });
            const unrelated = makeEvent({
                uid: "evt-3",
                icalUid: "ical-other",
                recurrenceId: new Date("2026-06-02T13:00:00.000Z"),
                startDate: new Date("2026-06-02T20:00:00.000Z"),
                endDate: new Date("2026-06-02T21:00:00.000Z"),
            });

            const busy = computeBusyWindows([master, unrelated], WINDOW_START, WINDOW_END);

            expect(isoStarts(busy)).toContain("2026-06-02T13:00:00.000Z");
        });

        it("Expands a recurring series in its own timezone, keeping local time of day across a DST change.", () => {
            // 09:00 America/New_York weekly - 14:00Z before the 2026-03-08 spring-forward, 13:00Z after it.
            const event = makeEvent({
                startDate: new Date("2026-03-02T14:00:00.000Z"),
                endDate: new Date("2026-03-02T15:00:00.000Z"),
                timezone: "America/New_York",
                recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, count: 3 },
            });

            const busy = computeBusyWindows([event], new Date("2026-03-01T00:00:00.000Z"), new Date("2026-04-01T00:00:00.000Z"));

            expect(isoStarts(busy)).toEqual(["2026-03-02T14:00:00.000Z", "2026-03-09T13:00:00.000Z", "2026-03-16T13:00:00.000Z"]);
            expect(busy.map((window) => window.end.getTime() - window.start.getTime())).toEqual([3600000, 3600000, 3600000]);
        });

        it("Expands an allDay series in UTC even when it has a timezone.", () => {
            const event = makeEvent({
                startDate: new Date("2026-03-07T00:00:00.000Z"),
                endDate: new Date("2026-03-08T00:00:00.000Z"),
                allDay: true,
                timezone: "America/New_York",
                recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, count: 3 },
            });

            const busy = computeBusyWindows([event], new Date("2026-03-01T00:00:00.000Z"), new Date("2026-04-01T00:00:00.000Z"));

            expect(isoStarts(busy)).toEqual(["2026-03-07T00:00:00.000Z", "2026-03-08T00:00:00.000Z", "2026-03-09T00:00:00.000Z"]);
        });

        it("Treats an override row on its own as an ordinary single event, with no exclusions applied.", () => {
            const override = makeEvent({ recurrenceId: new Date("2026-06-01T13:00:00.000Z") });

            expect(computeBusyWindows([override], WINDOW_START, WINDOW_END)).toHaveLength(1);
        });
    });
});
