///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { CalendarEvent, CalendarEventStatus, BusyStatus } from "../models/types.js";
import { expandOccurrences, type OccurrenceWindow } from "./IcsUtils.js";

/**
 * Collapses a set of `CalendarEvent` rows into the concrete `[start, end)` windows during which their owner is
 * actually busy, over `[windowStart, windowEnd]`. A pure function of its arguments - the caller does all the
 * I/O - matching the `MailFilterUtils`/`TransportRuleUtils`/`FocusedInboxUtils` shape used everywhere else in
 * this library.
 *
 * This is the same conflict-detection core `ScanQueueJob.decideResourceBooking()` performs inline for resource
 * mailbox auto-accept, lifted out so anonymous appointment booking can reuse it. Two pieces of it are subtle
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
 * Note the DST caveat inherited from `expandOccurrences()`, which is documented as UTC-only and DST-naive: a
 * recurring busy block whose series crosses a daylight-saving transition expands at a fixed UTC offset from its
 * series start, so its occurrences after the transition are an hour off local wall-clock time. That affects
 * recurring busy blocks only, not the one-off events the overwhelming majority of bookings collide with.
 *
 * @param events The candidate events to consider. Rows outside the window contribute nothing.
 * @param windowStart The inclusive start of the window of interest.
 * @param windowEnd The exclusive end of the window of interest.
 */
export function computeBusyWindows(events: CalendarEvent[], windowStart: Date, windowEnd: Date): OccurrenceWindow[] {
    const busy: OccurrenceWindow[] = [];

    for (const event of events) {
        if (event.status === CalendarEventStatus.CANCELLED || event.busyStatus === BusyStatus.FREE) {
            continue;
        }

        const isMaster: boolean = !!event.recurrenceRule && !event.recurrenceId;
        const excludeDates: Date[] | undefined = isMaster
            ? [
                  ...(event.recurrenceRule?.exceptions ?? []),
                  ...events
                      .filter((sibling) => sibling.icalUid === event.icalUid && sibling.recurrenceId)
                      .map((sibling) => sibling.recurrenceId!),
              ]
            : undefined;

        busy.push(
            ...expandOccurrences(
                { startDate: event.startDate, endDate: event.endDate, recurrenceRule: event.recurrenceRule },
                windowStart,
                windowEnd,
                excludeDates,
            ),
        );
    }

    return busy;
}
