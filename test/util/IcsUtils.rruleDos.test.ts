///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// An RRULE comes from a stored event or an inbound invitation, so its parts are attacker-chosen: the expansion must stay
// cheap whatever they hold.
import { expandOccurrencesDetailed, parseIcsEvent } from "../../src/util/IcsUtils.js";
import { RecurrenceFrequency } from "../../src/models/types.js";

const startDate = new Date("1900-01-01T09:00:00.000Z");
const endDate = new Date("1900-01-01T10:00:00.000Z");
const windowStart = new Date("2026-01-01T00:00:00.000Z");
const windowEnd = new Date("2026-03-01T00:00:00.000Z");

function ics(rrule: string): string {
    return ["BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:a@b", "DTSTART:20260101T090000Z", "DTEND:20260101T100000Z", `RRULE:${rrule}`, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
}

describe("RRULE denial of service", () => {
    it("Expands a rule with a huge BYMONTHDAY list in a bounded time.", () => {
        const started: number = performance.now();
        const result = expandOccurrencesDetailed(
            {
                startDate,
                endDate,
                recurrenceRule: {
                    freq: RecurrenceFrequency.DAILY,
                    interval: 1,
                    count: 1e9,
                    byMonthDay: new Array(20_000).fill(32),
                    byMonth: new Array(20_000).fill(2),
                    byDay: new Array(20_000).fill("MO"),
                    exceptions: [],
                },
            },
            windowStart,
            windowEnd,
        );
        expect(performance.now() - started).toBeLessThan(500);
        // A list over the cap (and a BYMONTHDAY of 32) makes the rule invalid: it expands to nothing, and says it is not trustworthy.
        expect(result.occurrences).toHaveLength(0);
        expect(result.truncated).toBe(true);
    });

    it("Reports truncated when a rule's total work is over the budget.", () => {
        // 366 distinct BYDAY ordinals x 12 months x 50,000 periods is far more than one expansion may spend.
        const byDay: string[] = [];
        for (let ordinal = 1; ordinal <= 53; ordinal++) {
            byDay.push(`${ordinal}MO`, `${ordinal}TU`, `${ordinal}WE`, `${ordinal}TH`, `${ordinal}FR`, `-${ordinal}SA`, `-${ordinal}SU`);
        }
        const started: number = performance.now();
        const result = expandOccurrencesDetailed(
            {
                startDate,
                endDate,
                recurrenceRule: { freq: RecurrenceFrequency.YEARLY, interval: 1, byDay, byMonth: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], byMonthDay: [-1, 31], exceptions: [] },
            },
            windowStart,
            new Date("9000-01-01T00:00:00.000Z"),
        );
        expect(performance.now() - started).toBeLessThan(2000);
        expect(result.truncated).toBe(true);
    });

    it("Stops walking periods once the work budget is spent, returning what it found so far as truncated.", () => {
        // 60 BYDAY entries make a daily period cost 63, so the 2,000,000 budget runs out after ~31,700 of the ~36,500 days of a century.
        const byDay: string[] = [];
        for (let ordinal = 1; ordinal <= 12; ordinal++) {
            byDay.push(`${ordinal}MO`, `${ordinal}TU`, `${ordinal}WE`, `-${ordinal}TH`, `-${ordinal}FR`);
        }
        const result = expandOccurrencesDetailed(
            {
                startDate,
                endDate,
                // February never has a 31st, so nothing matches and the walk goes on until the budget is gone.
                recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, byDay, byMonth: [2], byMonthDay: [31], exceptions: [] },
            },
            windowStart,
            new Date("2126-01-01T00:00:00.000Z"),
        );
        expect(result.truncated).toBe(true);
        expect(result.occurrences).toHaveLength(0);
    });

    it("Treats a NaN, zero or negative COUNT and an absurd INTERVAL as an invalid rule, not an endless or a shortened one.", () => {
        const expand = (recurrenceRule: any) => expandOccurrencesDetailed({ startDate, endDate, recurrenceRule }, windowStart, windowEnd);
        for (const bad of [{ count: NaN }, { count: 0 }, { count: -3 }, { count: 1.5 }, { count: "x" }, { interval: 1e300 }, { interval: 0 }, { interval: 2_000_000 }, { interval: "x" }]) {
            const result = expand({ freq: RecurrenceFrequency.DAILY, interval: 1, exceptions: [], ...bad });
            expect(result.occurrences, JSON.stringify(bad)).toHaveLength(0);
            expect(result.truncated, JSON.stringify(bad)).toBe(true);
        }
        // An interval the old clamp (1000) changed the meaning of is kept as written.
        expect(expand({ freq: RecurrenceFrequency.DAILY, interval: 1200, exceptions: [] }).occurrences.length).toBeLessThanOrEqual(1);
        expect(expand({ freq: RecurrenceFrequency.DAILY, interval: "2", count: "100000000", exceptions: [] }).occurrences.length).toBeGreaterThan(0);
    });

    it("Treats a BYDAY, BYMONTH or BYMONTHDAY with any entry out of range as an invalid rule, never as no constraint.", () => {
        const expand = (recurrenceRule: any) => expandOccurrencesDetailed({ startDate, endDate, recurrenceRule }, windowStart, windowEnd);
        for (const bad of [{ byMonthDay: [32] }, { byMonthDay: [5, 99] }, { byMonthDay: [0] }, { byMonth: [13] }, { byMonth: "2" }, { byDay: ["XX"] }, { byDay: ["MO", 5] }, { byDay: "MO" }]) {
            const result = expand({ freq: RecurrenceFrequency.DAILY, interval: 1, exceptions: [], ...bad });
            expect(result.occurrences, JSON.stringify(bad)).toHaveLength(0);
            expect(result.truncated, JSON.stringify(bad)).toBe(true);
        }
        expect(expand({ freq: RecurrenceFrequency.DAILY, interval: 1, byDay: ["MO", "+1FR", " tu "], byMonth: [1, "2"], byMonthDay: null, exceptions: [] }).truncated).toBe(false);
    });

    it("Drops the recurrence of an invitation with an unusable RRULE part, keeping the event itself.", () => {
        for (const rule of ["FREQ=MONTHLY;COUNT=abc", "FREQ=DAILY;COUNT=0", "FREQ=DAILY;INTERVAL=0", "FREQ=DAILY;INTERVAL=99999999999", "FREQ=MONTHLY;BYMONTHDAY=5,32", "FREQ=MONTHLY;BYMONTH=13", "FREQ=WEEKLY;BYDAY=XX"]) {
            const parsed = parseIcsEvent(ics(rule))!;
            expect(parsed, rule).toBeDefined();
            expect(parsed.recurrenceRule, rule).toBeUndefined();
        }
        const ok = parseIcsEvent(ics("FREQ=MONTHLY;INTERVAL=1200;COUNT=5;BYMONTHDAY=5,5,-1;BYMONTH=2,2;BYDAY=2TU,2TU,MO"))!.recurrenceRule!;
        expect(ok.interval).toBe(1200);
        expect(ok.count).toBe(5);
        expect(ok.byMonthDay).toEqual([5, -1]);
        expect(ok.byMonth).toEqual([2]);
        expect(ok.byDay).toEqual(["2TU", "MO"]);
    });

    it("Caps a COUNT when parsing, and drops a rule with too many BYDAY entries.", () => {
        expect(parseIcsEvent(ics("FREQ=DAILY;COUNT=999999999"))!.recurrenceRule!.count).toBe(100_000);
        const byDay: string = new Array(5_000).fill("MO").join(",");
        expect(parseIcsEvent(ics(`FREQ=DAILY;BYDAY=${byDay}`))!.recurrenceRule).toBeUndefined();
    });
});
