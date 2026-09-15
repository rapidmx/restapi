///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import {
    ACLAction,
    ApiErrorMessages,
    ApiErrors,
    DocDecorators,
    HttpRequest,
    RepoUtils,
    RouteDecorators,
    type UpdateObject,
} from "@rapidrest/service-core";
import { boundIndexedValue } from "../util/ConversationUtils.js";
import { coerceCalendarEventDates } from "../util/DateCoercionUtils.js";
import { getMailboxUidForFolder } from "../util/FolderUtils.js";
import { buildEventIcs } from "../util/IcsUtils.js";
import { isPlainAddress, safeDisplayName } from "../util/MimeHeaderUtils.js";
import { BaseScopedChildRoute } from "./BaseScopedChildRoute.js";
import { Attendee, AttendeeResponseStatus, CalendarEvent, Mailbox } from "../models/types.js";
const { Inject } = ObjectDecorators;
const { Description, Returns, Summary } = DocDecorators;
const { Param, Post, Request, User: AuthUser } = RouteDecorators;

/** Most attendees an event written through this route may list - the compose cap of mapi and activesync, and
 * `MeetingSchedulingJob`'s default `max_attendees`. */
export const MAX_EVENT_ATTENDEES = 500;

const RESPOND_STATUS_MAP: Record<string, AttendeeResponseStatus> = {
    accepted: AttendeeResponseStatus.ACCEPTED,
    declined: AttendeeResponseStatus.DECLINED,
    tentative: AttendeeResponseStatus.TENTATIVE,
};

/**
 * Extends `BaseScopedChildRoute` (scoped by `folderUid`, same as `Message`) with the two pieces of
 * scheduling-relevant behavior a `CalendarEvent` needs beyond ordinary CRUD:
 *
 * - **Auto-bumped `sequence`**: `update()` is overridden (no new `@Put` decorator needed - method-name
 * dispatch on the class prototype resolves to this override automatically, the same pattern
 * `BaseMailboxRoute` already uses for its own `find()`/`count()` overrides) to increment `sequence`
 * whenever a scheduling-relevant field (`startDate`/`endDate`/`location`/`attendees`/`status`/
 * `recurrenceRule`) actually changes - this is what lets `MeetingSchedulingJob` tell "needs a resend"
 * apart from an unrelated edit (e.g. a private note field, if one is ever added).
 * - **`POST /:id/respond`**: lets an attendee accept/decline/tentatively-respond without needing to
 * receive/parse an iTIP email themselves (most real clients respond via a UI button). Always also sends a
 * real iTIP `REPLY` email to the organizer - even when organizer and attendee share this same server -
 * matching this library's "every mailbox-to-mailbox interaction is a real composed email" convention (see
 * `MeetingSchedulingJob`'s own doc comment). Declining soft-deletes the responder's own event copy rather
 * than just flipping a status flag, matching the exact precedent already implemented in `@rapidmx/
 * activesync`'s `MeetingResponseCommand` for the same underlying data.
 *
 * `mailboxClass` is supplied by the Mongo/SQL concrete subclasses so this class can resolve the responding
 * mailbox's own address(es) without depending on either backend directly.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseCalendarEventRoute<T extends CalendarEvent> extends BaseScopedChildRoute<T> {
    protected readonly scopeProperty: string = "folderUid";

    protected abstract mailboxClass: any;

    /** Bookkeeping only the scheduling/reminder jobs write (`MeetingSchedulingJob`, `CalendarReminderJob`) - a client
     * setting them could suppress invites, cancellation notices or reminders (or trigger them again). Dropped from a
     * non-trusted caller's create/update body by `BaseScopedChildRoute`, so a full-object round trip keeps the stored
     * values. */
    protected readonly serverManagedFields: readonly string[] = ["inviteSequenceSent", "cancelNoticeSentAt", "reminderSentFor"];

    /** The concrete `Folder` entity class, supplied by the Mongo/SQL concrete subclass - used only by
     * `resolveMailboxUidFor()` below. */
    protected abstract folderClass: any;

    private mailboxRepo?: RepoUtils<any>;

    @Inject("MailTransport")
    private mailTransport?: any;

    /** `icalUid` is bounded (`boundIndexedValue()`) for every caller: an update is written as a patch without the model
     * constructor that normally bounds it, and an over-long value would fail the write on MySQL/MariaDB `varchar(255)`. */
    protected async prepareUpdate(obj: any, existing: T, user: JWTUser | undefined): Promise<void> {
        await super.prepareUpdate(obj, existing, user);
        BaseCalendarEventRoute.assertParticipants(obj, existing);
        if (typeof obj.icalUid === "string") {
            obj.icalUid = boundIndexedValue(obj.icalUid);
        }
    }

    /** Refuses (400) an event whose organizer or attendees can't be mailed safely - see `assertParticipants()`. */
    protected async prepareCreate(obj: any, user: JWTUser | undefined): Promise<void> {
        await super.prepareCreate(obj, user);
        BaseCalendarEventRoute.assertParticipants(obj);
    }

    /**
     * For every caller: a written `organizer.address` must be empty or one plain address, and `attendees` an array of at
     * most `MAX_EVENT_ATTENDEES` entries, each with one plain address (`isPlainAddress()`) - `MeetingSchedulingJob` mails
     * them. On an update only a changed value is checked, so an event received with a larger or odder list (an attendee
     * copy `ScanQueueJob` filed) still round-trips unchanged.
     */
    private static assertParticipants(obj: any, existing?: CalendarEvent): void {
        const changed = (field: "organizer" | "attendees"): boolean =>
            obj[field] !== undefined && obj[field] !== null && (!existing || JSON.stringify(obj[field]) !== JSON.stringify((existing as any)[field]));
        if (changed("organizer")) {
            const address: unknown = obj.organizer?.address;
            if (typeof obj.organizer !== "object" || (address !== undefined && address !== "" && !isPlainAddress(address))) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The organizer's address must be one plain email address.");
            }
        }
        if (changed("attendees")) {
            if (!Array.isArray(obj.attendees) || obj.attendees.length > MAX_EVENT_ATTENDEES) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'attendees' must be a list of at most ${MAX_EVENT_ATTENDEES} attendees.`);
            }
            if (!obj.attendees.every((attendee: any) => isPlainAddress(attendee?.address))) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Every attendee's address must be one plain email address.");
            }
        }
    }

    private async getMailboxRepo(): Promise<RepoUtils<any>> {
        if (!this.mailboxRepo) {
            this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.mailboxClass.name,
                args: [this.mailboxClass],
            });
        }
        return this.mailboxRepo;
    }

    /** See `BaseScopedChildRoute.resolveMailboxUidFor()`'s own doc comment - `CalendarEvent` carries its
     * own denormalized `mailboxUid` that must never diverge from its actual folder's mailbox. */
    protected async resolveMailboxUidFor(scopeUid: string): Promise<string | undefined> {
        return getMailboxUidForFolder(this._objectFactory!, this.folderClass, scopeUid);
    }

    /** Coerces every date field to a real `Date` (a `400` for an unparseable one) before anything is saved - see
     * `util/DateCoercionUtils.ts` for why MongoDB would otherwise store the client's ISO strings as strings. */
    public async create(obj: T | T[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T | T[]> {
        for (const single of Array.isArray(obj) ? obj : [obj]) {
            coerceCalendarEventDates(single);
        }
        return await super.create(obj, req, user);
    }

    /** Also serves `updateBulk()`/`updateProperty()`, which `BaseScopedChildRoute` routes through `update()`. */
    public async update(id: string, obj: UpdateObject<T>, req?: HttpRequest, user?: JWTUser): Promise<T> {
        if (!this.repoUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        coerceCalendarEventDates(obj);
        const existing: T | undefined = await this.repoUtils.findOne(id, { ignoreACL: true });
        if (existing && this.isSchedulingRelevantChange(existing, obj)) {
            (obj as any).sequence = existing.sequence + 1;
        }
        return await super.update(id, obj, req, user);
    }

    /** `true` if any of `startDate`/`endDate`/`location`/`attendees`/`status`/`recurrenceRule` in `obj`
     * differs from `existing`'s current value - fields `obj` doesn't touch at all are ignored, matching
     * this route family's ordinary partial-update semantics. */
    private isSchedulingRelevantChange(existing: T, obj: UpdateObject<T>): boolean {
        const incoming: any = obj;
        // `new Date()` on the stored side too - a row saved before dates were coerced on write can hold a string.
        if (incoming.startDate !== undefined && new Date(incoming.startDate).getTime() !== new Date(existing.startDate).getTime()) {
            return true;
        }
        if (incoming.endDate !== undefined && new Date(incoming.endDate).getTime() !== new Date(existing.endDate).getTime()) {
            return true;
        }
        const fields: (keyof CalendarEvent)[] = ["location", "attendees", "status", "recurrenceRule"];
        for (const field of fields) {
            if (incoming[field] !== undefined && JSON.stringify(incoming[field]) !== JSON.stringify((existing as any)[field])) {
                return true;
            }
        }
        return false;
    }

    @Summary("Respond to a meeting invite")
    @Description(
        "Accepts, declines, or tentatively responds to this event as the calling mailbox's own attendee " +
            "entry, and sends a real iTIP REPLY email to the organizer. Declining soft-deletes this mailbox's " +
            "own copy of the event, matching Outlook/Exchange behavior.",
    )
    @Returns([Object])
    @Post("/:id/respond")
    public async respond(
        @Param("id") id: string,
        body: { responseStatus: "accepted" | "declined" | "tentative" },
        @AuthUser user?: JWTUser,
    ): Promise<T | { uid: string }> {
        if (!this.repoUtils || !this.mailTransport) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }

        const event: T | undefined = await this.repoUtils.findOne(id, { ignoreACL: true });
        if (!event) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        if (!(await this.aclUtils!.hasPermission(user, event.folderUid, ACLAction.UPDATE))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }

        const responseStatus = RESPOND_STATUS_MAP[body?.responseStatus];
        if (!responseStatus) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }

        const mailboxRepo = await this.getMailboxRepo();
        const mailbox: Mailbox | undefined = await mailboxRepo.findOne(event.mailboxUid, { ignoreACL: true });
        const mailboxAddresses = mailbox ? [mailbox.primarySmtpAddress, ...mailbox.aliasAddresses].map((a) => a.toLowerCase()) : [];
        const respondingAttendee: Attendee | undefined = event.attendees.find((attendee) =>
            mailboxAddresses.includes(attendee.address.toLowerCase()),
        );
        if (!respondingAttendee) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }

        const updatedAttendee: Attendee = { ...respondingAttendee, responseStatus };
        const ics = buildEventIcs({ ...event, attendees: [updatedAttendee] }, "REPLY", { onlyAttendee: updatedAttendee });

        let result: T | { uid: string };
        if (responseStatus === AttendeeResponseStatus.DECLINED) {
            await this.repoUtils.delete(event.uid, { user, ignoreACL: true });
            result = { uid: event.uid };
        } else {
            const attendees = event.attendees.map((attendee) => (attendee === respondingAttendee ? updatedAttendee : attendee));
            result = await this.repoUtils.update(
                { uid: event.uid, version: (event as any).version, attendees } as any,
                event,
                { user, ignoreACL: true },
            );
        }

        try {
            // The organizer comes from the event (an inbound invite, for an attendee copy): only one plain address is
            // mailed. The mailbox's display name is left out when it's address-like.
            if (!isPlainAddress(event.organizer?.address)) {
                throw new Error("the organizer's address isn't one plain email address");
            }
            const fromName: string | undefined = safeDisplayName(mailbox?.displayName);
            const composed: Buffer = await new MailComposer({
                from: fromName ? { name: fromName, address: respondingAttendee.address } : respondingAttendee.address,
                to: event.organizer.address,
                subject: `${body.responseStatus === "declined" ? "Declined" : body.responseStatus === "tentative" ? "Tentative" : "Accepted"}: ${event.title}`,
                text: `${respondingAttendee.displayName ?? respondingAttendee.address} has responded ${body.responseStatus} to: ${event.title}`,
                icalEvent: { method: "reply", content: ics },
            })
                .compile()
                .build();
            await this.mailTransport.send({ raw: composed, envelopeFrom: respondingAttendee.address, envelopeTo: [event.organizer.address] });
        } catch (err: any) {
            this.logger?.warn(`BaseCalendarEventRoute: failed to send iTIP REPLY for event ${event.uid}: ${err.message}`);
        }

        return result;
    }
}
