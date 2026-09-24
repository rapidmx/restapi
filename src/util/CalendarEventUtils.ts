///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { type CalendarEvent, type EventVisibility, RecipientType } from "../models/types.js";

/**
 * The parts of a calendar event's visibility and guest permissions that more than one place needs: the route that writes and reads
 * events, the scheduling job that mails them, the inbound iTIP processing and the invitation card. Everything here treats a missing
 * or `null` value (a row written before these fields existed, a SQL `NULL`) as the field's default, so no caller reads the raw column.
 *
 * @author Jean-Philippe Steinmetz
 */

/** Most attendees an event written through the calendar route - or changed by an inbound change request - may list: the compose cap of mapi and activesync, and `MeetingSchedulingJob`'s default `max_attendees`. */
export const MAX_EVENT_ATTENDEES = 500;

/** Most guests one change request may ask to add. */
export const MAX_REQUESTED_GUESTS = 50;

/** Every value of `CalendarEvent.visibility`. */
export const EVENT_VISIBILITIES: readonly EventVisibility[] = ["default", "public", "private", "confidential"];

/** The title a reader who may not see an event's details is shown in its place. */
export const BUSY_TITLE = "Busy";

/** The guest permissions of an event (see `CalendarEvent.guestsCanModify` and its two siblings). */
export interface GuestPermissions {
    guestsCanModify: boolean;
    guestsCanInviteOthers: boolean;
    guestsCanSeeGuestList: boolean;
}

/** What an event allows its guests when nothing says otherwise. */
export const DEFAULT_GUEST_PERMISSIONS: Readonly<GuestPermissions> = { guestsCanModify: false, guestsCanInviteOthers: true, guestsCanSeeGuestList: true };

/** The names of the three guest-permission fields. */
export const GUEST_PERMISSION_FIELDS: readonly (keyof GuestPermissions)[] = ["guestsCanModify", "guestsCanInviteOthers", "guestsCanSeeGuestList"];

/** `event`'s visibility, `"default"` for a row that has none (or an unrecognized value). */
export function effectiveVisibility(event: { visibility?: unknown } | undefined): EventVisibility {
    const value: unknown = event?.visibility;
    return EVENT_VISIBILITIES.includes(value as EventVisibility) ? (value as EventVisibility) : "default";
}

/** `event`'s guest permissions, each falling back to `DEFAULT_GUEST_PERMISSIONS` when the row has no boolean for it. */
export function guestPermissionsOf(event: Partial<Record<keyof GuestPermissions, unknown>> | undefined): GuestPermissions {
    const pick = (field: keyof GuestPermissions): boolean =>
        typeof event?.[field] === "boolean" ? (event[field]) : DEFAULT_GUEST_PERMISSIONS[field];
    return { guestsCanModify: pick("guestsCanModify"), guestsCanInviteOthers: pick("guestsCanInviteOthers"), guestsCanSeeGuestList: pick("guestsCanSeeGuestList") };
}

/** Whether `event`'s details are for the owner and delegates only (`"private"` or `"confidential"`). */
export function hidesDetailsFromReaders(event: { visibility?: unknown } | undefined): boolean {
    const visibility: EventVisibility = effectiveVisibility(event);
    return visibility === "private" || visibility === "confidential";
}

/**
 * A copy of `event` as a reader who may not see its details is shown it - a busy block: same time, recurrence, status and busy status
 * (so the block lands where it should and a series still expands), but the title is `BUSY_TITLE` and the location, description,
 * attendees, organizer, video meeting, reminder, automatic reply and scheduling bookkeeping are removed; `redacted` is `true`.
 * `event` itself is not modified (it may be a cached entity). An event that doesn't hide its details is returned as it is.
 */
export function redactEventForReader<E extends Partial<CalendarEvent>>(event: E): E {
    if (!hidesDetailsFromReaders(event)) {
        return event;
    }
    const copy: any = Object.assign(Object.create(Object.getPrototypeOf(event)), event);
    for (const field of [
        "location",
        "description",
        "descriptionHtml",
        "videoMeetingUid",
        "reminderMinutesBeforeStart",
        "autoReplyEnabled",
        "autoReplyMessage",
        "inviteSequenceSent",
        "cancelNoticeSentAt",
        "reminderSentFor",
        ...GUEST_PERMISSION_FIELDS,
    ]) {
        delete copy[field];
    }
    copy.title = BUSY_TITLE;
    copy.attendees = [];
    copy.organizer = { address: "", type: RecipientType.TO };
    copy.redacted = true;
    return copy;
}

/** The fields whose value a reader who may not see private events' details could learn by filtering or sorting on them. */
const DETAIL_FIELDS: readonly string[] = [
    "title",
    "location",
    "description",
    "descriptionHtml",
    "attendees",
    "organizer",
    "videoMeetingUid",
    "reminderMinutesBeforeStart",
    "autoReplyEnabled",
    "autoReplyMessage",
];

/** Whether a list `query` filters or sorts by a field holding an event's details (`title`, `location`, `description`, `attendees` ...). */
export function queryNamesEventDetails(query: any): boolean {
    const names: Set<string> = new Set(Object.keys(query ?? {}).map((key: string) => key.split(".")[0]));
    for (const word of query?.sort === undefined ? [] : (JSON.stringify(query.sort).match(/[A-Za-z_]+/g) ?? [])) {
        names.add(word);
    }
    return DETAIL_FIELDS.some((field: string) => names.has(field));
}

/**
 * The `400` for a list query that `queryNamesEventDetails()` reports, asked of a reader who may not see private events' details: a
 * filter such as `title=like(salary)` would otherwise tell them which busy blocks hide such a title - the block would come back as
 * `Busy`, but being in the result is the answer.
 */
export function eventDetailQueryError(): ApiError {
    return new ApiError(ApiErrors.INVALID_REQUEST, 400, "This calendar can't be filtered or sorted by an event's title, location, description or guests.");
}

const invalid = (message: string): ApiError => new ApiError(ApiErrors.INVALID_REQUEST, 400, message);

/**
 * Validates the `visibility` and guest-permission fields of a create/update body in place: a value that is not one of
 * `EVENT_VISIBILITIES` (or not a boolean, for the three flags) is a `400`; a `null` or absent one is removed from the body, so it
 * neither clears nor changes what is stored (and a full object read back from SQL, which holds `null` for a legacy row, is accepted).
 */
export function validateEventPolicyFields(obj: any): void {
    if ("visibility" in obj) {
        if (obj.visibility === null || obj.visibility === undefined) {
            delete obj.visibility;
        } else if (!EVENT_VISIBILITIES.includes(obj.visibility)) {
            throw invalid(`'visibility' must be one of ${EVENT_VISIBILITIES.join(", ")}.`);
        }
    }
    for (const field of GUEST_PERMISSION_FIELDS) {
        if (field in obj) {
            if (obj[field] === null || obj[field] === undefined) {
                delete obj[field];
            } else if (typeof obj[field] !== "boolean") {
                throw invalid(`'${field}' must be true or false.`);
            }
        }
    }
}
