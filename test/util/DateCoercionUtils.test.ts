///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils } from "@rapidrest/service-core";
import { coerceCalendarEventDates, coerceDateFields, coerceDateValue, parseClientDate } from "../../src/util/DateCoercionUtils.js";

describe("DateCoercionUtils Tests", () => {
    it("coerceDateValue() converts ISO strings and epoch millis, passes null/undefined/Dates through, and rejects anything else (400).", () => {
        const date = new Date("2099-01-01T00:00:00.000Z");
        expect(coerceDateValue("2099-01-01T00:00:00.000Z", "d")).toEqual(date);
        expect(coerceDateValue(date.getTime(), "d")).toEqual(date);
        expect(coerceDateValue(date, "d")).toBe(date);
        expect(coerceDateValue(null, "d")).toBeNull();
        expect(coerceDateValue(undefined, "d")).toBeUndefined();
        for (const bad of ["soon", "", "   ", true, {}, [], new Date("nope")]) {
            expect(() => coerceDateValue(bad, "startDate")).toThrow("'startDate' must be a valid ISO 8601 date/time");
        }
    });

    it("follows service-core 2.1.0's date rules (round 6): a zoneless date-time is UTC; numeric strings, epoch seconds and impossible dates are 400.", () => {
        expect(coerceDateValue("2026-06-01T13:00", "d")).toEqual(new Date("2026-06-01T13:00:00.000Z"));
        expect(coerceDateValue("2026-06-01 13:00:05.1234567", "d")).toEqual(new Date("2026-06-01T13:00:05.123Z"));
        expect(coerceDateValue("2026-06-01", "d")).toEqual(new Date("2026-06-01T00:00:00.000Z"));
        expect(coerceDateValue("2026-06-01T13:00:00+02", "d")).toEqual(new Date("2026-06-01T11:00:00.000Z"));
        expect(coerceDateValue("2026-06-01T13:00:00-0130", "d")).toEqual(new Date("2026-06-01T14:30:00.000Z"));
        expect(coerceDateValue("2026-06-01t13:00:00z", "d")).toEqual(new Date("2026-06-01T13:00:00.000Z"));
        expect(coerceDateValue("0099-01-01", "d").getUTCFullYear()).toBe(99);
        expect(coerceDateValue(-1e12, "d")).toEqual(new Date(-1e12));
        const bad: unknown[] = [
            "12345",
            "1780000000000",
            1_780_000_000,
            5,
            NaN,
            Infinity,
            253402300800000,
            "2026-02-30",
            "2026-06-01T24:00",
            "2026-06-01T13:60",
            "2026-06-01T13:00:61",
            "June 1, 2026",
            "2026-06-01T13:00:00+2",
        ];
        for (const value of bad) {
            expect(() => coerceDateValue(value, "d"), String(value)).toThrow(/'d' must be a valid ISO 8601 date\/time/);
        }
    });

    it("agrees with service-core's own RepoUtils date parsing on a shared corpus.", () => {
        const frameworkParse = (RepoUtils as any).parseDateInput as (value: unknown) => Date | undefined;
        const corpus: unknown[] = [
            "2026-06-01T13:00",
            "2026-06-01T13:00:00Z",
            "2026-06-01 13:00:00.5+05:30",
            "2026-06-01",
            "2026-02-29",
            "2024-02-29",
            "12345",
            "1780000000000",
            1_780_000_000_000,
            1_780_000_000,
            -1e11,
            99_999_999_999,
            "",
            " ",
            "2026-06-01T13:00:00+0530",
            true,
            {},
        ];
        for (const value of corpus) {
            expect(parseClientDate(value)?.getTime(), JSON.stringify(value)).toBe(frameworkParse(value)?.getTime());
        }
    });

    it("the lenient form still reads legacy stored values new Date() understands.", () => {
        expect(coerceDateValue("June 1, 2026 13:00 UTC", "d", { lenient: true })).toEqual(new Date("2026-06-01T13:00:00.000Z"));
        expect(coerceDateValue(5, "d", { lenient: true })).toEqual(new Date(5));
        expect(coerceDateValue("   ", "d", { lenient: true })).toBe("   ");
        expect(coerceDateValue(true, "d", { lenient: true })).toBe(true);
        const invalid = new Date("nope");
        expect(coerceDateValue(invalid, "d", { lenient: true })).toBe(invalid);
    });

    it("the lenient form leaves an unparseable value as it is instead of throwing.", () => {
        expect(coerceDateValue("soon", "d", { lenient: true })).toBe("soon");
        const event: any = { startDate: "bad", recurrenceRule: { until: "bad", exceptions: "bad" } };
        expect(coerceCalendarEventDates(event, { lenient: true })).toBe(event);
        expect(event.startDate).toBe("bad");
        expect(event.recurrenceRule.exceptions).toBe("bad");
    });

    it("coerceDateFields() only touches the named fields that are present, and ignores non-objects.", () => {
        const obj: any = { a: "2099-01-01T00:00:00.000Z", b: "2099-01-01T00:00:00.000Z" };
        coerceDateFields(obj, ["a", "c"]);
        expect(obj.a).toBeInstanceOf(Date);
        expect(obj.b).toBe("2099-01-01T00:00:00.000Z");
        expect("c" in obj).toBe(false);
        expect(coerceDateFields(undefined, ["a"])).toBeUndefined();
        expect(coerceDateFields("x" as any, ["a"])).toBe("x");
    });

    it("coerceCalendarEventDates() coerces the top-level and recurrence dates, and rejects a non-array exceptions (400).", () => {
        const event: any = {
            startDate: "2099-01-01T00:00:00.000Z",
            recurrenceId: "2099-01-02T00:00:00.000Z",
            recurrenceRule: { until: "2099-02-01T00:00:00.000Z", exceptions: ["2099-01-08T00:00:00.000Z"] },
        };
        coerceCalendarEventDates(event);
        expect(event.startDate).toBeInstanceOf(Date);
        expect(event.recurrenceId).toBeInstanceOf(Date);
        expect(event.recurrenceRule.until).toBeInstanceOf(Date);
        expect(event.recurrenceRule.exceptions[0]).toBeInstanceOf(Date);

        expect(coerceCalendarEventDates({ recurrenceRule: null } as any)).toEqual({ recurrenceRule: null });
        expect(coerceCalendarEventDates({ recurrenceRule: { exceptions: null } } as any)).toEqual({ recurrenceRule: { exceptions: null } });
        expect(() => coerceCalendarEventDates({ recurrenceRule: { exceptions: "2099-01-01" } } as any)).toThrow(
            "'recurrenceRule.exceptions' must be an array of dates.",
        );
    });
});
