///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { BookingAvailabilityWindow, BookingType } from "../models/types.js";
import { convertLocalToUtc, type OccurrenceWindow } from "./IcsUtils.js";

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_DAY = 1440;

/** Safety net on how many local calendar days a single `generateCandidateSlots()` call will walk, independent
 * of `bookingWindowDays`. Not a real limit on how far ahead a booking type can be booked - just a bound on the
 * worst-case cost of one request, matching `IcsUtils`'s own `MAX_SCAN_DAYS`/`MAX_OCCURRENCES` safety nets. */
const MAX_SCAN_DAYS = 400;

/** The shortest `durationMinutes`/`slotIntervalMinutes` a booking type may have - with the day length, bounds how many
 * slots one availability window can produce (288 a day). */
export const MIN_SLOT_MINUTES = 5;

/** The furthest ahead (`bookingWindowDays`) a booking type may offer slots; also bounds `minimumNoticeMinutes`. */
export const MAX_BOOKING_WINDOW_DAYS = 365;

/** The most weekly `availability` windows a booking type (and the most `windows` one date override) may have. */
export const MAX_AVAILABILITY_WINDOWS = 50;

/** The most `dateOverrides` entries a booking type may have - a year of daily overrides plus a leap day. */
export const MAX_DATE_OVERRIDES = 366;

/** Safety net on how many candidate slots one `generateCandidateSlots()` call collects, whatever is stored (rows written
 * before `validateAvailability()` had its limits, or straight to the database). Generation stops after the local day
 * this is reached on, so what is returned is still every slot up to that day, in order. */
const MAX_CANDIDATE_SLOTS = 5000;

/** The pieces of a local calendar date, as rendered in some IANA timezone. */
interface LocalDateParts {
    year: number;
    month: number;
    day: number;
}

/**
 * Renders `instant` as a calendar date in IANA timezone `tzid`. Returns `undefined` if `Intl` doesn't recognize
 * `tzid`, matching `convertLocalToUtc()`'s contract for the same situation.
 */
function localDatePartsOf(instant: Date, tzid: string): LocalDateParts | undefined {
    try {
        const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: tzid,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        });
        const parts: Record<string, string> = {};
        for (const part of formatter.formatToParts(instant)) {
            parts[part.type] = part.value;
        }
        return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
    } catch {
        return undefined;
    }
}

/** Formats a local calendar date as the `YYYY-MM-DD` string `BookingDateOverride.date` uses. */
function formatLocalDate(parts: LocalDateParts): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/**
 * Validates a `BookingType`'s availability configuration, returning a human-readable problem description or
 * `undefined` when everything is well-formed. Returns a message rather than throwing so it stays a pure
 * function (the route turns it into a `400`), the same way `FocusedInboxUtils`/`TransportRuleUtils` keep their
 * decision logic free of both I/O and framework types.
 */
export function validateAvailability(bookingType: Partial<BookingType>): string | undefined {
    if (bookingType.timezone !== undefined && convertLocalToUtc(2026, 1, 1, 12, 0, 0, bookingType.timezone) === undefined) {
        return `'${bookingType.timezone}' is not a recognized IANA timezone identifier.`;
    }
    const isIntegerIn = (value: unknown, min: number, max: number): boolean =>
        typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
    if (bookingType.durationMinutes !== undefined && !isIntegerIn(bookingType.durationMinutes, MIN_SLOT_MINUTES, MINUTES_PER_DAY)) {
        return `durationMinutes must be a whole number of minutes from ${MIN_SLOT_MINUTES} to ${MINUTES_PER_DAY}.`;
    }
    if (
        bookingType.slotIntervalMinutes !== undefined &&
        bookingType.slotIntervalMinutes !== null &&
        !isIntegerIn(bookingType.slotIntervalMinutes, MIN_SLOT_MINUTES, MINUTES_PER_DAY)
    ) {
        return `slotIntervalMinutes must be a whole number of minutes from ${MIN_SLOT_MINUTES} to ${MINUTES_PER_DAY} when supplied.`;
    }
    for (const field of ["bufferBeforeMinutes", "bufferAfterMinutes"] as const) {
        if (bookingType[field] !== undefined && !isIntegerIn(bookingType[field], 0, MINUTES_PER_DAY)) {
            return `${field} must be a whole number of minutes from 0 to ${MINUTES_PER_DAY}.`;
        }
    }
    if (bookingType.minimumNoticeMinutes !== undefined && !isIntegerIn(bookingType.minimumNoticeMinutes, 0, MAX_BOOKING_WINDOW_DAYS * MINUTES_PER_DAY)) {
        return `minimumNoticeMinutes must be a whole number of minutes from 0 to ${MAX_BOOKING_WINDOW_DAYS * MINUTES_PER_DAY}.`;
    }
    if (bookingType.bookingWindowDays !== undefined && !isIntegerIn(bookingType.bookingWindowDays, 1, MAX_BOOKING_WINDOW_DAYS)) {
        return `bookingWindowDays must be a whole number of days from 1 to ${MAX_BOOKING_WINDOW_DAYS}.`;
    }
    if (bookingType.maxPerDay !== undefined && bookingType.maxPerDay !== null && !isIntegerIn(bookingType.maxPerDay, 1, Number.MAX_SAFE_INTEGER)) {
        return "maxPerDay must be a positive whole number when supplied.";
    }

    if (bookingType.availability !== undefined && (!Array.isArray(bookingType.availability) || bookingType.availability.length > MAX_AVAILABILITY_WINDOWS)) {
        return `availability must be a list of at most ${MAX_AVAILABILITY_WINDOWS} windows.`;
    }
    if (bookingType.dateOverrides !== undefined && (!Array.isArray(bookingType.dateOverrides) || bookingType.dateOverrides.length > MAX_DATE_OVERRIDES)) {
        return `dateOverrides must be a list of at most ${MAX_DATE_OVERRIDES} dates.`;
    }
    for (const override of bookingType.dateOverrides ?? []) {
        if (override?.windows !== undefined && (!Array.isArray(override.windows) || override.windows.length > MAX_AVAILABILITY_WINDOWS)) {
            return `Each dateOverride's windows must be a list of at most ${MAX_AVAILABILITY_WINDOWS} windows.`;
        }
    }

    const windowGroups: BookingAvailabilityWindow[][] = [
        ...(bookingType.availability ? [bookingType.availability] : []),
        ...(bookingType.dateOverrides ?? []).map((override) => override?.windows ?? []),
    ];
    for (const windows of windowGroups) {
        for (const window of windows) {
            if (!Number.isInteger(window?.dayOfWeek) || window.dayOfWeek < 0 || window.dayOfWeek > 6) {
                return "Each availability window's dayOfWeek must be an integer from 0 (Sunday) to 6 (Saturday).";
            }
            if (
                !Number.isInteger(window.startMinute) ||
                !Number.isInteger(window.endMinute) ||
                window.startMinute < 0 ||
                window.endMinute > MINUTES_PER_DAY ||
                window.startMinute >= window.endMinute
            ) {
                return `Each availability window must satisfy 0 <= startMinute < endMinute <= ${MINUTES_PER_DAY}, in whole minutes.`;
            }
        }
    }

    const seenDates: Set<string> = new Set();
    for (const override of bookingType.dateOverrides ?? []) {
        if (typeof override?.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(override.date)) {
            return "Each dateOverride's date must be a YYYY-MM-DD string.";
        }
        if (seenDates.has(override.date)) {
            return `dateOverrides lists ${override.date} more than once.`;
        }
        seenDates.add(override.date);
    }

    return undefined;
}

/**
 * Produces every slot start/end `bookingType`'s own configuration allows within `[from, to]`, before any
 * consideration of what is already on the host's calendar (that is `subtractBusy()`'s job). A pure function of
 * its arguments, `now` included, so the whole thing is deterministically testable.
 *
 * For each local calendar date in the window, the applicable windows are a `dateOverrides` entry for that exact
 * date if one exists - winning outright, including when its `windows` array is empty, which is how a blackout
 * day is expressed - and otherwise every weekly `availability` window whose `dayOfWeek` matches. Each window is
 * then stepped from `startMinute` by `slotIntervalMinutes ?? durationMinutes`, emitting a slot whenever the
 * whole `durationMinutes` still fits before `endMinute`.
 *
 * Window minutes are local wall-clock offsets converted per-date through `convertLocalToUtc()`, so a 09:00
 * window stays 09:00 local on both sides of a daylight-saving transition instead of drifting an hour. A slot's
 * *end* is its start plus `durationMinutes` of real elapsed time, so a 30-minute appointment is always 30 real
 * minutes even when the transition itself falls inside it.
 *
 * @param bookingType The offering whose availability is being expanded.
 * @param from The inclusive start of the caller's requested window.
 * @param to The exclusive end of the caller's requested window.
 * @param now The current instant, against which `minimumNoticeMinutes`/`bookingWindowDays` are applied.
 */
export function generateCandidateSlots(bookingType: BookingType, from: Date, to: Date, now: Date): OccurrenceWindow[] {
    const earliestStartMs: number = Math.max(from.getTime(), now.getTime() + bookingType.minimumNoticeMinutes * MS_PER_MINUTE);
    const latestStartMs: number = Math.min(to.getTime(), now.getTime() + bookingType.bookingWindowDays * MINUTES_PER_DAY * MS_PER_MINUTE);
    if (earliestStartMs >= latestStartMs) {
        return [];
    }

    // Walk from the local date containing `earliestStartMs`, not from `from` - a window that begins mid-day
    // still has the rest of that same local day available.
    const startParts: LocalDateParts | undefined = localDatePartsOf(new Date(earliestStartMs), bookingType.timezone);
    const endParts: LocalDateParts | undefined = localDatePartsOf(new Date(latestStartMs), bookingType.timezone);
    if (!startParts || !endParts) {
        return [];
    }

    const overridesByDate = new Map((bookingType.dateOverrides ?? []).map((override) => [override.date, override.windows ?? []]));
    const intervalMinutes: number = bookingType.slotIntervalMinutes ?? bookingType.durationMinutes;
    // A stored zero/fractional/non-numeric step would loop (near-)forever below - such a row offers nothing.
    if (!(Number(intervalMinutes) >= 1) || !(Number(bookingType.durationMinutes) >= 1)) {
        return [];
    }
    const slots: OccurrenceWindow[] = [];
    const seenStarts: Set<number> = new Set();

    // Calendar-date arithmetic done in UTC purely as a calendar (never as an instant) - `Date.UTC` gives exact
    // whole-day stepping and a correct `getUTCDay()` weekday for a Y/M/D triple with no timezone involved.
    const lastDayMs: number = Date.UTC(endParts.year, endParts.month - 1, endParts.day);
    for (let dayOffset = 0; dayOffset < MAX_SCAN_DAYS; dayOffset++) {
        const calendarDay = new Date(Date.UTC(startParts.year, startParts.month - 1, startParts.day + dayOffset));
        if (calendarDay.getTime() > lastDayMs) {
            break;
        }

        const parts: LocalDateParts = {
            year: calendarDay.getUTCFullYear(),
            month: calendarDay.getUTCMonth() + 1,
            day: calendarDay.getUTCDate(),
        };
        const override: BookingAvailabilityWindow[] | undefined = overridesByDate.get(formatLocalDate(parts));
        const windows: BookingAvailabilityWindow[] = (
            override ?? (bookingType.availability ?? []).filter((window) => window.dayOfWeek === calendarDay.getUTCDay())
        ).slice(0, MAX_AVAILABILITY_WINDOWS);

        for (const window of windows) {
            for (let minute = window.startMinute; minute + bookingType.durationMinutes <= window.endMinute; minute += intervalMinutes) {
                const start: Date | undefined = convertLocalToUtc(
                    parts.year,
                    parts.month,
                    parts.day,
                    Math.floor(minute / 60),
                    minute % 60,
                    0,
                    bookingType.timezone,
                );
                /* v8 ignore next 3 -- unreachable: `bookingType.timezone` was already proven recognizable by
                   `localDatePartsOf()` above, which fails for exactly the same set of unrecognized zone names
                   this guard covers. Kept because `convertLocalToUtc()`'s signature is `Date | undefined`. */
                if (!start) {
                    continue;
                }
                // Overlapping or duplicated windows produce the same start more than once - offer it once.
                if (start.getTime() < earliestStartMs || start.getTime() >= latestStartMs || seenStarts.has(start.getTime())) {
                    continue;
                }
                seenStarts.add(start.getTime());
                slots.push({ start, end: new Date(start.getTime() + bookingType.durationMinutes * MS_PER_MINUTE) });
            }
        }
        if (slots.length >= MAX_CANDIDATE_SLOTS) {
            break;
        }
    }

    slots.sort((a, b) => a.start.getTime() - b.start.getTime());
    return slots;
}

/**
 * Filters `slots` down to those whose padded window - the slot itself plus `bufferBeforeMinutes` ahead of it
 * and `bufferAfterMinutes` behind it, all of which the host needs kept clear - overlaps none of `busy`.
 *
 * @param slots Candidate slots, e.g. from `generateCandidateSlots()`.
 * @param busy Windows the host is already occupied for, e.g. from `computeBusyWindows()`.
 * @param bufferBeforeMinutes Padding required before each slot.
 * @param bufferAfterMinutes Padding required after each slot.
 */
export function subtractBusy(
    slots: OccurrenceWindow[],
    busy: OccurrenceWindow[],
    bufferBeforeMinutes: number,
    bufferAfterMinutes: number,
): OccurrenceWindow[] {
    return slots.filter((slot) => {
        const paddedStartMs: number = slot.start.getTime() - bufferBeforeMinutes * MS_PER_MINUTE;
        const paddedEndMs: number = slot.end.getTime() + bufferAfterMinutes * MS_PER_MINUTE;
        return !busy.some((window) => paddedStartMs < window.end.getTime() && paddedEndMs > window.start.getTime());
    });
}

/**
 * Normalizes a caller-supplied public slug: lowercased, trimmed, and with any run of characters outside
 * `[a-z0-9]` collapsed to a single hyphen (leading/trailing hyphens removed). Returns an empty string when
 * nothing usable survives, which the route treats as a `400`.
 */
export function normalizeSlug(slug: string): string {
    return slug
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}
