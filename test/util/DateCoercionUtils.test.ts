///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { coerceCalendarEventDates, coerceDateFields, coerceDateValue } from "../../src/util/DateCoercionUtils.js";

describe("DateCoercionUtils Tests", () => {
    it("coerceDateValue() converts ISO strings and epoch millis, passes null/undefined/Dates through, and rejects anything else (400).", () => {
        const date = new Date("2099-01-01T00:00:00.000Z");
        expect(coerceDateValue("2099-01-01T00:00:00.000Z", "d")).toEqual(date);
        expect(coerceDateValue(date.getTime(), "d")).toEqual(date);
        expect(coerceDateValue(date, "d")).toBe(date);
        expect(coerceDateValue(null, "d")).toBeNull();
        expect(coerceDateValue(undefined, "d")).toBeUndefined();
        for (const bad of ["soon", "", "   ", true, {}, [], new Date("nope")]) {
            expect(() => coerceDateValue(bad, "startDate")).toThrow("'startDate' must be a valid ISO 8601 date/time.");
        }
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
