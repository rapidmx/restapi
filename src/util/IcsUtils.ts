///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    Attendee,
    AttendeeResponseStatus,
    AttendeeRole,
    CalendarEvent,
    RecurrenceFrequency,
    RecurrenceRule,
} from "../models/types.js";

/**
 * Hand-rolled RFC 5545/5546 iCalendar generation and parsing for this library's meeting-invite feature
 * (`MeetingSchedulingJob`, `ScanQueueJob.maybeProcessItipMessage()`, `BaseCalendarEventRoute.respond()`).
 *
 * Generation (`buildEventIcs()`) is low-risk since this library fully controls what it emits, matching this
 * codebase's existing convention of hand-rolling a wire format it owns on both ends rather than pulling in a
 * library for it (e.g. `activesync` hand-builds WBXML the same way). Parsing (`parseIcsEvent()`) is
 * deliberately *not* a general RFC 5545 parser either - real-world invites arrive from arbitrary senders
 * (Outlook, Gmail, etc.), but this only ever needs a small, fixed set of properties
 * (`METHOD`/`UID`/`SEQUENCE`/`SUMMARY`/`LOCATION`/`STATUS`/`DTSTART`/`DTEND`/`ORGANIZER`/`ATTENDEE`+
 * `PARTSTAT`/`RRULE`/`EXDATE`/`RECURRENCE-ID`), so it unfolds lines and extracts exactly those, ignoring
 * everything else (`VALARM` blocks, `X-` extensions, etc.) rather than attempting to model the full standard.
 *
 * Known, accepted limitations (a deliberate scope boundary, not an oversight):
 * - No RFC 5545 line-folding on generated output - folding is a SHOULD for writers, not a MUST for readers;
 * this library's own generated lines are short enough in practice that skipping it is safe.
 * - A `DTSTART`/`DTEND`/`RECURRENCE-ID`/`EXDATE`/`UNTIL` value with a `TZID` parameter is converted to UTC
 * via `Intl`'s built-in timezone database (no new dependency) when `TZID` is a real IANA name (e.g.
 * `America/Los_Angeles`); a non-IANA `TZID` (e.g. a legacy Windows zone name like `"Pacific Standard
 * Time"`, as classic Outlook sometimes emits) isn't recognized by `Intl` and falls back to treating the
 * value as UTC - a known, accepted inaccuracy for that one sender category.
 * - "This and future occurrences" recurring-event updates aren't a distinct mode - only "this occurrence"
 * (an override VEVENT, `RECURRENCE-ID` set) and "the whole series" (the master VEVENT, `RRULE` set) are
 * modeled, matching what `CalendarEvent.recurrenceRule`/`recurrenceId` already represent. Real Exchange
 * doesn't implement "this and future" as a wire-protocol mode either - Outlook's UI fakes it client-side.
 *
 * @author Jean-Philippe Steinmetz
 */

/** The fields this library extracts from an inbound iTIP `text/calendar` message. */
export interface ParsedIcsEvent {
    method: string;
    uid: string;
    sequence: number;
    summary?: string;
    location?: string;
    startDate?: Date;
    endDate?: Date;
    status?: string;
    organizer?: { address: string; displayName?: string };
    attendees: { address: string; displayName?: string; partstat?: AttendeeResponseStatus }[];
    /** Present only on a single-occurrence override VEVENT - identifies which occurrence of the master
     * series (same `uid`) this VEVENT replaces. */
    recurrenceId?: Date;
    /** Present only on a master/whole-series VEVENT - this event's recurrence definition. `exceptions` is
     * populated from every `EXDATE` line, regardless of where it appears relative to `RRULE`. */
    recurrenceRule?: RecurrenceRule;
}

const PARTSTAT_TO_RESPONSE_STATUS: Record<string, AttendeeResponseStatus> = {
    ACCEPTED: AttendeeResponseStatus.ACCEPTED,
    DECLINED: AttendeeResponseStatus.DECLINED,
    TENTATIVE: AttendeeResponseStatus.TENTATIVE,
    "NEEDS-ACTION": AttendeeResponseStatus.NEEDS_ACTION,
};

const RESPONSE_STATUS_TO_PARTSTAT: Record<AttendeeResponseStatus, string> = {
    [AttendeeResponseStatus.ACCEPTED]: "ACCEPTED",
    [AttendeeResponseStatus.DECLINED]: "DECLINED",
    [AttendeeResponseStatus.TENTATIVE]: "TENTATIVE",
    [AttendeeResponseStatus.NEEDS_ACTION]: "NEEDS-ACTION",
};

function escapeText(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function unescapeText(value: string): string {
    return value.replace(/\\\\|\\,|\\;|\\[nN]/g, (m) => {
        if (m === "\\\\") {
            return "\\";
        }
        if (m === "\\,") {
            return ",";
        }
        if (m === "\\;") {
            return ";";
        }
        return "\n";
    });
}

function formatDateUtc(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
        `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T` +
        `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
    );
}

/** Converts a local wall-clock date/time in IANA timezone `tzid` to its equivalent UTC instant using only
 * Node's built-in `Intl`/ICU timezone database. Returns `undefined` if `Intl` doesn't recognize `tzid`. */
function convertLocalToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tzid: string): Date | undefined {
    try {
        const reference = Date.UTC(y, mo - 1, d, h, mi, s);
        const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: tzid,
            hourCycle: "h23",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
        const parts: Record<string, string> = {};
        for (const part of formatter.formatToParts(new Date(reference))) {
            parts[part.type] = part.value;
        }
        // `hourCycle: "h23"` can still render midnight as "24" depending on ICU data - normalize it.
        const hour = parts.hour === "24" ? "0" : parts.hour;
        const wallClockAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(hour), Number(parts.minute), Number(parts.second));
        const offsetMs = wallClockAsUtc - reference;
        return new Date(reference - offsetMs);
    } catch {
        return undefined;
    }
}

/** Parses a single RFC 5545 `DATE-TIME`/`DATE` value (`20260615T120000Z`, `20260615T120000`, or the
 * date-only `20260615`), honoring a `TZID` parameter if given - see this module's own doc comment for the
 * documented fallback behavior when `tzid` isn't a recognized IANA name. */
function parseIcsDateTime(value: string, tzid?: string): Date | undefined {
    const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
    if (!match) {
        return undefined;
    }
    const [, y, mo, d, h = "00", mi = "00", s = "00", z] = match;
    const year = Number(y);
    const month = Number(mo);
    const day = Number(d);
    const hour = Number(h);
    const minute = Number(mi);
    const second = Number(s);
    if (!z && tzid) {
        const converted = convertLocalToUtc(year, month, day, hour, minute, second, tzid);
        if (converted) {
            return converted;
        }
    }
    return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

function parseParams(paramString: string): Record<string, string> {
    const params: Record<string, string> = {};
    for (const segment of paramString.replace(/^;/, "").split(";")) {
        const eq = segment.indexOf("=");
        if (eq > 0) {
            params[segment.slice(0, eq).toUpperCase()] = segment.slice(eq + 1);
        }
    }
    return params;
}

function stripMailto(value: string): string {
    return value.replace(/^mailto:/i, "").trim();
}

function buildRrule(rule: RecurrenceRule): string {
    const parts: string[] = [`FREQ=${rule.freq.toUpperCase()}`, `INTERVAL=${rule.interval}`];
    if (rule.byDay && rule.byDay.length > 0) {
        parts.push(`BYDAY=${rule.byDay.join(",")}`);
    }
    if (rule.byMonthDay && rule.byMonthDay.length > 0) {
        parts.push(`BYMONTHDAY=${rule.byMonthDay.join(",")}`);
    }
    if (rule.byMonth && rule.byMonth.length > 0) {
        parts.push(`BYMONTH=${rule.byMonth.join(",")}`);
    }
    if (rule.count !== undefined) {
        parts.push(`COUNT=${rule.count}`);
    }
    if (rule.until !== undefined) {
        parts.push(`UNTIL=${formatDateUtc(rule.until)}`);
    }
    return parts.join(";");
}

function parseRrule(value: string): RecurrenceRule {
    const params = parseParams(`;${value}`);
    return {
        freq: (params.FREQ ?? "").toLowerCase() as RecurrenceFrequency,
        interval: params.INTERVAL ? parseInt(params.INTERVAL, 10) : 1,
        byDay: params.BYDAY ? params.BYDAY.split(",") : undefined,
        byMonthDay: params.BYMONTHDAY ? params.BYMONTHDAY.split(",").map(Number) : undefined,
        byMonth: params.BYMONTH ? params.BYMONTH.split(",").map(Number) : undefined,
        count: params.COUNT ? parseInt(params.COUNT, 10) : undefined,
        until: params.UNTIL ? parseIcsDateTime(params.UNTIL) : undefined,
        exceptions: [],
    };
}

/**
 * Builds a minimal iTIP `VCALENDAR`/`VEVENT` payload for `event`. For `REQUEST`/`CANCEL`, emits one
 * `ATTENDEE` line per `event.attendees` entry; for `REPLY`, emits exactly one `ATTENDEE` line
 * (`options.onlyAttendee`) - a real iTIP reply only ever reports the replying attendee's own status, never
 * the whole list. See this module's own doc comment for the recurring-meeting (`RECURRENCE-ID` vs.
 * `RRULE`/`EXDATE`) and line-folding conventions.
 */
export function buildEventIcs(event: CalendarEvent, method: "REQUEST" | "CANCEL" | "REPLY", options?: { onlyAttendee?: Attendee }): string {
    const lines: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//RapidMX//Mail Server//EN", `METHOD:${method}`, "BEGIN:VEVENT"];
    lines.push(`UID:${event.icalUid}`);
    lines.push(`DTSTAMP:${formatDateUtc(new Date())}`);
    lines.push(`DTSTART:${formatDateUtc(event.startDate)}`);
    lines.push(`DTEND:${formatDateUtc(event.endDate)}`);
    if (event.title) {
        lines.push(`SUMMARY:${escapeText(event.title)}`);
    }
    if (event.location) {
        lines.push(`LOCATION:${escapeText(event.location)}`);
    }
    lines.push(`SEQUENCE:${event.sequence}`);
    lines.push(`STATUS:${method === "CANCEL" ? "CANCELLED" : event.status.toUpperCase()}`);
    const organizerCn = event.organizer.displayName ? `;CN=${escapeText(event.organizer.displayName)}` : "";
    lines.push(`ORGANIZER${organizerCn}:mailto:${event.organizer.address}`);

    if (event.recurrenceId) {
        lines.push(`RECURRENCE-ID:${formatDateUtc(event.recurrenceId)}`);
    } else if (event.recurrenceRule) {
        lines.push(`RRULE:${buildRrule(event.recurrenceRule)}`);
        for (const exception of event.recurrenceRule.exceptions ?? []) {
            lines.push(`EXDATE:${formatDateUtc(exception)}`);
        }
    }

    const attendeesToEmit = method === "REPLY" ? (options?.onlyAttendee ? [options.onlyAttendee] : []) : event.attendees;
    for (const attendee of attendeesToEmit) {
        const cn = attendee.displayName ? `;CN=${escapeText(attendee.displayName)}` : "";
        const partstat = `;PARTSTAT=${RESPONSE_STATUS_TO_PARTSTAT[attendee.responseStatus]}`;
        const role =
            attendee.role === AttendeeRole.RESOURCE ? "RESOURCE" : attendee.role === AttendeeRole.OPTIONAL ? "OPT-PARTICIPANT" : "REQ-PARTICIPANT";
        lines.push(`ATTENDEE;ROLE=${role}${partstat}${cn}:mailto:${attendee.address}`);
    }

    lines.push("END:VEVENT", "END:VCALENDAR");
    return lines.join("\r\n");
}

/**
 * Parses the fields this feature needs out of a raw iTIP `text/calendar` payload. Returns `undefined` if
 * `raw` has no recognizable `UID`+`METHOD` (not a real/complete iTIP message).
 */
export function parseIcsEvent(raw: string): ParsedIcsEvent | undefined {
    const unfolded = raw.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").replace(/\r[ \t]/g, "");
    const lines = unfolded.split(/\r\n|\r|\n/);

    let method: string | undefined;
    let uid: string | undefined;
    let sequence = 0;
    let summary: string | undefined;
    let location: string | undefined;
    let status: string | undefined;
    let startDate: Date | undefined;
    let endDate: Date | undefined;
    let recurrenceId: Date | undefined;
    let recurrenceRule: RecurrenceRule | undefined;
    const exceptions: Date[] = [];
    let organizer: { address: string; displayName?: string } | undefined;
    const attendees: { address: string; displayName?: string; partstat?: AttendeeResponseStatus }[] = [];

    for (const line of lines) {
        const match = /^([A-Za-z0-9-]+)((?:;[^:]*)?):(.*)$/.exec(line);
        if (!match) {
            continue;
        }
        const property = match[1].toUpperCase();
        const params = parseParams(match[2]);
        const value = match[3];

        switch (property) {
            case "METHOD":
                method = value.trim().toUpperCase();
                break;
            case "UID":
                uid = value.trim();
                break;
            case "SEQUENCE":
                sequence = parseInt(value.trim(), 10) || 0;
                break;
            case "SUMMARY":
                summary = unescapeText(value);
                break;
            case "LOCATION":
                location = unescapeText(value);
                break;
            case "STATUS":
                status = value.trim().toUpperCase();
                break;
            case "DTSTART":
                startDate = parseIcsDateTime(value, params.TZID);
                break;
            case "DTEND":
                endDate = parseIcsDateTime(value, params.TZID);
                break;
            case "RECURRENCE-ID":
                recurrenceId = parseIcsDateTime(value, params.TZID);
                break;
            case "EXDATE":
                for (const part of value.split(",")) {
                    const parsedException = parseIcsDateTime(part, params.TZID);
                    if (parsedException) {
                        exceptions.push(parsedException);
                    }
                }
                break;
            case "RRULE":
                recurrenceRule = parseRrule(value);
                break;
            case "ORGANIZER":
                organizer = { address: stripMailto(value), displayName: params.CN };
                break;
            case "ATTENDEE":
                attendees.push({
                    address: stripMailto(value),
                    displayName: params.CN,
                    partstat: params.PARTSTAT ? PARTSTAT_TO_RESPONSE_STATUS[params.PARTSTAT.toUpperCase()] : undefined,
                });
                break;
            default:
                break;
        }
    }

    if (!uid || !method) {
        return undefined;
    }
    if (recurrenceRule) {
        recurrenceRule.exceptions = exceptions;
    }

    return { method, uid, sequence, summary, location, status, startDate, endDate, organizer, attendees, recurrenceId, recurrenceRule };
}

/** A single concrete occurrence instant produced by `expandOccurrences()`. */
export interface OccurrenceWindow {
    start: Date;
    end: Date;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Safety-net cap on how far past `event.startDate` a day-by-day scan will walk for an indefinitely
 * recurring (no `count`/`until`) rule - not a real RRULE limit, just a bound on worst-case cost. */
const MAX_SCAN_DAYS = 731;
/** Safety-net cap on the number of occurrences a single `expandOccurrences()` call will return. */
const MAX_OCCURRENCES = 500;

const BYDAY_TO_WEEKDAY: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function occurrenceOverlapsWindow(start: Date, end: Date, windowStart: Date, windowEnd: Date): boolean {
    return start.getTime() < windowEnd.getTime() && end.getTime() > windowStart.getTime();
}

/** `true` if `candidate` (a whole-day step from `seriesStart`, `daysSinceStart` days later) is a real
 * occurrence of `rule`. See `expandOccurrences()`'s own doc comment for the documented limitations this
 * inherits (no ordinal `BYDAY`, no `BYSETPOS`, no `WKST`-aware week alignment). */
function matchesRecurrenceDay(rule: RecurrenceRule, seriesStart: Date, candidate: Date, daysSinceStart: number): boolean {
    switch (rule.freq) {
        case RecurrenceFrequency.DAILY:
            return daysSinceStart % rule.interval === 0;
        case RecurrenceFrequency.WEEKLY: {
            const weekIndex = Math.floor(daysSinceStart / 7);
            if (weekIndex % rule.interval !== 0) {
                return false;
            }
            if (rule.byDay && rule.byDay.length > 0) {
                return rule.byDay.some((day) => BYDAY_TO_WEEKDAY[day.toUpperCase()] === candidate.getUTCDay());
            }
            return candidate.getUTCDay() === seriesStart.getUTCDay();
        }
        case RecurrenceFrequency.MONTHLY: {
            // `candidate` is always `seriesStart` plus a non-negative number of days, so `monthsSinceStart`
            // is always >= 0 - no separate "candidate before series start" case to guard against here.
            const monthsSinceStart =
                (candidate.getUTCFullYear() - seriesStart.getUTCFullYear()) * 12 + (candidate.getUTCMonth() - seriesStart.getUTCMonth());
            if (monthsSinceStart % rule.interval !== 0) {
                return false;
            }
            if (rule.byMonthDay && rule.byMonthDay.length > 0) {
                return rule.byMonthDay.includes(candidate.getUTCDate());
            }
            if (rule.byDay && rule.byDay.length > 0) {
                return rule.byDay.some((day) => BYDAY_TO_WEEKDAY[day.toUpperCase()] === candidate.getUTCDay());
            }
            return candidate.getUTCDate() === seriesStart.getUTCDate();
        }
        case RecurrenceFrequency.YEARLY: {
            // Same reasoning as MONTHLY above - `yearsSinceStart` is always >= 0.
            const yearsSinceStart = candidate.getUTCFullYear() - seriesStart.getUTCFullYear();
            if (yearsSinceStart % rule.interval !== 0) {
                return false;
            }
            if (rule.byMonth && rule.byMonth.length > 0 && !rule.byMonth.includes(candidate.getUTCMonth() + 1)) {
                return false;
            }
            if (rule.byMonthDay && rule.byMonthDay.length > 0) {
                return rule.byMonthDay.includes(candidate.getUTCDate());
            }
            if (rule.byDay && rule.byDay.length > 0) {
                return rule.byDay.some((day) => BYDAY_TO_WEEKDAY[day.toUpperCase()] === candidate.getUTCDay());
            }
            return candidate.getUTCMonth() === seriesStart.getUTCMonth() && candidate.getUTCDate() === seriesStart.getUTCDate();
        }
        default:
            return false;
    }
}

/**
 * Expands `event` (a `CalendarEvent`-shaped `{startDate, endDate, recurrenceRule?}`) into every occurrence
 * whose `[start, end)` overlaps `[windowStart, windowEnd]`. A non-recurring event yields at most one
 * occurrence (its own `startDate`/`endDate`). `excludeDates` (matched by exact instant) skips a generated
 * occurrence entirely - used both for `RecurrenceRule.exceptions` (EXDATE-cancelled occurrences) and for a
 * sibling override row's own `recurrenceId` (so a master's expansion doesn't phantom-generate an occurrence
 * at its *original* time when a real override row already represents that occurrence's actual, possibly
 * different, time).
 *
 * Bounded by `MAX_OCCURRENCES` (a runaway-loop safety net, not a real RRULE limit) - scans day-by-day from
 * `event.startDate` (not `windowStart`), since `COUNT`/`UNTIL` are counted from the series' true beginning,
 * capped at `MAX_SCAN_DAYS` from `event.startDate` to bound worst-case cost for a very old, indefinitely
 * recurring series.
 *
 * A day-by-day scan (rather than four bespoke per-frequency steppers) is deliberately the simplest correct
 * approach here: the window is capped small enough that a day-by-day scan is cheap, and one unified loop is
 * far easier to verify correct than bespoke DAILY/WEEKLY/MONTHLY/YEARLY advancement logic.
 */
export function expandOccurrences(
    event: { startDate: Date; endDate: Date; recurrenceRule?: RecurrenceRule },
    windowStart: Date,
    windowEnd: Date,
    excludeDates?: Date[],
): OccurrenceWindow[] {
    const durationMs = event.endDate.getTime() - event.startDate.getTime();
    const excluded = new Set((excludeDates ?? []).map((date) => date.getTime()));
    const rule = event.recurrenceRule;

    if (!rule) {
        if (excluded.has(event.startDate.getTime())) {
            return [];
        }
        return occurrenceOverlapsWindow(event.startDate, event.endDate, windowStart, windowEnd)
            ? [{ start: event.startDate, end: event.endDate }]
            : [];
    }

    const occurrences: OccurrenceWindow[] = [];
    const scanEndMs = Math.min(windowEnd.getTime(), event.startDate.getTime() + MAX_SCAN_DAYS * MS_PER_DAY);
    let matchCount = 0;

    for (let dayOffset = 0; ; dayOffset++) {
        const candidateStart = new Date(event.startDate.getTime() + dayOffset * MS_PER_DAY);
        if (candidateStart.getTime() > scanEndMs) {
            break;
        }
        if (rule.until && candidateStart.getTime() > rule.until.getTime()) {
            break;
        }
        if (!matchesRecurrenceDay(rule, event.startDate, candidateStart, dayOffset)) {
            continue;
        }
        matchCount++;
        if (rule.count !== undefined && matchCount > rule.count) {
            break;
        }
        if (!excluded.has(candidateStart.getTime())) {
            const candidateEnd = new Date(candidateStart.getTime() + durationMs);
            if (occurrenceOverlapsWindow(candidateStart, candidateEnd, windowStart, windowEnd)) {
                occurrences.push({ start: candidateStart, end: candidateEnd });
                if (occurrences.length >= MAX_OCCURRENCES) {
                    break;
                }
            }
        }
    }
    return occurrences;
}
