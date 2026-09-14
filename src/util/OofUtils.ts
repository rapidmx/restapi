///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { CalendarEvent, Mailbox } from "../models/types.js";

/** The resolved outcome of `resolveActiveOof()`: an automatic reply should be sent, using `message`. */
export interface ActiveOof {
    active: true;
    message: string;
}

/**
 * Determines whether `mailbox` is currently "out of office" and, if so, which message to reply with - combining
 * two independent trigger sources without merging them into one record (so neither has to be kept in sync with
 * the other):
 *
 * - `activeEvent`: a `CalendarEvent` (e.g. a vacation) whose own `autoReplyEnabled`/`autoReplyMessage`/
 * [`startDate`, `endDate`] window is currently active - resolved by the caller via a query for a matching
 * event, since this function only combines an already-resolved candidate.
 * - `mailbox.oofEnabled`/`oofMessage`/`oofStartTime`/`oofEndTime` - the mailbox-wide manual toggle (also what
 * EAS's `Settings`/`Oof` command reads and writes).
 *
 * `activeEvent`'s message takes precedence when both are active - it's the more specific, deliberately-
 * configured-for-these-dates signal (e.g. a vacation) over a standing generic toggle.
 *
 * Returns `undefined` if neither source is currently active.
 */
export function resolveActiveOof(mailbox: Mailbox, activeEvent?: CalendarEvent): ActiveOof | undefined {
    if (activeEvent?.autoReplyEnabled) {
        return { active: true, message: activeEvent.autoReplyMessage ?? "" };
    }

    if (mailbox.oofEnabled) {
        if (mailbox.oofStartTime && mailbox.oofEndTime) {
            // Compared as epoch milliseconds: the Mongo backend hands these back as ISO strings despite the `Date`
            // typing, and comparing a `Date` to a string with `<`/`>` is always false. An unparseable bound fails
            // closed (no automatic reply) rather than silently widening the window to "always on".
            const now: number = Date.now();
            const start: number = toEpochMs(mailbox.oofStartTime);
            const end: number = toEpochMs(mailbox.oofEndTime);
            if (Number.isNaN(start) || Number.isNaN(end) || now < start || now > end) {
                return undefined;
            }
        }
        return { active: true, message: mailbox.oofMessage };
    }

    return undefined;
}

function toEpochMs(value: Date | string | number): number {
    return new Date(value).getTime();
}
