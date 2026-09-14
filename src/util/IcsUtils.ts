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
 * `PARTSTAT`/`RRULE`/`EXDATE`/`RECURRENCE-ID`/`DTSTAMP`), so it unfolds lines and extracts exactly those, ignoring
 * everything else (`X-` extensions, etc.) rather than attempting to model the full standard. It does track
 * `BEGIN`/`END` component nesting, so only properties directly inside a top-level `VEVENT` are read - a nested
 * `VALARM`'s `ATTENDEE`s or a `VTIMEZONE`'s `DTSTART`/`RRULE` are never mistaken for the event's own, and multiple
 * VEVENTs are never merged into one.
 *
 * Known, accepted limitations (a deliberate scope boundary, not an oversight):
 * - No RFC 5545 line-folding on generated output - folding is a SHOULD for writers, not a MUST for readers;
 * this library's own generated lines are short enough in practice that skipping it is safe.
 * - A `DTSTART`/`DTEND`/`RECURRENCE-ID`/`EXDATE`/`UNTIL` value with a `TZID` parameter is converted to UTC
 * via `Intl`'s built-in timezone database (no new dependency). `TZID` may be quoted (`TZID="America/New_York"`)
 * and may be a common Windows zone name (`"Pacific Standard Time"`, as classic Outlook emits) - see
 * `resolveTimeZone()`'s `WINDOWS_TO_IANA` table. A `TZID` that is neither a real IANA name nor in that table
 * (e.g. Outlook's display-style `"(UTC-08:00) Pacific Time (US & Canada)"`, or a custom `VTIMEZONE` name) still
 * falls back to treating the value as UTC - `VTIMEZONE` blocks themselves are never parsed.
 * - Recurrence expansion (`expandOccurrences()`) supports `FREQ`/`INTERVAL`/`COUNT`/`UNTIL`/`BYDAY` (including
 * ordinal forms like `2TU`/`-1FR` for `MONTHLY`/`YEARLY`)/`BYMONTHDAY` (including negative days)/`BYMONTH`,
 * with `WKST` fixed at the RFC default `MO`. `BYSETPOS`, `BYWEEKNO`, `BYYEARDAY`, `BYHOUR`/`BYMINUTE` and
 * sub-daily frequencies are not supported.
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
    /** The IANA zone `DTSTART`'s `TZID` resolved to (see `resolveTimeZone()`), if it had a recognizable one -
     * suitable for `CalendarEvent.timezone`, which `expandOccurrences()` uses for wall-clock (DST-correct)
     * recurrence stepping. */
    timezone?: string;
    status?: string;
    organizer?: { address: string; displayName?: string };
    attendees: { address: string; displayName?: string; partstat?: AttendeeResponseStatus }[];
    /** Present only on a single-occurrence override VEVENT - identifies which occurrence of the master
     * series (same `uid`) this VEVENT replaces. */
    recurrenceId?: Date;
    /** Present only on a master/whole-series VEVENT - this event's recurrence definition. `exceptions` is
     * populated from every `EXDATE` line, regardless of where it appears relative to `RRULE`. */
    recurrenceRule?: RecurrenceRule;
    /** The VEVENT's `DTSTAMP` (when this iTIP message instance was created), if present - lets a consumer tell a
     * stale, re-delivered message apart from a newer one carrying the same `SEQUENCE`. */
    dtstamp?: Date;
    /** Every *other* VEVENT in the same message that shares this event's `uid` and carries a `RECURRENCE-ID` -
     * i.e. the per-occurrence overrides an organizer sends alongside the master VEVENT. Omitted when there are
     * none. The top-level fields always describe only one VEVENT (see `parseIcsEvent()`). */
    overrides?: Omit<ParsedIcsEvent, "method" | "overrides">[];
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

/** Escapes an RFC 5545 §3.3.11 `TEXT` value. Every line break form (`\r\n`, `\n`, bare `\r`) becomes the literal
 * `\n` escape, and every other control character (RFC 5545 forbids CTLs in TEXT, except HTAB) is stripped - so a
 * user-supplied value (e.g. an event title) can never end the content line early and inject its own
 * properties/components. */
function escapeText(value: string): string {
    return String(value)
        .replace(/\r\n|\r|\n/g, "\n")
        .split("")
        .filter((ch) => ch === "\t" || ch === "\n" || !isControlChar(ch))
        .join("")
        .replace(/\\/g, "\\\\")
        .replace(/\n/g, "\\n")
        .replace(/,/g, "\\,")
        .replace(/;/g, "\\;");
}

/** Formats an RFC 5545 §3.2 parameter value: always DQUOTE-wrapped (so `;`, `:` and `,` can't end the parameter
 * or start the property value), with `"` and every control character (CR/LF included) removed, since a quoted
 * parameter value can contain neither. */
function quoteParamValue(value: string): string {
    return `"${stripControlChars(value).replace(/"/g, "")}"`;
}

/** Strips every control character (CR/LF included) from a non-TEXT property value this module interpolates
 * verbatim (a `UID`, a `mailto:` address), so it can't break out of its content line either. */
function stripControlChars(value: string): string {
    return String(value)
        .split("")
        .filter((ch) => !isControlChar(ch))
        .join("");
}

/** A C0 control character or DEL (RFC 5545 `CONTROL`, plus the HTAB/LF/CR it excludes). */
function isControlChar(ch: string): boolean {
    const code: number = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
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

/** Accepts `string` alongside the declared `Date` type because `CalendarEventMongo` persists
 * `startDate`/`endDate`/`recurrenceId` (and `RecurrenceRule.until`/`exceptions`) as plain strings despite
 * being typed `Date` - every caller here (`buildEventIcs()`) passes a value read straight off a persisted
 * `CalendarEvent`, so without this coercion any such value throws here instead of formatting correctly. */
function formatDateUtc(date: Date | string): string {
    const d = date instanceof Date ? date : new Date(date);
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
        `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
        `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
    );
}

/** Converts a local wall-clock date/time in IANA timezone `tzid` to its equivalent UTC instant using only
 * Node's built-in `Intl`/ICU timezone database. Returns `undefined` if `Intl` doesn't recognize `tzid`.
 *
 * Exported (rather than kept module-private like the other helpers here) because `util/BookingUtils.ts` needs
 * exactly this conversion to turn a `BookingType`'s local availability windows into real instants, and because
 * its `undefined` return doubles as the validation hook for a caller-supplied IANA timezone name. */
export function convertLocalToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tzid: string): Date | undefined {
    const formatter: Intl.DateTimeFormat | undefined = getZoneFormatter(tzid);
    if (!formatter) {
        return undefined;
    }
    const reference = Date.UTC(y, mo - 1, d, h, mi, s);
    // A single "offset at `reference`" pass is off by an hour for wall-clock times near a DST transition, since
    // `reference` (the wall clock read as if it were UTC) and the real instant can straddle the transition. So
    // take the zone's offsets a day either side (which always bracket the real instant), and keep whichever
    // candidate instant really renders back as the requested wall clock. Both valid = an ambiguous fall-back
    // time: RFC 5545 §3.3.5 says use the first (earlier) one. Neither valid = a skipped spring-forward time:
    // RFC 5545 says interpret it with the offset from before the gap, which is the later of the two instants.
    const candidates = new Set<number>([
        reference - zoneOffsetMs(reference - MS_PER_DAY, formatter),
        reference - zoneOffsetMs(reference + MS_PER_DAY, formatter),
    ]);
    const valid: number[] = [...candidates].filter((instant) => zoneOffsetMs(instant, formatter) === reference - instant);
    return new Date(valid.length > 0 ? Math.min(...valid) : Math.max(...candidates));
}

const zoneFormatterCache: Map<string, Intl.DateTimeFormat | null> = new Map();

/** A cached `Intl.DateTimeFormat` rendering full wall-clock parts in IANA zone `tzid`, or `undefined` if `Intl`
 * doesn't recognize `tzid`. Constructing a formatter is by far the expensive part of every zone conversion here,
 * and a single recurrence expansion can convert hundreds of instants in the same zone. */
function getZoneFormatter(tzid: string): Intl.DateTimeFormat | undefined {
    let formatter: Intl.DateTimeFormat | null | undefined = zoneFormatterCache.get(tzid);
    if (formatter === undefined) {
        try {
            formatter = new Intl.DateTimeFormat("en-US", {
                timeZone: tzid,
                hourCycle: "h23",
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
            });
        } catch {
            formatter = null;
        }
        // Bounded: only ever real zone names (a few hundred) or junk strings from inbound invites - reset rather
        // than grow without limit if something keeps feeding it distinct garbage.
        if (zoneFormatterCache.size > 1000) {
            zoneFormatterCache.clear();
        }
        zoneFormatterCache.set(tzid, formatter);
    }
    return formatter ?? undefined;
}

interface WallClockParts {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
}

function wallClockParts(instantMs: number, formatter: Intl.DateTimeFormat): WallClockParts {
    const parts: Record<string, string> = {};
    for (const part of formatter.formatToParts(new Date(instantMs))) {
        parts[part.type] = part.value;
    }
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        // `hourCycle: "h23"` can still render midnight as "24" depending on ICU data - normalize it.
        hour: parts.hour === "24" ? 0 : Number(parts.hour),
        minute: Number(parts.minute),
        second: Number(parts.second),
    };
}

/** The zone's UTC offset (local wall clock minus UTC) at `instantMs`, in whole seconds' worth of milliseconds. */
function zoneOffsetMs(instantMs: number, formatter: Intl.DateTimeFormat): number {
    const wholeSecond = instantMs - (((instantMs % 1000) + 1000) % 1000);
    const p = wallClockParts(wholeSecond, formatter);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - wholeSecond;
}

/** Windows time zone names (as classic Outlook/Exchange emit in `TZID`) mapped to their CLDR "001" IANA
 * equivalents. Deliberately a small table of the most common zones, not the full CLDR `windowsZones.xml`. Keys
 * are lowercase. */
const WINDOWS_TO_IANA: Record<string, string> = {
    "dateline standard time": "Etc/GMT+12",
    "hawaiian standard time": "Pacific/Honolulu",
    "alaskan standard time": "America/Anchorage",
    "pacific standard time": "America/Los_Angeles",
    "us mountain standard time": "America/Phoenix",
    "mountain standard time": "America/Denver",
    "central standard time": "America/Chicago",
    "canada central standard time": "America/Regina",
    "central america standard time": "America/Guatemala",
    "eastern standard time": "America/New_York",
    "sa pacific standard time": "America/Bogota",
    "atlantic standard time": "America/Halifax",
    "newfoundland standard time": "America/St_Johns",
    "e. south america standard time": "America/Sao_Paulo",
    "argentina standard time": "America/Buenos_Aires",
    utc: "UTC",
    "coordinated universal time": "UTC",
    "gmt standard time": "Europe/London",
    "greenwich standard time": "Atlantic/Reykjavik",
    "w. europe standard time": "Europe/Berlin",
    "central europe standard time": "Europe/Budapest",
    "central european standard time": "Europe/Warsaw",
    "romance standard time": "Europe/Paris",
    "w. central africa standard time": "Africa/Lagos",
    "e. europe standard time": "Europe/Chisinau",
    "gtb standard time": "Europe/Bucharest",
    "fle standard time": "Europe/Helsinki",
    "israel standard time": "Asia/Jerusalem",
    "south africa standard time": "Africa/Johannesburg",
    "egypt standard time": "Africa/Cairo",
    "turkey standard time": "Europe/Istanbul",
    "russian standard time": "Europe/Moscow",
    "arab standard time": "Asia/Riyadh",
    "arabian standard time": "Asia/Dubai",
    "iran standard time": "Asia/Tehran",
    "pakistan standard time": "Asia/Karachi",
    "india standard time": "Asia/Kolkata",
    "bangladesh standard time": "Asia/Dhaka",
    "se asia standard time": "Asia/Bangkok",
    "singapore standard time": "Asia/Singapore",
    "china standard time": "Asia/Shanghai",
    "taipei standard time": "Asia/Taipei",
    "w. australia standard time": "Australia/Perth",
    "tokyo standard time": "Asia/Tokyo",
    "korea standard time": "Asia/Seoul",
    "cen. australia standard time": "Australia/Adelaide",
    "aus central standard time": "Australia/Darwin",
    "e. australia standard time": "Australia/Brisbane",
    "aus eastern standard time": "Australia/Sydney",
    "new zealand standard time": "Pacific/Auckland",
};

/**
 * Resolves an iCalendar `TZID` (or a stored `CalendarEvent.timezone`) to an IANA zone name `Intl` recognizes:
 * strips surrounding double quotes, maps common Windows zone names via `WINDOWS_TO_IANA`, and returns
 * `undefined` for anything `Intl` still doesn't know.
 */
export function resolveTimeZone(tzid: string | undefined | null): string | undefined {
    if (typeof tzid !== "string") {
        return undefined;
    }
    let name: string = tzid.trim();
    if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
        name = name.slice(1, -1).trim();
    }
    if (!name) {
        return undefined;
    }
    const candidate: string = WINDOWS_TO_IANA[name.toLowerCase()] ?? name;
    return getZoneFormatter(candidate) ? candidate : undefined;
}

/** Parses a single RFC 5545 `DATE-TIME`/`DATE` value (`20260615T120000Z`, `20260615T120000`, or the
 * date-only `20260615`), honoring a `TZID` parameter if given - see this module's own doc comment for the
 * documented fallback behavior when `tzid` can't be resolved (`resolveTimeZone()`). */
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
    const zone: string | undefined = !z ? resolveTimeZone(tzid) : undefined;
    if (zone) {
        const converted = convertLocalToUtc(year, month, day, hour, minute, second, zone);
        if (converted) {
            return converted;
        }
    }
    return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

/** Parses `;NAME=value;NAME2="quoted; value"` parameters. RFC 5545 §3.2 allows a parameter value to be a
 * DQUOTE-wrapped string (which may then contain `;`, `:` and `,`) - the quotes are stripped here. */
function parseParams(paramString: string): Record<string, string> {
    const params: Record<string, string> = {};
    const segments: string[] = [];
    let current = "";
    let inQuotes = false;
    for (const ch of paramString.replace(/^;/, "")) {
        if (ch === '"') {
            inQuotes = !inQuotes;
            current += ch;
        } else if (ch === ";" && !inQuotes) {
            segments.push(current);
            current = "";
        } else {
            current += ch;
        }
    }
    segments.push(current);
    for (const segment of segments) {
        const eq = segment.indexOf("=");
        if (eq > 0) {
            params[segment.slice(0, eq).toUpperCase()] = segment.slice(eq + 1).replace(/^"(.*)"$/, "$1");
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

/** Parses an `RRULE`'s `UNTIL` value. `tzid` is the owning VEVENT's `DTSTART` `TZID` (if any):
 * - A `DATE`-form value (`UNTIL=20261231`) bounds the series by that whole *local* calendar day in `tzid`, so it
 * resolves to the last millisecond of that day there - an occurrence later that same day is still included,
 * rather than being cut off by a UTC-midnight reading of the date.
 * - A floating `DATE-TIME` value (no `Z`) is read in `tzid` too, matching how `DTSTART` itself was read; a
 * `Z`-suffixed value is UTC as usual. */
function parseUntil(value: string, tzid?: string): Date | undefined {
    const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim());
    if (!dateOnly) {
        return parseIcsDateTime(value, tzid);
    }
    const next = dayNumberToDate(dayNumber(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])) + 1);
    const zone: string | undefined = resolveTimeZone(tzid);
    // `resolveTimeZone()` only returns a zone `Intl` recognizes, so `convertLocalToUtc()` can't return undefined here.
    const nextMidnightMs: number = zone
        ? convertLocalToUtc(next.year, next.month, next.day, 0, 0, 0, zone)!.getTime()
        : Date.UTC(next.year, next.month - 1, next.day);
    return new Date(nextMidnightMs - 1);
}

function parseRrule(value: string, tzid?: string): RecurrenceRule {
    const params = parseParams(`;${value}`);
    return {
        freq: (params.FREQ ?? "").toLowerCase() as RecurrenceFrequency,
        interval: params.INTERVAL ? parseInt(params.INTERVAL, 10) : 1,
        byDay: params.BYDAY ? params.BYDAY.split(",") : undefined,
        byMonthDay: params.BYMONTHDAY ? params.BYMONTHDAY.split(",").map(Number) : undefined,
        byMonth: params.BYMONTH ? params.BYMONTH.split(",").map(Number) : undefined,
        count: params.COUNT ? parseInt(params.COUNT, 10) : undefined,
        until: params.UNTIL ? parseUntil(params.UNTIL, tzid) : undefined,
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
    lines.push(`UID:${stripControlChars(event.icalUid)}`);
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
    const organizerCn = event.organizer.displayName ? `;CN=${quoteParamValue(event.organizer.displayName)}` : "";
    lines.push(`ORGANIZER${organizerCn}:mailto:${stripControlChars(event.organizer.address)}`);

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
        const cn = attendee.displayName ? `;CN=${quoteParamValue(attendee.displayName)}` : "";
        const partstat = `;PARTSTAT=${RESPONSE_STATUS_TO_PARTSTAT[attendee.responseStatus]}`;
        const role =
            attendee.role === AttendeeRole.RESOURCE ? "RESOURCE" : attendee.role === AttendeeRole.OPTIONAL ? "OPT-PARTICIPANT" : "REQ-PARTICIPANT";
        lines.push(`ATTENDEE;ROLE=${role}${partstat}${cn}:mailto:${stripControlChars(attendee.address)}`);
    }

    lines.push("END:VEVENT", "END:VCALENDAR");
    return lines.join("\r\n");
}

/**
 * Parses the fields this feature needs out of a raw iTIP `text/calendar` payload. Returns `undefined` if
 * `raw` has no recognizable `UID`+`METHOD` (not a real/complete iTIP message).
 *
 * The top-level fields describe exactly one VEVENT: the first one with no `RECURRENCE-ID` (the series master),
 * or - when every VEVENT has one, as in a single-occurrence REQUEST/CANCEL - the first VEVENT. Any other VEVENTs
 * for the same `UID` that carry a `RECURRENCE-ID` are returned in `overrides`. `METHOD` is only read at the
 * `VCALENDAR` level.
 */
export function parseIcsEvent(raw: string): ParsedIcsEvent | undefined {
    const unfolded = raw.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").replace(/\r[ \t]/g, "");
    const lines = unfolded.split(/\r\n|\r|\n/);

    let method: string | undefined;
    const vevents: VEventAccumulator[] = [];
    // Open components, innermost last. Only a property whose innermost open component is a VEVENT belongs to
    // that VEVENT - a nested VALARM's `ATTENDEE`, or a VTIMEZONE's `DTSTART`/`RRULE`, must never be read as the
    // event's own.
    const stack: string[] = [];
    let current: VEventAccumulator | undefined;
    let currentDepth = 0;

    for (const line of lines) {
        // The parameter group allows DQUOTE-wrapped values containing `:` (e.g. `CN="Doe: John"`), so the
        // property value only starts at the first colon outside quotes.
        const match = /^([A-Za-z0-9-]+)((?:;(?:[^:;"]|"[^"]*")*)*):(.*)$/.exec(line);
        if (!match) {
            continue;
        }
        const property = match[1].toUpperCase();
        const params = parseParams(match[2]);
        const value = match[3];

        if (property === "BEGIN") {
            const component = value.trim().toUpperCase();
            stack.push(component);
            if (component === "VEVENT" && stack.length <= 2 && (stack.length === 1 || stack[0] === "VCALENDAR")) {
                current = newVEventAccumulator();
                currentDepth = stack.length;
                vevents.push(current);
            }
            continue;
        }
        if (property === "END") {
            const component = value.trim().toUpperCase();
            // Tolerate a mismatched END by unwinding to the nearest matching BEGIN, if there is one.
            const index = stack.lastIndexOf(component);
            if (index >= 0) {
                stack.length = index;
            }
            if (stack.length < currentDepth) {
                current = undefined;
            }
            continue;
        }

        const top: string | undefined = stack[stack.length - 1];
        if (property === "METHOD") {
            if (top === undefined || top === "VCALENDAR") {
                method = value.trim().toUpperCase();
            }
            continue;
        }
        if (!current || stack.length !== currentDepth) {
            continue;
        }
        applyVEventProperty(current, property, params, value);
    }

    // The master is the first VEVENT without a RECURRENCE-ID; a message carrying only override VEVENTs (e.g. a
    // single-occurrence REQUEST/CANCEL) falls back to its first VEVENT, as before.
    const primaryIndex: number = Math.max(0, vevents.findIndex((vevent) => !vevent.recurrenceId));
    const primary: VEventAccumulator | undefined = vevents[primaryIndex];
    if (!primary || !primary.uid || !method) {
        return undefined;
    }

    const master: ParsedIcsVEvent = finishVEvent(primary);
    const overrides: ParsedIcsVEvent[] = vevents
        .filter((vevent, index) => index !== primaryIndex && vevent.uid === primary.uid && vevent.recurrenceId)
        .map(finishVEvent);

    return { method, ...master, ...(overrides.length > 0 ? { overrides } : {}) };
}

/** The per-VEVENT fields of a `ParsedIcsEvent` (everything but the calendar-level `method`). */
export type ParsedIcsVEvent = Omit<ParsedIcsEvent, "method" | "overrides">;

interface VEventAccumulator {
    uid?: string;
    sequence: number;
    summary?: string;
    location?: string;
    status?: string;
    startDate?: Date;
    endDate?: Date;
    timezone?: string;
    dtstartTzid?: string;
    dtstamp?: Date;
    recurrenceId?: Date;
    rruleValue?: string;
    exceptions: Date[];
    organizer?: { address: string; displayName?: string };
    attendees: { address: string; displayName?: string; partstat?: AttendeeResponseStatus }[];
}

function newVEventAccumulator(): VEventAccumulator {
    return { sequence: 0, exceptions: [], attendees: [] };
}

function applyVEventProperty(vevent: VEventAccumulator, property: string, params: Record<string, string>, value: string): void {
    switch (property) {
        case "UID":
            vevent.uid = value.trim();
            break;
        case "SEQUENCE":
            vevent.sequence = parseInt(value.trim(), 10) || 0;
            break;
        case "SUMMARY":
            vevent.summary = unescapeText(value);
            break;
        case "LOCATION":
            vevent.location = unescapeText(value);
            break;
        case "STATUS":
            vevent.status = value.trim().toUpperCase();
            break;
        case "DTSTAMP":
            vevent.dtstamp = parseIcsDateTime(value, params.TZID);
            break;
        case "DTSTART":
            vevent.startDate = parseIcsDateTime(value, params.TZID);
            vevent.timezone = /Z\s*$/i.test(value) ? undefined : resolveTimeZone(params.TZID);
            vevent.dtstartTzid = /Z\s*$/i.test(value) ? undefined : params.TZID;
            break;
        case "DTEND":
            vevent.endDate = parseIcsDateTime(value, params.TZID);
            break;
        case "RECURRENCE-ID":
            vevent.recurrenceId = parseIcsDateTime(value, params.TZID);
            break;
        case "EXDATE":
            for (const part of value.split(",")) {
                const parsedException = parseIcsDateTime(part, params.TZID);
                if (parsedException) {
                    vevent.exceptions.push(parsedException);
                }
            }
            break;
        case "RRULE":
            vevent.rruleValue = value;
            break;
        case "ORGANIZER":
            vevent.organizer = { address: stripMailto(value), displayName: params.CN };
            break;
        case "ATTENDEE":
            vevent.attendees.push({
                address: stripMailto(value),
                displayName: params.CN,
                partstat: params.PARTSTAT ? PARTSTAT_TO_RESPONSE_STATUS[params.PARTSTAT.toUpperCase()] : undefined,
            });
            break;
        default:
            break;
    }
}

function finishVEvent(vevent: VEventAccumulator): ParsedIcsVEvent {
    // RRULE is only interpreted once the whole VEVENT has been read, since its `UNTIL` depends on `DTSTART`'s
    // `TZID` and the two may appear in either order.
    const recurrenceRule: RecurrenceRule | undefined = vevent.rruleValue !== undefined ? parseRrule(vevent.rruleValue, vevent.dtstartTzid) : undefined;
    if (recurrenceRule) {
        recurrenceRule.exceptions = vevent.exceptions;
    }
    return {
        uid: vevent.uid ?? "",
        sequence: vevent.sequence,
        summary: vevent.summary,
        location: vevent.location,
        status: vevent.status,
        startDate: vevent.startDate,
        endDate: vevent.endDate,
        timezone: vevent.timezone,
        organizer: vevent.organizer,
        attendees: vevent.attendees,
        recurrenceId: vevent.recurrenceId,
        recurrenceRule,
        ...(vevent.dtstamp ? { dtstamp: vevent.dtstamp } : {}),
    };
}

/** A single concrete occurrence instant produced by `expandOccurrences()`. */
export interface OccurrenceWindow {
    start: Date;
    end: Date;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Safety-net cap on how many recurrence periods (days/weeks/months/years, per `FREQ`) a single
 * `expandOccurrences()` call will walk - not a real RRULE limit, just a bound on worst-case cost (e.g. a rule whose
 * `BYxxx` parts can never match, over a huge window). */
const MAX_PERIODS = 50_000;
/** Safety-net cap on the number of occurrences a single `expandOccurrences()` call will return. */
const MAX_OCCURRENCES = 500;

const BYDAY_TO_WEEKDAY: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function occurrenceOverlapsWindow(start: Date, end: Date, windowStart: Date, windowEnd: Date): boolean {
    return start.getTime() < windowEnd.getTime() && end.getTime() > windowStart.getTime();
}

function toDate(value: Date | string): Date {
    return value instanceof Date ? value : new Date(value);
}

/** Days since 1970-01-01 for a proleptic-Gregorian calendar date - the unit all local-date arithmetic below uses. */
function dayNumber(year: number, month: number, day: number): number {
    return Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

function dayNumberToDate(dayNum: number): { year: number; month: number; day: number } {
    const d = new Date(dayNum * MS_PER_DAY);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 0 = Sunday ... 6 = Saturday. 1970-01-01 was a Thursday. */
function weekdayOf(dayNum: number): number {
    return (((dayNum + 4) % 7) + 7) % 7;
}

function daysInMonth(year: number, month: number): number {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

interface ParsedByDay {
    weekday: number;
    /** `undefined` = every such weekday in the period; positive = nth from the start; negative = nth from the end. */
    ordinal?: number;
}

function parseByDay(byDay: string[] | undefined): ParsedByDay[] {
    const result: ParsedByDay[] = [];
    for (const entry of byDay ?? []) {
        const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(String(entry).trim());
        if (match) {
            const ordinal = match[1] !== undefined ? parseInt(match[1], 10) : undefined;
            result.push({ weekday: BYDAY_TO_WEEKDAY[match[2].toUpperCase()], ordinal: ordinal === 0 ? undefined : ordinal });
        }
    }
    return result;
}

/** Every day in `[firstDay, lastDay]` matching `byDay`, honoring ordinals relative to that range. */
function expandByDayInRange(firstDay: number, lastDay: number, byDay: ParsedByDay[]): number[] {
    const days = new Set<number>();
    for (const { weekday, ordinal } of byDay) {
        const firstMatch = firstDay + ((weekday - weekdayOf(firstDay) + 7) % 7);
        if (ordinal === undefined) {
            for (let day = firstMatch; day <= lastDay; day += 7) {
                days.add(day);
            }
        } else if (ordinal > 0) {
            const day = firstMatch + (ordinal - 1) * 7;
            if (day <= lastDay) {
                days.add(day);
            }
        } else {
            const lastMatch = lastDay - ((weekdayOf(lastDay) - weekday + 7) % 7);
            const day = lastMatch + (ordinal + 1) * 7;
            if (day >= firstDay) {
                days.add(day);
            }
        }
    }
    return [...days];
}

/** The days of `year`/`month` selected by `byMonthDay`/`byDay` (both set = their intersection, with `byDay`
 * ordinals ignored), defaulting to `fallbackDay` when neither is set. */
function monthDays(year: number, month: number, byMonthDay: number[], byDay: ParsedByDay[], fallbackDay: number): number[] {
    const dim = daysInMonth(year, month);
    const first = dayNumber(year, month, 1);
    if (byMonthDay.length > 0) {
        const allowedWeekdays = new Set(byDay.map((entry) => entry.weekday));
        return byMonthDay
            .map((value) => (value < 0 ? dim + 1 + value : value))
            .filter((value) => value >= 1 && value <= dim)
            .map((value) => first + value - 1)
            .filter((day) => byDay.length === 0 || allowedWeekdays.has(weekdayOf(day)));
    }
    if (byDay.length > 0) {
        return expandByDayInRange(first, first + dim - 1, byDay);
    }
    return fallbackDay <= dim ? [first + fallbackDay - 1] : [];
}

const SUPPORTED_FREQUENCIES: string[] = [RecurrenceFrequency.DAILY, RecurrenceFrequency.WEEKLY, RecurrenceFrequency.MONTHLY, RecurrenceFrequency.YEARLY];

/**
 * Expands `event` (a `CalendarEvent`-shaped `{startDate, endDate, recurrenceRule?, timezone?, allDay?}`) into
 * every occurrence whose `[start, end)` overlaps `[windowStart, windowEnd]`. A non-recurring event yields at most
 * one occurrence (its own `startDate`/`endDate`). `excludeDates` (matched by exact instant) skips a generated
 * occurrence entirely - used both for `RecurrenceRule.exceptions` (EXDATE-cancelled occurrences) and for a
 * sibling override row's own `recurrenceId` (so a master's expansion doesn't phantom-generate an occurrence at
 * its *original* time when a real override row already represents that occurrence's actual, possibly different,
 * time).
 *
 * **Wall-clock stepping.** Occurrences are generated as local calendar dates in `event.timezone` (resolved via
 * `resolveTimeZone()`, so Windows zone names work too) at `startDate`'s own local time of day, then converted
 * back to instants - so a 09:00 America/New_York weekly meeting stays 09:00 local across a DST change rather than
 * drifting an hour. With no (recognizable) `timezone`, or for an `allDay` event (stored as UTC midnights), the
 * expansion runs in UTC - callers that don't pass `timezone` get exactly the previous UTC behavior. Each
 * occurrence's end is its start plus the master's real elapsed duration.
 *
 * **Period-based, windowed.** Rather than scanning day by day from the series start, each `FREQ` period
 * (day/week/month/year, every `INTERVAL`th) is expanded directly by its `BYxxx` parts, and when there's no `COUNT`
 * the walk jumps straight to the period just before the query window - so a long-running series (e.g. a daily
 * standup started years ago) still expands correctly in today's window. With `COUNT` the walk has to start at the
 * series start (occurrences are counted from there), but is bounded by `COUNT` itself, and occurrences that are
 * only being counted skip the zone conversion. Weeks start on Monday (`WKST=MO`, the RFC default). See this
 * module's own doc comment for unsupported rule parts.
 *
 * Bounded by `MAX_OCCURRENCES` and `MAX_PERIODS` (runaway-loop safety nets, not real RRULE limits).
 */
export function expandOccurrences(
    event: { startDate: Date | string; endDate: Date | string; recurrenceRule?: RecurrenceRule; timezone?: string; allDay?: boolean },
    windowStart: Date,
    windowEnd: Date,
    excludeDates?: (Date | string)[],
): OccurrenceWindow[] {
    return expandOccurrencesDetailed(event, windowStart, windowEnd, excludeDates).occurrences;
}

/** The result of `expandOccurrencesDetailed()`. */
export interface OccurrenceExpansion {
    occurrences: OccurrenceWindow[];
    /**
     * `true` when a safety cap (`MAX_OCCURRENCES`/`MAX_PERIODS`) stopped the expansion before the window was fully
     * covered, so `occurrences` is known to be incomplete (for `MAX_OCCURRENCES`: another occurrence past the cap was found). A caller doing conflict detection must treat this as
     * "cannot prove there's no conflict" rather than as "no conflict".
     */
    truncated: boolean;
}

/** `expandOccurrences()`, but also reports whether a safety cap truncated the result - see `OccurrenceExpansion`. */
export function expandOccurrencesDetailed(
    event: { startDate: Date | string; endDate: Date | string; recurrenceRule?: RecurrenceRule; timezone?: string; allDay?: boolean },
    windowStart: Date,
    windowEnd: Date,
    excludeDates?: (Date | string)[],
): OccurrenceExpansion {
    const info = { truncated: false };
    const occurrences = expandOccurrencesInternal(event, windowStart, windowEnd, excludeDates, info);
    return { occurrences, truncated: info.truncated };
}

function expandOccurrencesInternal(
    event: { startDate: Date | string; endDate: Date | string; recurrenceRule?: RecurrenceRule; timezone?: string; allDay?: boolean },
    windowStart: Date,
    windowEnd: Date,
    excludeDates: (Date | string)[] | undefined,
    info: { truncated: boolean },
): OccurrenceWindow[] {
    const seriesStart: Date = toDate(event.startDate);
    const seriesEnd: Date = toDate(event.endDate);
    const durationMs = seriesEnd.getTime() - seriesStart.getTime();
    const excluded = new Set((excludeDates ?? []).map((date) => toDate(date).getTime()));
    const rule = event.recurrenceRule;

    if (!rule) {
        if (excluded.has(seriesStart.getTime())) {
            return [];
        }
        return occurrenceOverlapsWindow(seriesStart, seriesEnd, windowStart, windowEnd) ? [{ start: seriesStart, end: seriesEnd }] : [];
    }

    const freq: string = String(rule.freq ?? "").toLowerCase();
    if (!SUPPORTED_FREQUENCIES.includes(freq)) {
        return [];
    }
    const interval: number = Number(rule.interval) >= 1 ? Math.floor(Number(rule.interval)) : 1;
    const count: number | undefined = rule.count !== undefined && rule.count !== null ? Number(rule.count) : undefined;
    const untilMs: number | undefined = rule.until !== undefined && rule.until !== null ? toDate(rule.until).getTime() : undefined;
    const byDay: ParsedByDay[] = parseByDay(rule.byDay);
    const byMonth: number[] = (rule.byMonth ?? []).map(Number);
    const byMonthDay: number[] = (rule.byMonthDay ?? []).map(Number);

    const zone: string = (!event.allDay && resolveTimeZone(event.timezone)) || "UTC";
    const formatter: Intl.DateTimeFormat | undefined = zone === "UTC" ? undefined : getZoneFormatter(zone);
    const localDayOf = (instantMs: number): number => {
        if (!formatter) {
            return Math.floor(instantMs / MS_PER_DAY);
        }
        const p = wallClockParts(instantMs, formatter);
        return dayNumber(p.year, p.month, p.day);
    };

    const startLocal: WallClockParts = formatter
        ? wallClockParts(seriesStart.getTime(), formatter)
        : {
              year: seriesStart.getUTCFullYear(),
              month: seriesStart.getUTCMonth() + 1,
              day: seriesStart.getUTCDate(),
              hour: seriesStart.getUTCHours(),
              minute: seriesStart.getUTCMinutes(),
              second: seriesStart.getUTCSeconds(),
          };
    const startMillis = ((seriesStart.getTime() % 1000) + 1000) % 1000;
    const startDay: number = dayNumber(startLocal.year, startLocal.month, startLocal.day);
    const startMonthIndex: number = startLocal.year * 12 + (startLocal.month - 1);
    const startWeekMonday: number = startDay - ((weekdayOf(startDay) + 6) % 7);

    const toInstant = (dayNum: number): Date => {
        const { year, month, day } = dayNumberToDate(dayNum);
        const ms: number = formatter
            ? convertLocalToUtc(year, month, day, startLocal.hour, startLocal.minute, startLocal.second, zone)!.getTime()
            : Date.UTC(year, month - 1, day, startLocal.hour, startLocal.minute, startLocal.second);
        return new Date(ms + startMillis);
    };

    const monthOfIndex = (monthIndex: number): { year: number; month: number } => ({
        year: Math.floor(monthIndex / 12),
        month: (((monthIndex % 12) + 12) % 12) + 1,
    });

    const periodFirstDay = (k: number): number => {
        switch (freq) {
            case RecurrenceFrequency.DAILY:
                return startDay + k * interval;
            case RecurrenceFrequency.WEEKLY:
                return startWeekMonday + k * interval * 7;
            case RecurrenceFrequency.MONTHLY: {
                const { year, month } = monthOfIndex(startMonthIndex + k * interval);
                return dayNumber(year, month, 1);
            }
            default:
                return dayNumber(startLocal.year + k * interval, 1, 1);
        }
    };

    const periodDays = (k: number): number[] => {
        let days: number[];
        switch (freq) {
            case RecurrenceFrequency.DAILY: {
                // BYMONTHDAY/BYDAY only limit a DAILY rule (ordinals meaningless here, so ignored).
                const day = startDay + k * interval;
                const { year, month, day: dom } = dayNumberToDate(day);
                const dim = daysInMonth(year, month);
                const matchesMonthDay = byMonthDay.length === 0 || byMonthDay.some((value) => (value < 0 ? dim + 1 + value : value) === dom);
                const matchesWeekday = byDay.length === 0 || byDay.some((entry) => entry.weekday === weekdayOf(day));
                days = matchesMonthDay && matchesWeekday ? [day] : [];
                break;
            }
            case RecurrenceFrequency.WEEKLY: {
                const monday = startWeekMonday + k * interval * 7;
                const weekdays = byDay.length > 0 ? byDay.map((entry) => entry.weekday) : [weekdayOf(startDay)];
                days = [...new Set(weekdays.map((weekday) => monday + ((weekday + 6) % 7)))];
                break;
            }
            case RecurrenceFrequency.MONTHLY: {
                const { year, month } = monthOfIndex(startMonthIndex + k * interval);
                days = monthDays(year, month, byMonthDay, byDay, startLocal.day);
                break;
            }
            default: {
                const year = startLocal.year + k * interval;
                if (byMonth.length > 0) {
                    days = byMonth.flatMap((month) => (month >= 1 && month <= 12 ? monthDays(year, month, byMonthDay, byDay, startLocal.day) : []));
                } else if (byMonthDay.length > 0) {
                    days = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].flatMap((month) => monthDays(year, month, byMonthDay, byDay, startLocal.day));
                } else if (byDay.length > 0) {
                    // No BYMONTH: an ordinal BYDAY (e.g. `20MO`) counts within the whole year (RFC 5545 §3.3.10).
                    days = expandByDayInRange(dayNumber(year, 1, 1), dayNumber(year, 12, 31), byDay);
                } else {
                    days = startLocal.day <= daysInMonth(year, startLocal.month) ? [dayNumber(year, startLocal.month, startLocal.day)] : [];
                }
                break;
            }
        }
        // BYMONTH limits DAILY/WEEKLY/MONTHLY periods (YEARLY is already expanded by it above).
        if (byMonth.length > 0 && freq !== RecurrenceFrequency.YEARLY) {
            days = days.filter((day) => byMonth.includes(dayNumberToDate(day).month));
        }
        return days.sort((a, b) => a - b);
    };

    // Local days strictly before this can't produce an occurrence overlapping the window (a day of margin either
    // side absorbs any zone-offset/time-of-day slack).
    const earliestRelevantDay: number = localDayOf(windowStart.getTime() - Math.max(durationMs, 0)) - 1;
    const lastRelevantDay: number = localDayOf(windowEnd.getTime()) + 1;
    const untilDay: number | undefined = untilMs !== undefined ? localDayOf(untilMs) - 1 : undefined;

    let firstPeriod = 0;
    if (count === undefined && earliestRelevantDay > startDay) {
        switch (freq) {
            case RecurrenceFrequency.DAILY:
                firstPeriod = Math.floor((earliestRelevantDay - startDay) / interval);
                break;
            case RecurrenceFrequency.WEEKLY:
                firstPeriod = Math.floor((earliestRelevantDay - startWeekMonday) / (7 * interval));
                break;
            case RecurrenceFrequency.MONTHLY: {
                const { year, month } = dayNumberToDate(earliestRelevantDay);
                firstPeriod = Math.floor((year * 12 + (month - 1) - startMonthIndex) / interval);
                break;
            }
            default:
                firstPeriod = Math.floor((dayNumberToDate(earliestRelevantDay).year - startLocal.year) / interval);
                break;
        }
        firstPeriod = Math.max(0, firstPeriod - 1);
    }

    const occurrences: OccurrenceWindow[] = [];
    let matchCount = 0;
    let k = firstPeriod;
    for (; k < firstPeriod + MAX_PERIODS; k++) {
        if (periodFirstDay(k) > lastRelevantDay) {
            break;
        }
        for (const day of periodDays(k)) {
            if (day < startDay) {
                continue;
            }
            if (day < earliestRelevantDay && (untilDay === undefined || day < untilDay)) {
                // Only being counted toward COUNT - can't overlap the window and can't be past UNTIL, so skip the
                // zone conversion entirely.
                matchCount++;
                if (count !== undefined && matchCount >= count) {
                    return occurrences;
                }
                continue;
            }
            const candidateStart = toInstant(day);
            if (untilMs !== undefined && candidateStart.getTime() > untilMs) {
                return occurrences;
            }
            matchCount++;
            if (count !== undefined && matchCount > count) {
                return occurrences;
            }
            if (!excluded.has(candidateStart.getTime())) {
                const candidateEnd = new Date(candidateStart.getTime() + durationMs);
                if (occurrenceOverlapsWindow(candidateStart, candidateEnd, windowStart, windowEnd)) {
                    // Truncated only when an occurrence beyond the cap actually exists - exactly `MAX_OCCURRENCES` in the
                    // window is a complete expansion.
                    if (occurrences.length >= MAX_OCCURRENCES) {
                        info.truncated = true;
                        return occurrences;
                    }
                    occurrences.push({ start: candidateStart, end: candidateEnd });
                }
            }
        }
    }
    if (k >= firstPeriod + MAX_PERIODS) {
        info.truncated = true;
    }
    return occurrences;
}
