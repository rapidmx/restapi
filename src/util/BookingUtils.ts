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
    if (bookingType.durationMinutes !== undefined && bookingType.durationMinutes <= 0) {
        return "durationMinutes must be greater than zero.";
    }
    if (bookingType.slotIntervalMinutes !== undefined && bookingType.slotIntervalMinutes !== null && bookingType.slotIntervalMinutes <= 0) {
        return "slotIntervalMinutes must be greater than zero when supplied.";
    }

    const windowGroups: BookingAvailabilityWindow[][] = [
        ...(bookingType.availability ? [bookingType.availability] : []),
        ...(bookingType.dateOverrides ?? []).map((override) => override.windows ?? []),
    ];
    for (const windows of windowGroups) {
        for (const window of windows) {
            if (!Number.isInteger(window.dayOfWeek) || window.dayOfWeek < 0 || window.dayOfWeek > 6) {
                return "Each availability window's dayOfWeek must be an integer from 0 (Sunday) to 6 (Saturday).";
            }
            if (window.startMinute < 0 || window.endMinute > MINUTES_PER_DAY || window.startMinute >= window.endMinute) {
                return `Each availability window must satisfy 0 <= startMinute < endMinute <= ${MINUTES_PER_DAY}.`;
            }
        }
    }

    for (const override of bookingType.dateOverrides ?? []) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(override.date ?? "")) {
            return "Each dateOverride's date must be a YYYY-MM-DD string.";
        }
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
    const slots: OccurrenceWindow[] = [];

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
        const windows: BookingAvailabilityWindow[] =
            override ?? (bookingType.availability ?? []).filter((window) => window.dayOfWeek === calendarDay.getUTCDay());

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
                if (start.getTime() < earliestStartMs || start.getTime() >= latestStartMs) {
                    continue;
                }
                slots.push({ start, end: new Date(start.getTime() + bookingType.durationMinutes * MS_PER_MINUTE) });
            }
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
