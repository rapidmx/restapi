///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AttendeeResponseStatus, CalendarEvent, CalendarEventStatus, BusyStatus } from "../models/types.js";
import { normalizeAddress } from "./AddressUtils.js";
import { expandOccurrences, type OccurrenceWindow } from "./IcsUtils.js";

/** One `[start, end)` window during which someone is busy: `tentative` when every event covering it is only tentatively so. */
export interface BusyInterval extends OccurrenceWindow {
    tentative: boolean;
}

/**
 * Collapses a set of `CalendarEvent` rows into the concrete `[start, end)` windows during which their owner is
 * actually busy, over `[windowStart, windowEnd]`. A pure function of its arguments - the caller does all the
 * I/O - matching the `MailFilterUtils`/`TransportRuleUtils`/`FocusedInboxUtils` shape used everywhere else in
 * this library.
 *
 * This is the same conflict-detection core `ScanQueueJob.decideResourceBooking()` performs inline for resource
 * mailbox auto-accept, lifted out so other callers (such as `@rapidmx/booking-plugin`'s anonymous appointment
 * booking) can reuse it. Two pieces of it are subtle
 * and are preserved here deliberately:
 *
 * First, every row is run through `expandOccurrences()` individually, so a recurring series contributes every
 * one of its occurrences in the window rather than only its first instance.
 *
 * Second, for a *master* row (one with a `recurrenceRule` and no `recurrenceId` of its own), the exclusion list
 * is its own `recurrenceRule.exceptions` PLUS the `recurrenceId` of every sibling override row in `events`.
 * Without the second half, a master would phantom-generate an occurrence at its original time even though a
 * real override row already represents that occurrence at its actual, possibly different, time - which would
 * report busy time that does not exist.
 *
 * Two filters are applied here that `decideResourceBooking()` does not have: a `CANCELLED` event and a
 * `busyStatus: FREE` event are both skipped, since neither actually occupies the owner's time. That method is
 * deliberately left calling its own existing code - changing shipped resource-booking behavior is not a side
 * effect this belongs to.
 *
 * Each row's own `timezone` and `allDay` are passed through to `expandOccurrences()`, so a recurring busy block
 * steps in its own local wall-clock time and keeps its local time of day across a daylight-saving transition.
 *
 * `computeBusyWindows()` reports the windows only; `computeBusyIntervals()` below also says which are tentative and
 * skips what the owner declined.
 *
 * @param events The candidate events to consider. Rows outside the window contribute nothing.
 * @param windowStart The inclusive start of the window of interest.
 * @param windowEnd The exclusive end of the window of interest.
 */
export function computeBusyWindows(events: CalendarEvent[], windowStart: Date, windowEnd: Date): OccurrenceWindow[] {
    return computeBusyIntervals(events, windowStart, windowEnd).map(({ start, end }) => ({ start, end }));
}

/**
 * `computeBusyWindows()` with what a "Find a time" view needs on top: every window says whether it is `tentative`, and
 * events the owner has said no to are left out.
 *
 * `ownerAddresses` (normalized - see `mailboxAddressSet()`) are the addresses the calendar's owner is invited as: an
 * attendee copy of an event carries the owner's own answer on the attendee entry with one of them. An event whose owner
 * `DECLINED` is skipped - it no longer occupies their time - and one they haven't answered (`NEEDS_ACTION`) or only
 * answered `TENTATIVE` is tentative, as is any event whose `busyStatus` is `TENTATIVE`. The owner's answer is ignored for
 * an event they organize, which they never answer. Without `ownerAddresses` only `busyStatus` decides.
 *
 * The windows are the individual occurrences, not merged and not clipped to `[windowStart, windowEnd]` - see
 * `mergeBusyIntervals()`.
 */
export function computeBusyIntervals(
    events: CalendarEvent[],
    windowStart: Date,
    windowEnd: Date,
    ownerAddresses?: ReadonlySet<string>,
): BusyInterval[] {
    const busy: BusyInterval[] = [];

    for (const event of events) {
        if (event.status === CalendarEventStatus.CANCELLED || event.busyStatus === BusyStatus.FREE) {
            continue;
        }
        const answer: AttendeeResponseStatus | undefined = ownersAnswer(event, ownerAddresses);
        if (answer === AttendeeResponseStatus.DECLINED) {
            continue;
        }
        const tentative: boolean =
            event.busyStatus === BusyStatus.TENTATIVE ||
            answer === AttendeeResponseStatus.NEEDS_ACTION ||
            answer === AttendeeResponseStatus.TENTATIVE;

        const isMaster: boolean = !!event.recurrenceRule && !event.recurrenceId;
        const excludeDates: Date[] | undefined = isMaster
            ? [
                  ...(event.recurrenceRule?.exceptions ?? []),
                  ...events
                      .filter((sibling) => sibling.icalUid === event.icalUid && sibling.recurrenceId)
                      .map((sibling) => sibling.recurrenceId!),
              ]
            : undefined;

        for (const occurrence of expandOccurrences(
            {
                startDate: event.startDate,
                endDate: event.endDate,
                recurrenceRule: event.recurrenceRule,
                timezone: event.timezone,
                allDay: event.allDay,
            },
            windowStart,
            windowEnd,
            excludeDates,
        )) {
            busy.push({ start: occurrence.start, end: occurrence.end, tentative });
        }
    }

    return busy;
}

/** The answer the owner (any of `ownerAddresses`) gave to `event`, or `undefined` when they are not an invitee or organize it. */
function ownersAnswer(event: CalendarEvent, ownerAddresses: ReadonlySet<string> | undefined): AttendeeResponseStatus | undefined {
    if (!ownerAddresses || ownerAddresses.size === 0) {
        return undefined;
    }
    if (event.organizer?.address && ownerAddresses.has(normalizeAddress(event.organizer.address))) {
        return undefined;
    }
    const mine = event.attendees?.find((attendee) => ownerAddresses.has(normalizeAddress(attendee.address)));
    return mine && !mine.isOrganizer ? mine.responseStatus : undefined;
}

/**
 * Sorted, non-overlapping windows from `intervals`, clipped to `[windowStart, windowEnd]`, with touching or overlapping
 * windows of the same kind joined. Where a firm and a tentative window overlap the overlap is firm, so the result never
 * reports someone tentatively free while another event has them busy. Empty (or negative) windows are dropped.
 */
export function mergeBusyIntervals(intervals: BusyInterval[], windowStart: Date, windowEnd: Date): BusyInterval[] {
    const from: number = windowStart.getTime();
    const to: number = windowEnd.getTime();
    // Every window edge: +1 opens a window of its kind, -1 closes it.
    const edges: { at: number; tentative: boolean; delta: 1 | -1 }[] = [];
    for (const interval of intervals) {
        const start: number = Math.max(interval.start.getTime(), from);
        const end: number = Math.min(interval.end.getTime(), to);
        if (end > start) {
            edges.push({ at: start, tentative: interval.tentative, delta: 1 }, { at: end, tentative: interval.tentative, delta: -1 });
        }
    }
    edges.sort((a, b) => a.at - b.at);

    const merged: BusyInterval[] = [];
    let firm: number = 0;
    let soft: number = 0;
    for (let i = 0; i < edges.length; i++) {
        const edge = edges[i];
        if (edge.tentative) {
            soft += edge.delta;
        } else {
            firm += edge.delta;
        }
        // Something is still open after this edge, so there is always a later one to close it.
        const next: number = i + 1 < edges.length ? edges[i + 1].at : edge.at;
        if ((firm > 0 || soft > 0) && next > edge.at) {
            const tentative: boolean = firm === 0;
            const last: BusyInterval | undefined = merged[merged.length - 1];
            if (last && last.tentative === tentative && last.end.getTime() === edge.at) {
                last.end = new Date(next);
            } else {
                merged.push({ start: new Date(edge.at), end: new Date(next), tentative });
            }
        }
    }
    return merged;
}
