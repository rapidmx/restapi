///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { generateCandidateSlots, normalizeSlug, subtractBusy, validateAvailability } from "../../src/util/BookingUtils.js";
import { BookingType } from "../../src/models/types.js";
import type { OccurrenceWindow } from "../../src/util/IcsUtils.js";

/** A weekday 09:00-11:00 offering in New York, 60 minutes long, with everything else wide open - the baseline
 * every test varies one field of. Monday(1) through Friday(5). */
function makeBookingType(overrides?: Partial<BookingType>): BookingType {
    return {
        uid: "bt-1",
        version: 0,
        mailboxUid: "mbx-1",
        calendarFolderUid: "fld-1",
        slug: "intro-call",
        name: "Intro Call",
        hostDisplayName: "Ada Lovelace",
        durationMinutes: 60,
        timezone: "America/New_York",
        availability: [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startMinute: 540, endMinute: 660 })),
        dateOverrides: [],
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        minimumNoticeMinutes: 0,
        bookingWindowDays: 60,
        requiresApproval: false,
        enabled: true,
        ...overrides,
    } as BookingType;
}

const isoStarts = (slots: OccurrenceWindow[]): string[] => slots.map((slot) => slot.start.toISOString());

describe("generateCandidateSlots() Tests", () => {
    // 2026-06-01 is a Monday. New York is UTC-4 in June, so 09:00 local is 13:00Z.
    const NOW = new Date("2026-05-25T00:00:00.000Z");

    it("Emits back-to-back slots across a weekly window, converting local minutes to the correct UTC instants.", () => {
        const slots = generateCandidateSlots(
            makeBookingType(),
            new Date("2026-06-01T00:00:00.000Z"),
            new Date("2026-06-02T00:00:00.000Z"),
            NOW,
        );

        expect(isoStarts(slots)).toEqual(["2026-06-01T13:00:00.000Z", "2026-06-01T14:00:00.000Z"]);
        expect(slots[0].end.toISOString()).toBe("2026-06-01T14:00:00.000Z");
    });

    it("Skips days the weekly availability does not cover.", () => {
        // 2026-06-06 is a Saturday, 2026-06-07 a Sunday - neither is in the Mon-Fri availability.
        const slots = generateCandidateSlots(
            makeBookingType(),
            new Date("2026-06-06T00:00:00.000Z"),
            new Date("2026-06-08T00:00:00.000Z"),
            NOW,
        );

        expect(slots).toEqual([]);
    });

    it("Honors slotIntervalMinutes independently of durationMinutes.", () => {
        const slots = generateCandidateSlots(
            makeBookingType({ durationMinutes: 30, slotIntervalMinutes: 15 }),
            new Date("2026-06-01T00:00:00.000Z"),
            new Date("2026-06-02T00:00:00.000Z"),
            NOW,
        );

        // 09:00-11:00 stepping by 15 with a 30 minute duration: the last slot that still fits starts at 10:30.
        expect(isoStarts(slots)).toEqual([
            "2026-06-01T13:00:00.000Z",
            "2026-06-01T13:15:00.000Z",
            "2026-06-01T13:30:00.000Z",
            "2026-06-01T13:45:00.000Z",
            "2026-06-01T14:00:00.000Z",
            "2026-06-01T14:15:00.000Z",
            "2026-06-01T14:30:00.000Z",
        ]);
    });

    it("Emits nothing when the duration does not fit inside any window.", () => {
        const slots = generateCandidateSlots(
            makeBookingType({ durationMinutes: 180 }),
            new Date("2026-06-01T00:00:00.000Z"),
            new Date("2026-06-02T00:00:00.000Z"),
            NOW,
        );

        expect(slots).toEqual([]);
    });

    describe("dateOverrides", () => {
        it("A date override replaces the weekly availability for that date only.", () => {
            const bookingType = makeBookingType({
                dateOverrides: [{ date: "2026-06-02", windows: [{ dayOfWeek: 2, startMinute: 840, endMinute: 900 }] }],
            });

            const slots = generateCandidateSlots(
                bookingType,
                new Date("2026-06-01T00:00:00.000Z"),
                new Date("2026-06-03T00:00:00.000Z"),
                NOW,
            );

            // Monday keeps its usual two slots; Tuesday is replaced by the single 14:00-15:00 local window.
            expect(isoStarts(slots)).toEqual([
                "2026-06-01T13:00:00.000Z",
                "2026-06-01T14:00:00.000Z",
                "2026-06-02T18:00:00.000Z",
            ]);
        });

        it("An override missing its windows array entirely is treated as a blackout day, not as no override.", () => {
            const bookingType = makeBookingType({ dateOverrides: [{ date: "2026-06-01", windows: undefined as any }] });

            const slots = generateCandidateSlots(
                bookingType,
                new Date("2026-06-01T00:00:00.000Z"),
                new Date("2026-06-02T00:00:00.000Z"),
                NOW,
            );

            expect(slots).toEqual([]);
        });

        it("An override with an empty windows array is a blackout day.", () => {
            const bookingType = makeBookingType({ dateOverrides: [{ date: "2026-06-01", windows: [] }] });

            const slots = generateCandidateSlots(
                bookingType,
                new Date("2026-06-01T00:00:00.000Z"),
                new Date("2026-06-02T00:00:00.000Z"),
                NOW,
            );

            expect(slots).toEqual([]);
        });
    });

    describe("daylight saving", () => {
        it("Keeps a window at the same local wall-clock time on both sides of a spring-forward transition.", () => {
            // The US moves to daylight time on 2026-03-08. New York is UTC-5 before and UTC-4 after, so the very
            // same 09:00 local window is 14:00Z on the Friday before and 13:00Z on the Monday after.
            const slots = generateCandidateSlots(
                makeBookingType(),
                new Date("2026-03-06T00:00:00.000Z"),
                new Date("2026-03-10T00:00:00.000Z"),
                new Date("2026-03-01T00:00:00.000Z"),
            );

            expect(isoStarts(slots)).toEqual([
                "2026-03-06T14:00:00.000Z",
                "2026-03-06T15:00:00.000Z",
                "2026-03-09T13:00:00.000Z",
                "2026-03-09T14:00:00.000Z",
            ]);
        });
    });

    describe("notice and window bounds", () => {
        it("Drops slots that violate minimumNoticeMinutes.", () => {
            // 13:00Z is inside the notice window; 14:00Z is not.
            const slots = generateCandidateSlots(
                makeBookingType({ minimumNoticeMinutes: 120 }),
                new Date("2026-06-01T00:00:00.000Z"),
                new Date("2026-06-02T00:00:00.000Z"),
                new Date("2026-06-01T12:00:00.000Z"),
            );

            expect(isoStarts(slots)).toEqual(["2026-06-01T14:00:00.000Z"]);
        });

        it("Drops slots beyond bookingWindowDays even when the caller asks for a wider window.", () => {
            const slots = generateCandidateSlots(
                makeBookingType({ bookingWindowDays: 1 }),
                new Date("2026-06-01T00:00:00.000Z"),
                new Date("2026-06-30T00:00:00.000Z"),
                new Date("2026-06-01T00:00:00.000Z"),
            );

            expect(isoStarts(slots)).toEqual(["2026-06-01T13:00:00.000Z", "2026-06-01T14:00:00.000Z"]);
        });

        it("Returns nothing when the effective window is empty.", () => {
            const slots = generateCandidateSlots(
                makeBookingType(),
                new Date("2026-06-02T00:00:00.000Z"),
                new Date("2026-06-01T00:00:00.000Z"),
                NOW,
            );

            expect(slots).toEqual([]);
        });

        it("Returns nothing when the timezone is not one Intl recognizes.", () => {
            const slots = generateCandidateSlots(
                makeBookingType({ timezone: "Mars/Olympus_Mons" }),
                new Date("2026-06-01T00:00:00.000Z"),
                new Date("2026-06-02T00:00:00.000Z"),
                NOW,
            );

            expect(slots).toEqual([]);
        });

        it("Treats a missing availability array as no availability at all.", () => {
            const slots = generateCandidateSlots(
                makeBookingType({ availability: undefined, dateOverrides: undefined }),
                new Date("2026-06-01T00:00:00.000Z"),
                new Date("2026-06-02T00:00:00.000Z"),
                NOW,
            );

            expect(slots).toEqual([]);
        });
    });
});

describe("subtractBusy() Tests", () => {
    const slot = (startIso: string, endIso: string): OccurrenceWindow => ({ start: new Date(startIso), end: new Date(endIso) });

    it("Keeps a slot that overlaps nothing.", () => {
        const slots = [slot("2026-06-01T13:00:00.000Z", "2026-06-01T14:00:00.000Z")];
        const busy = [slot("2026-06-01T15:00:00.000Z", "2026-06-01T16:00:00.000Z")];

        expect(subtractBusy(slots, busy, 0, 0)).toEqual(slots);
    });

    it("Drops a slot that overlaps a busy window.", () => {
        const slots = [slot("2026-06-01T13:00:00.000Z", "2026-06-01T14:00:00.000Z")];
        const busy = [slot("2026-06-01T13:30:00.000Z", "2026-06-01T14:30:00.000Z")];

        expect(subtractBusy(slots, busy, 0, 0)).toEqual([]);
    });

    it("Keeps a slot that merely abuts a busy window - the ends are exclusive.", () => {
        const slots = [slot("2026-06-01T13:00:00.000Z", "2026-06-01T14:00:00.000Z")];
        const busy = [slot("2026-06-01T14:00:00.000Z", "2026-06-01T15:00:00.000Z")];

        expect(subtractBusy(slots, busy, 0, 0)).toEqual(slots);
    });

    it("Drops an abutting slot once a buffer after it is required.", () => {
        const slots = [slot("2026-06-01T13:00:00.000Z", "2026-06-01T14:00:00.000Z")];
        const busy = [slot("2026-06-01T14:00:00.000Z", "2026-06-01T15:00:00.000Z")];

        expect(subtractBusy(slots, busy, 0, 15)).toEqual([]);
    });

    it("Drops a slot whose required lead-in buffer collides with earlier busy time.", () => {
        const slots = [slot("2026-06-01T13:00:00.000Z", "2026-06-01T14:00:00.000Z")];
        const busy = [slot("2026-06-01T12:00:00.000Z", "2026-06-01T13:00:00.000Z")];

        expect(subtractBusy(slots, busy, 15, 0)).toEqual([]);
    });
});

describe("validateAvailability() Tests", () => {
    it("Accepts a well-formed configuration.", () => {
        expect(validateAvailability(makeBookingType())).toBeUndefined();
    });

    it("Accepts a partial patch that touches none of the validated fields.", () => {
        expect(validateAvailability({ name: "Renamed" })).toBeUndefined();
    });

    it("Rejects a timezone Intl does not recognize.", () => {
        expect(validateAvailability({ timezone: "Mars/Olympus_Mons" })).toMatch(/not a recognized IANA timezone/i);
    });

    it("Rejects a non-positive durationMinutes.", () => {
        expect(validateAvailability({ durationMinutes: 0 })).toMatch(/durationMinutes/);
    });

    it("Rejects a non-positive slotIntervalMinutes.", () => {
        expect(validateAvailability({ slotIntervalMinutes: 0 })).toMatch(/slotIntervalMinutes/);
    });

    it("Ignores a null slotIntervalMinutes, which is how the SQL backend returns an unset optional column.", () => {
        expect(validateAvailability({ slotIntervalMinutes: null as any })).toBeUndefined();
    });

    it("Rejects an out-of-range dayOfWeek.", () => {
        expect(validateAvailability({ availability: [{ dayOfWeek: 7, startMinute: 0, endMinute: 60 }] })).toMatch(/dayOfWeek/);
    });

    it("Rejects a non-integer dayOfWeek.", () => {
        expect(validateAvailability({ availability: [{ dayOfWeek: 1.5, startMinute: 0, endMinute: 60 }] })).toMatch(/dayOfWeek/);
    });

    it("Rejects a window that ends before it starts.", () => {
        expect(validateAvailability({ availability: [{ dayOfWeek: 1, startMinute: 600, endMinute: 540 }] })).toMatch(/startMinute/);
    });

    it("Rejects a window that runs past the end of the day.", () => {
        expect(validateAvailability({ availability: [{ dayOfWeek: 1, startMinute: 0, endMinute: 1441 }] })).toMatch(/endMinute/);
    });

    it("Validates the windows inside a date override too.", () => {
        const problem = validateAvailability({
            dateOverrides: [{ date: "2026-06-01", windows: [{ dayOfWeek: 1, startMinute: -1, endMinute: 60 }] }],
        });

        expect(problem).toMatch(/startMinute/);
    });

    it("Treats a date override with no windows array at all as an empty one.", () => {
        expect(validateAvailability({ dateOverrides: [{ date: "2026-06-01", windows: undefined as any }] })).toBeUndefined();
    });

    it("Rejects a date override whose date is not YYYY-MM-DD.", () => {
        expect(validateAvailability({ dateOverrides: [{ date: "June 1st", windows: [] }] })).toMatch(/YYYY-MM-DD/);
    });

    it("Rejects a date override with no date at all.", () => {
        expect(validateAvailability({ dateOverrides: [{ date: undefined as any, windows: [] }] })).toMatch(/YYYY-MM-DD/);
    });
});

describe("normalizeSlug() Tests", () => {
    it("Lowercases and trims.", () => {
        expect(normalizeSlug("  Intro-Call  ")).toBe("intro-call");
    });

    it("Collapses any run of unsafe characters into a single hyphen.", () => {
        expect(normalizeSlug("30 Minute // Intro Call!")).toBe("30-minute-intro-call");
    });

    it("Strips leading and trailing hyphens.", () => {
        expect(normalizeSlug("---intro---")).toBe("intro");
    });

    it("Returns an empty string when nothing usable survives.", () => {
        expect(normalizeSlug("!!!")).toBe("");
    });
});
