///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";

/**
 * Converting client-supplied date values into real `Date`s before they are saved, and tolerating rows that were
 * saved without that conversion.
 *
 * JSON has no date type, so a web client sends `startDate: "2026-06-01T13:00:00.000Z"`. The SQL backend's
 * column type converts that on save, but `MongoRepository.save()` stores the raw JSON value, leaving an ISO
 * string in the document. Code that then calls `.getTime()` on the field throws, and a MongoDB range query
 * (`startDate: lt(...)`, which compares against a real `Date`) never matches the row at all, since BSON strings
 * and dates never compare. Routes call the strict form on every write; the lenient form is for reads of rows that
 * may already hold strings.
 *
 * The strict form follows `@rapidrest/service-core` 2.1.0's own `Date` column rules (see `parseClientDate()`) rather
 * than `new Date(value)`, which reads a zoneless date-time as server-local time, `"12345"` as the year 12345 and epoch
 * seconds as January 1970.
 */
export interface DateCoercionOptions {
    /** `true` leaves an unparseable value as it is instead of throwing a `400` - for reading stored rows. */
    lenient?: boolean;
}

/** `YYYY-MM-DD`. */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** `YYYY-MM-DDTHH:mm[:ss[.fraction]][zone]` (`T` or a space), where zone is `Z`, `±HH`, `±HHmm` or `±HH:mm`. */
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
/** A smaller magnitude is far more likely to be epoch seconds (landing in January 1970) than a real date. */
const MIN_EPOCH_MS_MAGNITUDE = 1e11;
/** 0001-01-01T00:00:00.000Z and 9999-12-31T23:59:59.999Z. */
const MIN_EPOCH_MS = -62135596800000;
const MAX_EPOCH_MS = 253402300799999;

/** Strictly parses an ISO 8601 date or date-time (a missing zone means UTC), rejecting impossible calendar values that
 * `new Date()` would roll over (`2026-02-30`). */
function parseIsoDate(value: string): Date | undefined {
    const dateMatch: RegExpMatchArray | null = value.match(ISO_DATE);
    const match: RegExpMatchArray | null = dateMatch ?? value.match(ISO_DATE_TIME);
    if (!match) {
        return undefined;
    }
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const [hour, minute, second] = [Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0)];
    if (hour > 23 || minute > 59 || second > 59) {
        return undefined;
    }
    const calendar: Date = new Date(Date.UTC(year, month - 1, day));
    calendar.setUTCFullYear(year); // Date.UTC() maps years 0-99 to 1900-1999
    if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
        return undefined;
    }
    if (dateMatch) {
        return calendar;
    }
    let zone: string = (match[8] ?? "Z").toUpperCase();
    if (zone !== "Z") {
        const digits: string = zone.slice(1).replace(":", "");
        zone = `${zone[0]}${digits.slice(0, 2)}:${digits.length === 4 ? digits.slice(2) : "00"}`;
    }
    const pad = (n: number, width: number = 2): string => String(n).padStart(width, "0");
    const fraction: string = match[7] ? match[7].slice(0, 4).padEnd(4, "0") : "";
    const date: Date = new Date(`${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${fraction}${zone}`);
    return isNaN(date.getTime()) ? undefined : date;
}

/**
 * Parses a client-supplied date the way `@rapidrest/service-core` 2.1.0 coerces `Date` columns
 * (`RepoUtils.coerceDateProperties()`), so a field coerced here is never looser than one the framework coerces:
 * - an ISO 8601 date (`YYYY-MM-DD`, midnight UTC) or date-time with a zone of `Z`, `±HH`, `±HHmm` or `±HH:mm`; a
 * date-time without a zone is UTC, never the server's local time;
 * - a finite number of epoch milliseconds between years 1 and 9999 with a magnitude of at least `1e11` (smaller is
 * ambiguous with epoch seconds). Numeric strings are not dates.
 *
 * Anything else is `undefined`.
 */
export function parseClientDate(value: unknown): Date | undefined {
    if (typeof value === "number") {
        const ok: boolean = Number.isFinite(value) && value >= MIN_EPOCH_MS && value <= MAX_EPOCH_MS && Math.abs(value) >= MIN_EPOCH_MS_MAGNITUDE;
        return ok ? new Date(value) : undefined;
    }
    return typeof value === "string" ? parseIsoDate(value) : undefined;
}

/** Reads a date already stored in a row: the strict form first, then whatever `new Date()` makes of a legacy value
 * written before the strict rules. */
function parseStoredDate(value: unknown): Date | undefined {
    const strict: Date | undefined = parseClientDate(value);
    if (strict || (typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") {
        return strict;
    }
    const loose: Date = new Date(value);
    return isNaN(loose.getTime()) ? undefined : loose;
}

/** Returns `value` as a `Date` - `null`/`undefined` pass through unchanged (a patch that clears or doesn't touch the
 * field). A value `parseClientDate()` refuses (a numeric string, epoch seconds, an impossible calendar date, any other
 * type) or an invalid `Date` is a `400` naming `field`. With `lenient` (reading stored rows), a legacy value `new
 * Date()` understands is still read, and anything else is left as it is. */
export function coerceDateValue(value: unknown, field: string, options: DateCoercionOptions = {}): any {
    if (value === null || value === undefined) {
        return value;
    }
    const parsed: Date | undefined =
        value instanceof Date ? (isNaN(value.getTime()) ? undefined : value) : options.lenient ? parseStoredDate(value) : parseClientDate(value);
    if (!parsed) {
        if (options.lenient) {
            return value;
        }
        throw new ApiError(
            ApiErrors.INVALID_REQUEST,
            400,
            `'${field}' must be a valid ISO 8601 date/time (a missing zone means UTC) or a number of epoch milliseconds.`,
        );
    }
    return parsed;
}

/** Coerces each of `fields` present on `obj` in place (see `coerceDateValue()`), returning `obj`. */
export function coerceDateFields<T>(obj: T, fields: readonly string[], options: DateCoercionOptions = {}): T {
    if (!obj || typeof obj !== "object") {
        return obj;
    }
    for (const field of fields) {
        if (field in (obj as any)) {
            (obj as any)[field] = coerceDateValue((obj as any)[field], field, options);
        }
    }
    return obj;
}

/** Every top-level `Date` field of `CalendarEvent`. */
const CALENDAR_EVENT_DATE_FIELDS = ["startDate", "endDate", "recurrenceId", "cancelNoticeSentAt"] as const;

/**
 * Coerces every `Date` field of a `CalendarEvent` (or a partial update to one) in place: `startDate`, `endDate`,
 * `recurrenceId`, `cancelNoticeSentAt`, `recurrenceRule.until` and each of `recurrenceRule.exceptions`.
 */
export function coerceCalendarEventDates<T>(obj: T, options: DateCoercionOptions = {}): T {
    coerceDateFields(obj, CALENDAR_EVENT_DATE_FIELDS, options);
    const rule: any = (obj as any)?.recurrenceRule;
    if (rule && typeof rule === "object") {
        coerceDateFields(rule, ["until"], options);
        if (Array.isArray(rule.exceptions)) {
            rule.exceptions = rule.exceptions.map((exception: unknown) => coerceDateValue(exception, "recurrenceRule.exceptions", options));
        } else if (rule.exceptions !== undefined && rule.exceptions !== null && !options.lenient) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'recurrenceRule.exceptions' must be an array of dates.");
        }
    }
    return obj;
}

/** Every `Date` field of `Matter`. */
export const MATTER_DATE_FIELDS = ["dateRangeStart", "dateRangeEnd", "closedAt"] as const;
