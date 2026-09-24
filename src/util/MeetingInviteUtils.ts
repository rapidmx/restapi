///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { simpleParser } from "mailparser";
import { AttendeeResponseStatus, type CalendarEvent, type Message } from "../models/types.js";
import { normalizeAddress } from "./AddressUtils.js";
import { parseIcsEvent, type ParsedIcsEvent } from "./IcsUtils.js";

/** What a reader can answer to an invitation. */
export type InviteResponse = "accepted" | "tentative" | "declined";

export interface InviteParticipant {
    address: string;
    displayName?: string;
    responseStatus?: InviteResponse | "needs-action";
}

/** One event of the reader's own calendar, as the schedule beside an invitation shows it. */
export interface InviteScheduleEntry {
    uid: string;
    title: string;
    startDate: string;
    endDate: string;
    allDay: boolean;
    /** Free time (`busyStatus` free) doesn't conflict with anything. */
    busy: boolean;
    /** The reader hasn't committed to it (`tentative` busy status, or an invitation they haven't answered). */
    tentative: boolean;
}

/**
 * The meeting invitation a message carries, as `GET /calendar-events/invite/:messageUid` reports it - what a mail client's
 * "Accept / Tentative / Decline" card shows and offers. The `can*` flags say which buttons to offer, so a client needn't
 * know iTIP.
 */
export interface MessageInvite {
    /** The iTIP `METHOD` as sent (`REQUEST`, `CANCEL`, `REPLY`, `PUBLISH`), or `""` when the file names none. */
    method: string;
    /** The iCalendar `UID`. */
    uid: string;
    sequence: number;
    summary?: string;
    location?: string;
    startDate?: string;
    endDate?: string;
    allDay: boolean;
    /** The IANA zone the organizer used. */
    timezone?: string;
    organizer?: { address: string; displayName?: string };
    attendees: InviteParticipant[];
    recurring: boolean;
    /** The reader's mailbox is the organizer (their own sent invitation). */
    isOrganizer: boolean;
    /** What the reader answered, if anything. */
    response?: InviteResponse;
    /** An event for it is on the reader's calendar now. */
    onCalendar: boolean;
    /** That event's uid, for a link into the calendar. */
    calendarEventUid?: string;
    /** The calendar already holds a newer revision of the meeting than this message carries. */
    outdated: boolean;
    /** A `REQUEST` the reader can answer. */
    canRespond: boolean;
    /** A `PUBLISH` (or method-less) file the reader can put on their calendar. */
    canAdd: boolean;
    /** A `CANCEL` whose meeting is on the calendar, which the reader can take off it. */
    canRemove: boolean;
    /** A `REQUEST` the reader can answer with "propose a new time" (an iTIP `COUNTER` to the organizer). */
    canPropose: boolean;
    /** A `COUNTER` - an attendee's proposed time - for a meeting the reader organizes, which they can accept. */
    canAcceptProposal: boolean;
    /** For a `REPLY` or `COUNTER`: the attendee who sent it and what they answered. */
    reply?: InviteParticipant;
    /** The reader's own busy events that overlap this invitation's time (not counting the meeting itself), so a client can say "Conflicts with ...". */
    conflicts: InviteScheduleEntry[];
    /** The reader's events around the invitation's time (from 12 hours before it starts to 12 hours after it ends), for a day view beside it. */
    schedule: InviteScheduleEntry[];
}

const RESPONSE_OF_STATUS: Partial<Record<AttendeeResponseStatus, InviteResponse>> = {
    [AttendeeResponseStatus.ACCEPTED]: "accepted",
    [AttendeeResponseStatus.TENTATIVE]: "tentative",
    [AttendeeResponseStatus.DECLINED]: "declined",
};

/** The `InviteResponse` an attendee's status stands for, or `undefined` while they haven't answered. */
export function inviteResponseOf(status: AttendeeResponseStatus | undefined): InviteResponse | undefined {
    return status ? RESPONSE_OF_STATUS[status] : undefined;
}

/** What an attendee's status is called in a `MessageInvite`. */
export function participantStatusOf(status: AttendeeResponseStatus | undefined): InviteParticipant["responseStatus"] {
    return inviteResponseOf(status) ?? (status ? "needs-action" : undefined);
}

/**
 * The `.ics` text of a raw message: its `text/calendar` part or an attachment named `*.ics`, the same one the ingest scan reads
 * (`ScanPipeline.deriveIcsPart()`). `undefined` when there is none or the message can't be parsed.
 */
export async function extractIcsFromRaw(raw: Buffer): Promise<string | undefined> {
    try {
        const parsed = await simpleParser(raw);
        const part = (parsed.attachments ?? []).find(
            (attachment) => attachment.contentType === "text/calendar" || (attachment.filename ?? "").toLowerCase().endsWith(".ics"),
        );
        return part?.content.toString("utf-8");
    } catch {
        return undefined;
    }
}

/**
 * The event in an `.ics` file. An iTIP message names its `METHOD`; a plain calendar file (an exported event) may not, and is read as
 * a `PUBLISH` - RFC 5546's method for "here is an event", which a mail client offers to add to the calendar.
 */
export function parseInviteIcs(ics: string): ParsedIcsEvent | undefined {
    const parsed = parseIcsEvent(ics);
    if (parsed || /^METHOD[:;]/im.test(ics)) {
        return parsed;
    }
    return parseIcsEvent(ics.replace(/BEGIN:VCALENDAR(\r?\n)/i, "BEGIN:VCALENDAR$1METHOD:PUBLISH$1"));
}

/** The iTIP `METHOD` of a message's calendar file (`""` for a file naming none), or `undefined` for a message with none the server can read. */
export function meetingMethodOf(ics: string | undefined): string | undefined {
    const parsed: ParsedIcsEvent | undefined = ics ? parseInviteIcs(ics) : undefined;
    return parsed ? (parsed.method ?? "").toUpperCase() : undefined;
}

/** Whether a message could carry an invitation the server can read: not encrypted (its body is ciphertext to the server). */
export function messageMayCarryInvite(message: Pick<Message, "encrypted">): boolean {
    return !message.encrypted;
}

/**
 * Whether an invitation is for the whole of its days, as a date-only `DTSTART`/`DTEND` parses: no zone, both ends at midnight UTC and a
 * whole number of days apart.
 */
export function inviteIsAllDay(parsed: Pick<ParsedIcsEvent, "startDate" | "endDate" | "timezone">): boolean {
    const { startDate, endDate } = parsed;
    if (parsed.timezone || !startDate || !endDate) {
        return false;
    }
    const day = 24 * 60 * 60 * 1000;
    return startDate.getTime() % day === 0 && endDate.getTime() % day === 0 && endDate.getTime() > startDate.getTime();
}

/** Whether two recurrence ids name the same occurrence (both absent means the series master). */
export function sameRecurrenceId(a: Date | undefined, b: Date | undefined): boolean {
    if (!a || !b) {
        return !a && !b;
    }
    return new Date(a).getTime() === new Date(b).getTime();
}

/** Every address of a mailbox, normalized. */
export function mailboxAddressSet(mailbox: { primarySmtpAddress: string; aliasAddresses?: string[] } | undefined): Set<string> {
    return new Set([mailbox?.primarySmtpAddress, ...(mailbox?.aliasAddresses ?? [])].filter((a): a is string => !!a).map(normalizeAddress));
}

/** The busy entries of `schedule` that overlap `[start, end)`. */
export function conflictsOf(schedule: InviteScheduleEntry[], start: Date | undefined, end: Date | undefined): InviteScheduleEntry[] {
    if (!start) {
        return [];
    }
    const from: number = start.getTime();
    const to: number = Math.max((end ?? start).getTime(), from + 1);
    return schedule.filter((entry) => entry.busy && new Date(entry.startDate).getTime() < to && new Date(entry.endDate).getTime() > from);
}

/**
 * The `MessageInvite` for `parsed`, read by a mailbox whose own addresses are `addresses`, with the calendar row (`existing`) that
 * already stands for it, if any, and what `message` records the reader as having answered.
 */
export function describeInvite(
    parsed: ParsedIcsEvent,
    addresses: Set<string>,
    existing: CalendarEvent | undefined,
    message: Pick<Message, "meetingResponse" | "from">,
    schedule: InviteScheduleEntry[] = [],
): MessageInvite {
    const method: string = (parsed.method ?? "").toUpperCase();
    const organizerAddress: string | undefined = parsed.organizer ? normalizeAddress(parsed.organizer.address) : undefined;
    const isOrganizer: boolean = organizerAddress !== undefined && addresses.has(organizerAddress);
    const mine = existing?.attendees.find((attendee) => addresses.has(normalizeAddress(attendee.address)));
    const response: InviteResponse | undefined = message.meetingResponse ?? inviteResponseOf(mine?.responseStatus);
    const cancelled: boolean = method === "CANCEL" || (parsed.status ?? "").toUpperCase() === "CANCELLED";
    const sender: string | undefined = message.from?.address ? normalizeAddress(message.from.address) : undefined;
    const proposer = method === "COUNTER" ? parsed.attendees.find((attendee) => normalizeAddress(attendee.address) === sender) : undefined;
    const replier = method === "REPLY" || method === "COUNTER" ? (proposer ?? parsed.attendees[0]) : undefined;
    const startDate: Date | undefined = parsed.startDate;
    const endDate: Date | undefined = parsed.endDate;
    return {
        method,
        uid: parsed.uid,
        sequence: parsed.sequence,
        summary: parsed.summary,
        location: parsed.location,
        startDate: startDate?.toISOString(),
        endDate: endDate?.toISOString(),
        allDay: inviteIsAllDay(parsed),
        timezone: parsed.timezone,
        organizer: parsed.organizer,
        attendees: parsed.attendees.map((attendee) => {
            const known = existing?.attendees.find((row) => normalizeAddress(row.address) === normalizeAddress(attendee.address));
            return {
                address: attendee.address,
                displayName: attendee.displayName,
                responseStatus: participantStatusOf(known?.responseStatus ?? attendee.partstat),
            };
        }),
        recurring: !!parsed.recurrenceRule || !!parsed.recurrenceId,
        isOrganizer,
        response,
        onCalendar: !!existing,
        calendarEventUid: existing?.uid,
        outdated: !!existing && existing.sequence > parsed.sequence,
        canRespond: method === "REQUEST" && !isOrganizer && !cancelled,
        canAdd: (method === "PUBLISH" || method === "") && !existing,
        canRemove: method === "CANCEL" && !!existing,
        canPropose: method === "REQUEST" && !isOrganizer && !cancelled && !!parsed.organizer,
        // Only from an attendee the meeting lists, so a stranger's forged proposal can't be applied by one click.
        canAcceptProposal:
            method === "COUNTER" &&
            isOrganizer &&
            !!existing &&
            !!proposer &&
            existing.attendees.some((attendee) => normalizeAddress(attendee.address) === sender),
        reply: replier ? { address: replier.address, displayName: replier.displayName, responseStatus: participantStatusOf(replier.partstat) } : undefined,
        conflicts: conflictsOf(schedule, startDate, endDate),
        schedule,
    };
}
