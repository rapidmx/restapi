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
 */
export interface DateCoercionOptions {
    /** `true` leaves an unparseable value as it is instead of throwing a `400` - for reading stored rows. */
    lenient?: boolean;
}

/** Returns `value` as a `Date` - `null`/`undefined` pass through unchanged (a patch that clears or doesn't
 * touch the field). A string or number that doesn't parse, or any other type, is a `400` naming `field`. */
export function coerceDateValue(value: unknown, field: string, options: DateCoercionOptions = {}): any {
    if (value === null || value === undefined) {
        return value;
    }
    const parsed: Date | undefined =
        value instanceof Date ? value : typeof value === "string" || typeof value === "number" ? new Date(value) : undefined;
    if (!parsed || isNaN(parsed.getTime()) || (typeof value === "string" && value.trim() === "")) {
        if (options.lenient) {
            return value;
        }
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'${field}' must be a valid ISO 8601 date/time.`);
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
