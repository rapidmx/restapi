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
    ModelUtils,
    RepoUtils,
    RouteDecorators,
    type UpdateObject,
} from "@rapidrest/service-core";
import { asEntity } from "../util/EntityUtils.js";
import { boundIndexedValue } from "../util/ConversationUtils.js";
import { coerceCalendarEventDates } from "../util/DateCoercionUtils.js";
import { findOrCreateWellKnownFolder, getMailboxUidForFolder } from "../util/FolderUtils.js";
import { buildEventIcs, expandOccurrences, type ParsedIcsEvent } from "../util/IcsUtils.js";
import {
    describeInvite,
    type InviteScheduleEntry,
    extractIcsFromRaw,
    inviteIsAllDay,
    mailboxAddressSet,
    messageMayCarryInvite,
    parseInviteIcs,
    sameRecurrenceId,
    type InviteResponse,
    type MessageInvite,
} from "../util/MeetingInviteUtils.js";
import { normalizeAddress } from "../util/AddressUtils.js";
import {
    MAX_EVENT_ATTENDEES,
    MAX_REQUESTED_GUESTS,
    effectiveVisibility,
    eventDetailQueryError,
    guestPermissionsOf,
    hidesDetailsFromReaders,
    queryNamesEventDetails,
    redactEventForReader,
    validateEventPolicyFields,
    GUEST_PERMISSION_FIELDS,
} from "../util/CalendarEventUtils.js";
import { normalizeEventDescription } from "../util/EventDescriptionUtils.js";
import {
    FREE_BUSY_MAX_ATTEMPTS,
    FREE_BUSY_WINDOW_SECONDS,
    lookupFreeBusy,
    parseFreeBusyRequest,
    type FreeBusyResponse,
} from "../util/FreeBusyLookupUtils.js";
import { isPlainAddress, safeDisplayName } from "../util/MimeHeaderUtils.js";
import { nameBasedUuid } from "../util/UuidUtils.js";
import { BlobStore } from "../blob/BlobStore.js";
import { BaseScopedChildRoute } from "./BaseScopedChildRoute.js";
import {
    Attendee,
    AttendeeResponseStatus,
    AttendeeRole,
    BusyStatus,
    CalendarEvent,
    CalendarEventStatus,
    FolderType,
    Mailbox,
    RecipientType,
} from "../models/types.js";
const { Inject } = ObjectDecorators;
const { Description, Returns, Summary } = DocDecorators;
const { Auth, Get, Param, Post, RateLimit, Request, User: AuthUser } = RouteDecorators;

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
 * - **The event dialog's fields**: a write's `description`/`descriptionHtml` are sanitized and reconciled
 * (`normalizeEventDescription()`), `visibility` and the guest permissions validated, all with a `400` for nonsense; a change of any
 * of them bumps `sequence` (they travel in the invitation). `find()`/`findById()` show a `private`/`confidential` event to a reader who
 * isn't the owner or a delegate with `UPDATE` only as a busy block (`redactReadRecords()`), and such a reader can't filter or sort by
 * the hidden fields (`assertQueryAllowed()`). An edit of the guest permissions on a copy the mailbox doesn't organize is ignored.
 * - **`POST /:id/request-change`** (`requestChange()`): a guest's request to the organizer to change the event or add guests, as
 * the event's guest permissions allow.
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

    /** The concrete `Message` entity class, supplied by the Mongo/SQL concrete subclass - the invitation endpoints read a
     * message's calendar file and record the reader's answer on it. */
    protected abstract messageClass: any;

    private mailboxRepo?: RepoUtils<any>;
    private messageRepo?: RepoUtils<any>;
    private folderRepo?: RepoUtils<any>;

    @Inject("MailTransport")
    private mailTransport?: any;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    /** `icalUid` is bounded (`boundIndexedValue()`) for every caller: an update is written as a patch without the model
     * constructor that normally bounds it, and an over-long value would fail the write on MySQL/MariaDB `varchar(255)`. */
    protected async prepareUpdate(obj: any, existing: T, user: JWTUser | undefined): Promise<void> {
        await super.prepareUpdate(obj, existing, user);
        BaseCalendarEventRoute.assertParticipants(obj, existing);
        if (typeof obj.icalUid === "string") {
            obj.icalUid = boundIndexedValue(obj.icalUid);
        }
        BaseCalendarEventRoute.normalizeDescriptionAndPolicy(obj, true);
        if (GUEST_PERMISSION_FIELDS.some((field) => field in obj) && !(await this.isOrganizedByOwner(existing))) {
            // An attendee's copy holds the permissions the organizer sent: an edit of them on a copy the mailbox doesn't organize is
            // ignored (not refused, so a full object read back and written again still works).
            for (const field of GUEST_PERMISSION_FIELDS) {
                delete obj[field];
            }
        }
        if (BaseCalendarEventRoute.changesInvitation(obj, existing) && !(typeof obj.sequence === "number" && obj.sequence > existing.sequence)) {
            // The description, visibility and guest permissions travel in the invitation, so changing one is a scheduling-relevant change.
            obj.sequence = existing.sequence + 1;
        }
    }

    /** Refuses (400) an event whose organizer or attendees can't be mailed safely - see `assertParticipants()` - and a bad description, visibility or guest permission. */
    protected async prepareCreate(obj: any, user: JWTUser | undefined): Promise<void> {
        await super.prepareCreate(obj, user);
        BaseCalendarEventRoute.assertParticipants(obj);
        BaseCalendarEventRoute.normalizeDescriptionAndPolicy(obj, false);
    }

    /**
     * Validates and normalizes the fields an event dialog adds, in a create/update body: the description (`normalizeEventDescription()` -
     * the HTML is sanitized whatever the client sent, the plain text derived from it when only the HTML was written, a value over its bound
     * a `400`), `visibility` and the three guest-permission flags (`validateEventPolicyFields()`), and `redacted` is dropped (a response-only
     * marker). On a create a field cleared by `null` is left out; on an update it is written as `null`.
     */
    private static normalizeDescriptionAndPolicy(obj: any, update: boolean): void {
        delete obj.redacted;
        validateEventPolicyFields(obj);
        const decision = normalizeEventDescription({ description: obj.description, descriptionHtml: obj.descriptionHtml });
        for (const field of ["description", "descriptionHtml"] as const) {
            if (field in decision && (update || decision[field] !== null)) {
                obj[field] = decision[field];
            } else {
                delete obj[field];
            }
        }
    }

    /** Whether the update `obj` changes something that travels in the invitation but isn't among `isSchedulingRelevantChange()`'s fields. */
    private static changesInvitation(obj: any, existing: CalendarEvent): boolean {
        const before = guestPermissionsOf(existing);
        return (
            ("description" in obj && (obj.description ?? null) !== (existing.description ?? null)) ||
            ("descriptionHtml" in obj && (obj.descriptionHtml ?? null) !== (existing.descriptionHtml ?? null)) ||
            ("visibility" in obj && obj.visibility !== effectiveVisibility(existing)) ||
            GUEST_PERMISSION_FIELDS.some((field) => field in obj && obj[field] !== before[field])
        );
    }

    /** Whether `existing` is an event this mailbox organizes: it names no organizer (a plain personal event) or one of the mailbox's own addresses. */
    private async isOrganizedByOwner(existing: CalendarEvent): Promise<boolean> {
        const organizer: string = normalizeAddress(existing.organizer?.address ?? "");
        if (!organizer) {
            return true;
        }
        const mailbox: Mailbox | undefined = await (await this.getMailboxRepo()).findOne(existing.mailboxUid, { ignoreACL: true });
        return mailboxAddressSet(mailbox).has(organizer);
    }

    /** Whether `user` may read every event of the calendar `folderUid` in full: owner, or a delegate with `UPDATE` - see `redactReadRecords()`. */
    private seesEventDetails(user: JWTUser | undefined, folderUid: string): Promise<boolean> {
        return this.hasMailAccess(user, folderUid, ACLAction.UPDATE);
    }

    /** A reader who may not see events' details can't filter or sort by them either (see `eventDetailQueryError()`). */
    protected async assertQueryAllowed(query: any, scopeUid: string, effectiveUser: JWTUser | undefined): Promise<void> {
        if (queryNamesEventDetails(query) && !(await this.seesEventDetails(effectiveUser, scopeUid))) {
            throw eventDetailQueryError();
        }
    }

    /**
     * A reader of the calendar who is not its owner or a delegate with `UPDATE` (a shared-calendar grantee with only `read`/`list`, or a
     * share-link holder) sees a `private` or `confidential` event only as a busy block - `redactEventForReader()`. Applies to `find()` and
     * `findById()`; the owner and delegates with `UPDATE` see every event in full.
     */
    protected async redactReadRecords(records: T[], scopeUid: string, effectiveUser: JWTUser | undefined): Promise<T[]> {
        if (!records.some((record) => hidesDetailsFromReaders(record)) || (await this.seesEventDetails(effectiveUser, scopeUid))) {
            return records;
        }
        return records.map((record) => redactEventForReader(record));
    }

    /**
     * A live-update notification of a private or confidential event carries the busy block (`redactEventForReader()`, `redacted: true`):
     * every subscriber of the calendar's channel - a read-only shared-calendar grantee included - receives the same payload, so it can
     * hold nothing they may not read. The owner's client refetches an event whose notification says `redacted`.
     */
    protected pushPayload(data: any): any {
        return redactEventForReader(data);
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

    private async getMessageRepo(): Promise<RepoUtils<any>> {
        this.messageRepo ??= await this._objectFactory!.newInstance(RepoUtils, { name: this.messageClass.name, args: [this.messageClass] });
        return this.messageRepo;
    }

    private async getFolderRepo(): Promise<RepoUtils<any>> {
        this.folderRepo ??= await this._objectFactory!.newInstance(RepoUtils, { name: this.folderClass.name, args: [this.folderClass] });
        return this.folderRepo;
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

    /** The query value matching one element of `Mailbox.aliasAddresses` (`BaseMailboxAccessRoute.aliasQueryValue()`'s Mongo/SQL split -
     * `CalendarEventRouteSQL` overrides it for the serialized `simple-json` column). */
    protected aliasQueryValue(address: string): any {
        return ModelUtils.literal(address);
    }

    @Summary("Find a time: other people's busy windows")
    @Description(
        "For up to 50 local mailbox addresses, the windows over start..end (at most 31 days) in which each is busy - " +
            "never titles, locations or attendees. Each mailbox's owner chooses who may see it (`Mailbox.freeBusyVisibility`): " +
            "`available` carries the busy windows, `restricted` is a mailbox that does not share with the caller (`unknown` " +
            "to a caller who owns no mailbox here), `unknown` is an address that is not a local mailbox or a calendar too large " +
            "to compute. Tentative events and unanswered invitations are marked `tentative`; what the owner declined is left out.",
    )
    @Returns([Object])
    @Auth(["jwt"])
    @RateLimit({ perUser: true, maxAttempts: FREE_BUSY_MAX_ATTEMPTS, windowSeconds: FREE_BUSY_WINDOW_SECONDS })
    @Post("/free-busy")
    public async freeBusy(body: { addresses: string[]; start: string; end: string }, @AuthUser user?: JWTUser): Promise<FreeBusyResponse> {
        const request = parseFreeBusyRequest(body);
        return await lookupFreeBusy(
            {
                caller: user!,
                isTrusted: this.isTrusted(user),
                mailboxRepo: await this.getMailboxRepo(),
                folderRepo: await this.getFolderRepo(),
                eventRepo: this.repoUtils!,
                aliasQueryValue: (address) => this.aliasQueryValue(address),
                hasAccess: (uid, action) => this.hasMailAccess(user, uid, action),
            },
            request,
        );
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
        if (!(await this.hasMailAccess(user, event.folderUid, ACLAction.UPDATE))) {
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

        await this.sendItipReply(event, mailbox, respondingAttendee, body.responseStatus, ics);

        return result;
    }

    /**
     * Mails the organizer of `event` the iTIP `REPLY` (`ics`) for `responder`'s answer. Best effort: a failure is logged and never
     * undoes the answer already recorded. The organizer comes from the event (an inbound invite, for an attendee copy): only one plain
     * address is mailed. The mailbox's display name is left out when it's address-like.
     */
    private async sendItipReply(
        event: Pick<CalendarEvent, "uid" | "title" | "organizer">,
        mailbox: Mailbox | undefined,
        responder: Attendee,
        answer: "accepted" | "declined" | "tentative",
        ics: string,
    ): Promise<void> {
        await this.sendItipMail(
            event,
            mailbox,
            responder,
            `${answer === "declined" ? "Declined" : answer === "tentative" ? "Tentative" : "Accepted"}: ${event.title}`,
            `${responder.displayName ?? responder.address} has responded ${answer} to: ${event.title}`,
            "reply",
            ics,
        );
    }

    /** Mails the organizer of `event` an iTIP message (`ics`, whose method is `method`) from `responder`. Best effort - see `sendItipReply()`. */
    private async sendItipMail(
        event: Pick<CalendarEvent, "uid" | "title" | "organizer">,
        mailbox: Mailbox | undefined,
        responder: Attendee,
        subject: string,
        text: string,
        method: "reply" | "counter",
        ics: string,
    ): Promise<boolean> {
        try {
            if (!isPlainAddress(event.organizer?.address)) {
                throw new Error("the organizer's address isn't one plain email address");
            }
            const fromName: string | undefined = safeDisplayName(mailbox?.displayName);
            const composed: Buffer = await new MailComposer({
                from: fromName ? { name: fromName, address: responder.address } : responder.address,
                to: event.organizer.address,
                subject,
                text,
                icalEvent: { method, content: ics },
            })
                .compile()
                .build();
            await this.mailTransport.send({ raw: composed, envelopeFrom: responder.address, envelopeTo: [event.organizer.address] });
            return true;
        } catch (err: any) {
            this.logger?.warn(`BaseCalendarEventRoute: failed to send iTIP ${method.toUpperCase()} for event ${event.uid}: ${err.message}`);
            return false;
        }
    }

    /**
     * Asks the organizer to change an event the caller is a guest of, as Google Calendar's "guests can modify the event" / "invite others"
     * permissions allow: mails the organizer an iTIP `COUNTER` (`buildEventIcs(..., "COUNTER", { changeRequest: true })`, the requester as the
     * one `ATTENDEE`, tentative, then any guests asked for) carrying the proposed values and `X-RAPIDMX-CHANGE-REQUEST:TRUE`, plus a
     * plain-text note saying what is asked. **Nothing changes on the caller's calendar** - the organizer's change arrives as an ordinary
     * `REQUEST` - and when the organizer's mailbox is a RapidMX one, `ScanQueueJob` applies the request itself if the organizer's own
     * permission flags allow it (otherwise it stays a proposal the organizer can accept, `POST /invite/:messageUid/accept-proposal`).
     *
     * The caller must be able to update their own copy (`UPDATE` on its calendar), be a listed guest and not the organizer (`400`). The flags
     * of *their copy* say what to allow here (`403` with the reason): a change of the title, location, description or time needs
     * `guestsCanModify`, guests to add need `guestsCanInviteOthers`. The body's values are validated as a create would (`400`): `title` and
     * `location` non-empty strings of at most 1000 characters (a request can set them, not clear them), the description as for a write
     * (`description`/`descriptionHtml`, sanitized), `startDate`/`endDate` ISO 8601 with the end after the start (either may be given alone),
     * `addAttendees` at most `MAX_REQUESTED_GUESTS` entries of one plain `address` and an optional `displayName`. A value equal to what the
     * event has isn't a change; a request that changes nothing is a `400`. The id is the caller's own row, so a series master (whole series)
     * or one occurrence's override row can be changed exactly as `respond()` addresses them; a bare occurrence of a series has no row of its
     * own and can't be. `502` when the mail can't be sent.
     */
    @Summary("Ask the organizer to change an event")
    @Description(
        "Mails the organizer an iTIP COUNTER carrying the requested title, location, description, time and added guests, if the event's " +
            "guest permissions allow the caller to ask; nothing changes on the caller's own calendar.",
    )
    @Returns([Object])
    @Post("/:id/request-change")
    public async requestChange(
        @Param("id") id: string,
        body: {
            title?: string;
            location?: string;
            description?: string;
            descriptionHtml?: string;
            startDate?: string;
            endDate?: string;
            addAttendees?: { address: string; displayName?: string }[];
        } | undefined,
        @AuthUser user?: JWTUser,
    ): Promise<{ requested: true; changes: string[]; addAttendees: { address: string; displayName?: string }[] }> {
        if (!this.repoUtils || !this.mailTransport) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const event: T | undefined = await this.repoUtils.findOne(id, { ignoreACL: true });
        if (!event) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        if (!(await this.hasMailAccess(user, event.folderUid, ACLAction.UPDATE))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        const invalid = (message: string): ApiError => new ApiError(ApiErrors.INVALID_REQUEST, 400, message);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw invalid(ApiErrorMessages.INVALID_REQUEST);
        }

        const mailbox: Mailbox | undefined = await (await this.getMailboxRepo()).findOne(event.mailboxUid, { ignoreACL: true });
        const addresses: Set<string> = mailboxAddressSet(mailbox);
        const guest: Attendee | undefined = event.attendees.find((attendee) => addresses.has(normalizeAddress(attendee.address)));
        if (!guest || guest.isOrganizer || addresses.has(normalizeAddress(event.organizer?.address ?? ""))) {
            throw invalid(guest ? "You organize this event: change it directly." : "You are not a guest of this event.");
        }

        // What is asked, validated: each `undefined` is "not asked".
        const stringField = (name: "title" | "location"): string | undefined => {
            const value: unknown = body[name];
            if (value === undefined) {
                return undefined;
            }
            if (typeof value !== "string" || value.trim() === "" || value.trim().length > 1000) {
                throw invalid(`'${name}' must be a non-empty string of at most 1000 characters.`);
            }
            return value.trim();
        };
        const title: string | undefined = stringField("title");
        const location: string | undefined = stringField("location");
        const description = normalizeEventDescription({ description: body.description, descriptionHtml: body.descriptionHtml });
        if (description.description === null && "descriptionHtml" in description && description.descriptionHtml === null) {
            throw invalid("A change request can't clear the description.");
        }
        const date = (name: "startDate" | "endDate"): Date | undefined => {
            if (body[name] === undefined) {
                return undefined;
            }
            const value: Date = new Date(body[name]);
            if (typeof body[name] !== "string" || Number.isNaN(value.getTime())) {
                throw invalid(`'${name}' must be an ISO 8601 date/time.`);
            }
            return value;
        };
        const startDate: Date = date("startDate") ?? new Date(event.startDate);
        const endDate: Date = date("endDate") ?? new Date(event.endDate);
        if (endDate.getTime() <= startDate.getTime()) {
            throw invalid("'endDate' must be after 'startDate'.");
        }
        const asked: unknown = body.addAttendees;
        if (asked !== undefined && (!Array.isArray(asked) || asked.length > MAX_REQUESTED_GUESTS)) {
            throw invalid(`'addAttendees' must be a list of at most ${MAX_REQUESTED_GUESTS} guests.`);
        }
        const known: Set<string> = new Set([...event.attendees.map((attendee) => normalizeAddress(attendee.address)), normalizeAddress(event.organizer?.address ?? "")]);
        const added: Attendee[] = [];
        for (const entry of (asked as { address: string; displayName?: string }[] | undefined) ?? []) {
            if (!entry || typeof entry !== "object" || !isPlainAddress(entry.address)) {
                throw invalid("Every guest to add must have one plain email address.");
            }
            if (!known.has(normalizeAddress(entry.address))) {
                known.add(normalizeAddress(entry.address));
                added.push({
                    address: entry.address,
                    displayName: safeDisplayName(typeof entry.displayName === "string" ? entry.displayName : undefined),
                    role: AttendeeRole.REQUIRED,
                    responseStatus: AttendeeResponseStatus.NEEDS_ACTION,
                    isOrganizer: false,
                });
            }
        }
        if (event.attendees.length + added.length > MAX_EVENT_ATTENDEES) {
            throw invalid(`The event can have at most ${MAX_EVENT_ATTENDEES} guests.`);
        }

        // What actually differs from the event, and so what needs the organizer's permission.
        const changes: string[] = [];
        if (title !== undefined && title !== event.title) {
            changes.push("title");
        }
        if (location !== undefined && location !== event.location) {
            changes.push("location");
        }
        if (
            description.description !== undefined &&
            ((description.description ?? null) !== (event.description ?? null) || (description.descriptionHtml ?? null) !== (event.descriptionHtml ?? null))
        ) {
            changes.push("description");
        }
        if (startDate.getTime() !== new Date(event.startDate).getTime() || endDate.getTime() !== new Date(event.endDate).getTime()) {
            changes.push("time");
        }
        if (changes.length === 0 && added.length === 0) {
            throw invalid("Nothing to change.");
        }
        const permissions = guestPermissionsOf(event);
        if (changes.length > 0 && !permissions.guestsCanModify) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, "The organizer doesn't allow guests to change this event.");
        }
        if (added.length > 0 && !permissions.guestsCanInviteOthers) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, "The organizer doesn't allow guests to invite others.");
        }

        const proposer: Attendee = { ...guest, responseStatus: AttendeeResponseStatus.TENTATIVE };
        const proposed: CalendarEvent = {
            ...event,
            // The title is always named (the organizer's card shows it); the location only when it is asked to change - a guest's own copy
            // may hold a link of their own (`CalendarEventAttendeeLink`) that must never be mistaken for a request.
            title: title ?? event.title,
            location: changes.includes("location") ? location : undefined,
            description: changes.includes("description") ? (description.description ?? undefined) : undefined,
            descriptionHtml: changes.includes("description") ? (description.descriptionHtml ?? undefined) : undefined,
            startDate,
            endDate,
        };
        const lines: string[] = [
            ...changes.map((change) => `- ${change === "time" ? `time: ${startDate.toUTCString()} - ${endDate.toUTCString()}` : change === "title" ? `title: ${title}` : change === "location" ? `location: ${location}` : "description"}`),
            ...added.map((entry) => `- add guest: ${entry.displayName ? `${entry.displayName} <${entry.address}>` : entry.address}`),
        ];
        const note: string = `${proposer.displayName ?? proposer.address} asked to change: ${event.title}\n\n${lines.join("\n")}`;
        const sent: boolean = await this.sendItipMail(
            event,
            mailbox,
            proposer,
            `Change requested: ${event.title}`,
            note,
            "counter",
            buildEventIcs(proposed, "COUNTER", { onlyAttendee: proposer, changeRequest: true, extraAttendees: added }),
        );
        if (!sent) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 502, "The request couldn't be sent to the organizer.");
        }
        return { requested: true, changes, addAttendees: added.map((entry) => ({ address: entry.address, displayName: entry.displayName })) };
    }

    // ---- The meeting invitation in a message (what a mail client's Accept / Tentative / Decline card is built from) ----

    /**
     * The invitation a message carries, for the mailbox that received it. The message's calendar file is read from its stored raw
     * message (a `text/calendar` part or an `.ics` attachment - the one the ingest scan reads), so nothing here trusts what a client
     * says the invitation is. `404` when the message has none, can't be read (an encrypted body is ciphertext to the server), or the
     * caller can't see it. A meeting on the calendar already, or a decision the reader made, is folded in - see `MessageInvite`.
     */
    @Summary("Read the meeting invitation in a message")
    @Description(
        "Reports the calendar invitation a message carries - what it is, who organized it, whether it is on the caller's calendar " +
            "and what they answered - and which of Accept/Tentative/Decline, Add to calendar or Remove from calendar apply.",
    )
    @Returns([Object])
    @Get("/invite/:messageUid")
    public async getInvite(@Param("messageUid") messageUid: string, @AuthUser user?: JWTUser): Promise<MessageInvite> {
        const context = await this.loadInvite(messageUid, user, ACLAction.READ);
        return await this.describe(context);
    }

    /**
     * Answers the invitation in a message as the mailbox that received it, as a mail client's Accept / Tentative / Decline does:
     *
     * **Accepted / tentative**: the meeting is put on the calendar (from the message's own calendar file, at the deterministic uid
     * inbound processing uses, so the two never make two copies) or, if it is there already, the reader's answer on it is updated;
     * an iTIP `REPLY` is mailed to the organizer. **Declined**: nothing is put on the calendar - a copy already there is removed -
     * and the `REPLY` is mailed all the same.
     *
     * The answer is remembered on the message (`Message.meetingResponse`), so a decline, which leaves nothing on the calendar, is still
     * shown as one. A `PUBLISH` (or method-less) file can only be added (`accepted`, no reply - there is no one to answer). Answering
     * your own invitation, a cancellation or a reply is a `400`. Returns the invitation as `getInvite()` then reports it.
     */
    @Summary("Answer the meeting invitation in a message")
    @Description(
        "Accepts, tentatively accepts or declines the calendar invitation a message carries: accepting puts the meeting on the " +
            "calendar, declining does not (and removes it if it was there), and an iTIP REPLY is mailed to the organizer either way.",
    )
    @Returns([Object])
    @Post("/invite/:messageUid/respond")
    public async respondToInvite(
        @Param("messageUid") messageUid: string,
        body: { responseStatus?: InviteResponse } | undefined,
        @AuthUser user?: JWTUser,
    ): Promise<MessageInvite> {
        const context = await this.loadInvite(messageUid, user, ACLAction.UPDATE);
        const answer: InviteResponse | undefined = body?.responseStatus;
        const status: AttendeeResponseStatus | undefined = answer ? RESPOND_STATUS_MAP[answer] : undefined;
        if (!answer || !status) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'responseStatus' must be accepted, tentative or declined.");
        }
        const view: MessageInvite = await this.describe(context);
        const adding: boolean = view.canAdd && answer === "accepted";
        if (!view.canRespond && !adding) {
            throw new ApiError(
                ApiErrors.INVALID_REQUEST,
                400,
                view.isOrganizer ? "You organized this meeting." : "This message's calendar file isn't an invitation that can be answered.",
            );
        }

        const { parsed, mailbox, message } = context;
        const listed = parsed.attendees.find((attendee) => context.addresses.has(normalizeAddress(attendee.address)));
        const responder: Attendee = {
            address: listed?.address ?? mailbox.primarySmtpAddress,
            displayName: listed?.displayName ?? safeDisplayName(mailbox.displayName),
            role: AttendeeRole.REQUIRED,
            responseStatus: status,
            isOrganizer: false,
        };

        if (status === AttendeeResponseStatus.DECLINED) {
            if (context.existing) {
                await this.repoUtils!.delete(context.existing.uid, { user, ignoreACL: true });
            }
        } else {
            await this.putInviteOnCalendar(context, responder, user);
        }

        if (view.method === "REQUEST" && parsed.organizer) {
            const event = this.eventFromInvite(parsed, [responder], mailbox.uid);
            const ics: string = buildEventIcs(event, "REPLY", { onlyAttendee: responder });
            await this.sendItipReply(event, mailbox, responder, answer, ics);
        }

        await this.recordInviteAnswer(message, answer);
        message.meetingResponse = answer;
        const remaining = await this.findInviteRow(mailbox.uid, parsed);
        return await this.describe(context, { existing: remaining, message });
    }

    /**
     * Takes the meeting of a cancellation (`METHOD:CANCEL`) off the calendar, as Outlook's "Remove from Calendar" does. Nothing is mailed:
     * a cancellation isn't answered. `400` for any other kind of message.
     */
    @Summary("Remove a cancelled meeting from the calendar")
    @Description("Deletes the caller's calendar copy of the meeting a cancellation message names.")
    @Returns([Object])
    @Post("/invite/:messageUid/remove")
    public async removeInvite(@Param("messageUid") messageUid: string, @AuthUser user?: JWTUser): Promise<MessageInvite> {
        const context = await this.loadInvite(messageUid, user, ACLAction.UPDATE);
        const view: MessageInvite = await this.describe(context);
        if (!view.canRemove || !context.existing) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "This message isn't a cancellation of a meeting on your calendar.");
        }
        await this.repoUtils!.delete(context.existing.uid, { user, ignoreACL: true });
        return await this.describe(context, { existing: undefined });
    }

    /**
     * Proposes another time for the meeting in a message, as Outlook's "Propose New Time" does: mails the organizer an iTIP `COUNTER`
     * (with the attendee as the proposer, tentative, and the proposed start and end) and a plain-text note carrying the optional comment.
     * Nothing changes on the caller's calendar - the organizer decides. `400` unless the message is an invitation the reader can answer.
     */
    @Summary("Propose a new time for the meeting in a message")
    @Description("Mails the organizer an iTIP COUNTER proposing another start and end for the meeting; the caller's calendar is unchanged.")
    @Returns([Object])
    @Post("/invite/:messageUid/propose")
    public async proposeNewTime(
        @Param("messageUid") messageUid: string,
        body: { startDate?: string; endDate?: string; comment?: string } | undefined,
        @AuthUser user?: JWTUser,
    ): Promise<MessageInvite> {
        const context = await this.loadInvite(messageUid, user, ACLAction.UPDATE);
        const view: MessageInvite = await this.describe(context);
        if (!view.canPropose) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "This message isn't an invitation you can propose another time for.");
        }
        const startDate: Date = new Date(body?.startDate ?? "");
        const endDate: Date = new Date(body?.endDate ?? "");
        if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate.getTime() <= startDate.getTime()) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'startDate' and 'endDate' must be ISO 8601 date/times, the end after the start.");
        }
        const { parsed, mailbox } = context;
        const listed = parsed.attendees.find((attendee) => context.addresses.has(normalizeAddress(attendee.address)));
        const proposer: Attendee = {
            address: listed?.address ?? mailbox.primarySmtpAddress,
            displayName: listed?.displayName ?? safeDisplayName(mailbox.displayName),
            role: AttendeeRole.REQUIRED,
            responseStatus: AttendeeResponseStatus.TENTATIVE,
            isOrganizer: false,
        };
        const event: CalendarEvent = { ...this.eventFromInvite(parsed, [proposer], mailbox.uid), startDate, endDate, allDay: false };
        const comment: string = String(body?.comment ?? "")
            // eslint-disable-next-line no-control-regex
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
            .trim()
            .slice(0, 2000);
        const text: string =
            `${proposer.displayName ?? proposer.address} proposed a new time for: ${event.title}\n\n` +
            `Proposed: ${startDate.toUTCString()} - ${endDate.toUTCString()}` +
            (comment ? `\n\n${comment}` : "");
        await this.sendItipMail(event, mailbox, proposer, `New Time Proposed: ${event.title}`, text, "counter", buildEventIcs(event, "COUNTER", { onlyAttendee: proposer }));
        return view;
    }

    /**
     * Accepts an attendee's proposed time (a `COUNTER` message) for a meeting the reader organizes: moves the meeting to the proposed start and
     * end, bumps its `SEQUENCE` - so the scheduling job mails every attendee the updated invitation - and resets the other attendees' answers,
     * since they answered another time. The proposer is marked accepted. `400` unless `canAcceptProposal`.
     */
    @Summary("Accept a proposed new time")
    @Description("Moves the meeting to the time an attendee proposed (an iTIP COUNTER) and re-invites the attendees.")
    @Returns([Object])
    @Post("/invite/:messageUid/accept-proposal")
    public async acceptProposal(@Param("messageUid") messageUid: string, @AuthUser user?: JWTUser): Promise<MessageInvite> {
        const context = await this.loadInvite(messageUid, user, ACLAction.UPDATE);
        const view: MessageInvite = await this.describe(context);
        const existing: CalendarEvent | undefined = context.existing;
        if (!view.canAcceptProposal || !existing || !context.parsed.startDate || !context.parsed.endDate) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "This message isn't a proposed time for a meeting you organize.");
        }
        const proposer: string = normalizeAddress(view.reply!.address);
        const patch: any = {
            uid: existing.uid,
            version: (existing as any).version,
            startDate: context.parsed.startDate,
            endDate: context.parsed.endDate,
            sequence: existing.sequence + 1,
            attendees: existing.attendees.map((attendee) =>
                normalizeAddress(attendee.address) === proposer
                    ? { ...attendee, responseStatus: AttendeeResponseStatus.ACCEPTED }
                    : attendee.isOrganizer
                      ? attendee
                      : { ...attendee, responseStatus: AttendeeResponseStatus.NEEDS_ACTION },
            ),
        };
        const updated: CalendarEvent = await this.repoUtils!.update(patch, existing as any, { user, ignoreACL: true });
        await this.recordInviteAnswer(context.message, "accepted");
        context.message.meetingResponse = "accepted";
        return await this.describe(context, { existing: updated });
    }

    /** The `MessageInvite` for `context`, with the schedule around it read from the mailbox's calendar. `overrides` replaces the calendar row or message it describes. */
    private async describe(context: InviteContext, overrides?: { existing?: CalendarEvent | undefined; message?: any }): Promise<MessageInvite> {
        const existing: CalendarEvent | undefined = overrides && "existing" in overrides ? overrides.existing : context.existing;
        const schedule: InviteScheduleEntry[] = await this.loadSchedule(context.mailbox, context.parsed, context.addresses);
        return describeInvite(context.parsed, context.addresses, existing, overrides?.message ?? context.message, schedule);
    }

    /**
     * The reader's own events from 12 hours before the invitation starts to 12 hours after it ends, recurring series expanded, without the
     * meeting itself. Bounded reads (200 rows each of what overlaps the window and of the recurring masters): a mailbox with more than that
     * gets a partial schedule, never a failure - it only decorates the card.
     */
    private async loadSchedule(mailbox: Mailbox, parsed: ParsedIcsEvent, addresses: Set<string>): Promise<InviteScheduleEntry[]> {
        if (!parsed.startDate) {
            return [];
        }
        const HOUR: number = 60 * 60 * 1000;
        const windowStart: Date = new Date(parsed.startDate.getTime() - 12 * HOUR);
        const windowEnd: Date = new Date((parsed.endDate ?? parsed.startDate).getTime() + 12 * HOUR);
        const own: string = boundIndexedValue(parsed.uid);
        try {
            const overlapping: CalendarEvent[] = await this.repoUtils!.find(
                { mailboxUid: mailbox.uid, startDate: `lt(${windowEnd.toISOString()})`, endDate: `gt(${windowStart.toISOString()})`, limit: 200 } as any,
                { ignoreACL: true, limit: 200 },
            );
            const masters: CalendarEvent[] = await this.repoUtils!.find({ mailboxUid: mailbox.uid, recurrenceRule: "ne(null)", limit: 200 } as any, {
                ignoreACL: true,
                limit: 200,
            });
            const rows: Map<string, CalendarEvent> = new Map();
            for (const row of [...overlapping, ...masters.filter((row) => !row.recurrenceId)]) {
                rows.set(row.uid, row);
            }
            const entries: InviteScheduleEntry[] = [];
            for (const row of rows.values()) {
                if (row.icalUid === own || row.status === CalendarEventStatus.CANCELLED) {
                    continue;
                }
                const isMaster: boolean = !!row.recurrenceRule && !row.recurrenceId;
                const exclude: Date[] | undefined = isMaster
                    ? [
                          ...(row.recurrenceRule?.exceptions ?? []),
                          ...[...rows.values()].filter((other) => other.icalUid === row.icalUid && other.recurrenceId).map((other) => other.recurrenceId!),
                      ]
                    : undefined;
                const mine = row.attendees?.find((attendee) => addresses.has(normalizeAddress(attendee.address)));
                for (const occurrence of expandOccurrences(
                    { startDate: row.startDate, endDate: row.endDate, recurrenceRule: row.recurrenceRule, timezone: row.timezone, allDay: row.allDay },
                    windowStart,
                    windowEnd,
                    exclude,
                )) {
                    entries.push({
                        uid: row.uid,
                        title: row.title ?? "",
                        startDate: occurrence.start.toISOString(),
                        endDate: occurrence.end.toISOString(),
                        allDay: !!row.allDay,
                        busy: row.busyStatus !== BusyStatus.FREE && mine?.responseStatus !== AttendeeResponseStatus.DECLINED,
                        tentative: row.busyStatus === BusyStatus.TENTATIVE || mine?.responseStatus === AttendeeResponseStatus.NEEDS_ACTION || mine?.responseStatus === AttendeeResponseStatus.TENTATIVE,
                    });
                }
            }
            return entries.sort((a, b) => a.startDate.localeCompare(b.startDate)).slice(0, 200);
        } catch (err: any) {
            this.logger?.warn(`BaseCalendarEventRoute: couldn't read the schedule around invitation ${parsed.uid}: ${err.message}`);
            return [];
        }
    }

    /** What the invitation endpoints work from: the message, its mailbox, the calendar file's event and the calendar row that already stands for it. */
    private async loadInvite(messageUid: string, user: JWTUser | undefined, action: string): Promise<InviteContext> {
        if (!this.repoUtils || !this.blobStore) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const message: any = await (await this.getMessageRepo()).findOne(messageUid, { ignoreACL: true });
        if (!message) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        if (!(await this.hasMailAccess(user, message.folderUid, action))) {
            // Reading what isn't yours is as good as not finding it; writing to it is refused.
            throw action === ACLAction.READ
                ? new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND)
                : new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        const noInvite = (): ApiError => new ApiError(ApiErrors.NOT_FOUND, 404, "This message has no calendar invitation the server can read.");
        if (!messageMayCarryInvite(message) || !message.bodyBlobKey) {
            throw noInvite();
        }
        let raw: Buffer;
        try {
            raw = await this.blobStore.get(message.bodyBlobKey);
        } catch {
            throw noInvite();
        }
        const ics: string | undefined = await extractIcsFromRaw(raw);
        const parsed: ParsedIcsEvent | undefined = ics ? parseInviteIcs(ics) : undefined;
        if (!parsed) {
            throw noInvite();
        }
        const mailbox: Mailbox | undefined = await (await this.getMailboxRepo()).findOne(message.mailboxUid, { ignoreACL: true });
        if (!mailbox) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        return { message, mailbox, parsed, addresses: mailboxAddressSet(mailbox), existing: await this.findInviteRow(mailbox.uid, parsed) };
    }

    /** The mailbox's calendar row for this invitation's own occurrence (or the series, for no `RECURRENCE-ID`), if it has one. The `UID` is a
     * sender's value and is matched as a literal, exactly: a value like `ne(x)` would otherwise be read as a query operator. */
    private async findInviteRow(mailboxUid: string, parsed: ParsedIcsEvent): Promise<CalendarEvent | undefined> {
        const key: string = boundIndexedValue(parsed.uid);
        const rows: T[] = await this.repoUtils!.find({ mailboxUid, icalUid: ModelUtils.literal(key), limit: 50 } as any, { ignoreACL: true, limit: 50 });
        return rows.filter((row) => row.icalUid === key).find((row) => sameRecurrenceId(row.recurrenceId, parsed.recurrenceId));
    }

    /** A calendar-event value for `parsed` - the calendar row to create from it, or the event an iTIP reply is built for. */
    private eventFromInvite(parsed: ParsedIcsEvent, attendees: Attendee[], mailboxUid: string): CalendarEvent {
        const start: Date = parsed.startDate ?? new Date();
        return {
            mailboxUid,
            title: parsed.summary ?? "",
            location: parsed.location,
            description: parsed.description,
            descriptionHtml: parsed.descriptionHtml,
            visibility: parsed.visibility ?? "default",
            guestsCanModify: parsed.guestsCanModify ?? false,
            guestsCanInviteOthers: parsed.guestsCanInviteOthers ?? true,
            guestsCanSeeGuestList: parsed.guestsCanSeeGuestList ?? true,
            startDate: start,
            endDate: parsed.endDate ?? start,
            allDay: inviteIsAllDay(parsed),
            timezone: parsed.timezone ?? "UTC",
            organizer: parsed.organizer
                ? { address: parsed.organizer.address, displayName: parsed.organizer.displayName, type: RecipientType.TO }
                : { address: "", type: RecipientType.TO },
            attendees,
            recurrenceRule: parsed.recurrenceRule,
            recurrenceId: parsed.recurrenceId,
            status: CalendarEventStatus.CONFIRMED,
            busyStatus: BusyStatus.BUSY,
            icalUid: parsed.uid,
            sequence: parsed.sequence,
        } as unknown as CalendarEvent;
    }

    /** Puts the invitation on the mailbox's calendar with `responder` as the reader's answer, or updates the answer on the copy that is there. */
    private async putInviteOnCalendar(context: InviteContext, responder: Attendee, user: JWTUser | undefined): Promise<void> {
        const { parsed, mailbox, addresses } = context;
        const withAnswer = (attendees: Attendee[]): Attendee[] => {
            const present = attendees.some((attendee) => addresses.has(normalizeAddress(attendee.address)));
            return present
                ? attendees.map((attendee) => (addresses.has(normalizeAddress(attendee.address)) ? { ...attendee, responseStatus: responder.responseStatus } : attendee))
                : [...attendees, responder];
        };
        const busyStatus: BusyStatus = responder.responseStatus === AttendeeResponseStatus.TENTATIVE ? BusyStatus.TENTATIVE : BusyStatus.BUSY;

        for (let attempt = 1; ; attempt++) {
            const existing: CalendarEvent | undefined = attempt === 1 ? context.existing : await this.findInviteRow(mailbox.uid, parsed);
            if (existing) {
                const newer: boolean = parsed.sequence > existing.sequence;
                const patch: any = {
                    uid: existing.uid,
                    version: (existing as any).version,
                    attendees: withAnswer(existing.attendees),
                    busyStatus,
                    ...(newer
                        ? {
                              title: parsed.summary ?? existing.title,
                              location: parsed.location,
                              description: parsed.description ?? null,
                              descriptionHtml: parsed.descriptionHtml ?? null,
                              visibility: parsed.visibility ?? "default",
                              guestsCanModify: parsed.guestsCanModify ?? false,
                              guestsCanInviteOthers: parsed.guestsCanInviteOthers ?? true,
                              guestsCanSeeGuestList: parsed.guestsCanSeeGuestList ?? true,
                              startDate: parsed.startDate ?? existing.startDate,
                              endDate: parsed.endDate ?? existing.endDate,
                              recurrenceRule: parsed.recurrenceRule ?? existing.recurrenceRule,
                              sequence: parsed.sequence,
                              inviteSequenceSent: parsed.sequence,
                          }
                        : {}),
                };
                try {
                    await this.repoUtils!.update(patch, existing as any, { user, ignoreACL: true });
                    return;
                } catch (err: any) {
                    if (attempt >= 3 || err?.status !== 409) {
                        throw err;
                    }
                    continue;
                }
            }

            const folder = await findOrCreateWellKnownFolder(await this.getFolderRepo(), this.folderClass, mailbox.uid, FolderType.CALENDAR);
            // An organizer who hides the guest list names only this guest; anything more in the file is not kept.
            const invited = parsed.guestsCanSeeGuestList === false ? parsed.attendees.filter((attendee) => addresses.has(normalizeAddress(attendee.address))) : parsed.attendees;
            const attendees: Attendee[] = withAnswer(
                invited.map((attendee) => ({
                    address: attendee.address,
                    displayName: attendee.displayName,
                    role: AttendeeRole.REQUIRED,
                    responseStatus: attendee.partstat ?? AttendeeResponseStatus.NEEDS_ACTION,
                    isOrganizer: false,
                })),
            );
            const Entity = this.modelClass;
            try {
                await this.repoUtils!.create(
                    new Entity({
                        ...this.eventFromInvite(parsed, attendees, mailbox.uid),
                        // The uid inbound processing (`ScanQueueJob`) derives for the same invitation, so the two can't make two copies.
                        uid: nameBasedUuid(`itip:${mailbox.uid}:${parsed.uid}:${parsed.recurrenceId ? parsed.recurrenceId.toISOString() : "master"}`),
                        folderUid: folder.uid,
                        busyStatus,
                        // Somebody else's invitation: marked as already sent, so the scheduling job never mails it again as though this mailbox organized it.
                        inviteSequenceSent: parsed.sequence,
                    }),
                    { user, ignoreACL: true },
                );
                return;
            } catch (err: any) {
                // Inbound processing filed its copy between the lookup and here: answer on that one.
                if (attempt >= 3 || err?.status !== 409) {
                    throw err;
                }
            }
        }
    }

    /** Remembers the reader's answer on the message, retrying once on a version conflict. A failure is logged: the answer itself already stands. */
    private async recordInviteAnswer(message: any, answer: InviteResponse): Promise<void> {
        const repo: RepoUtils<any> = await this.getMessageRepo();
        try {
            for (let attempt = 1; ; attempt++) {
                const current: any = attempt === 1 ? message : await repo.findOne(message.uid, { ignoreACL: true });
                if (!current) {
                    return;
                }
                try {
                    await repo.update({ uid: current.uid, version: current.version, meetingResponse: answer } as any, asEntity(repo, current), { ignoreACL: true });
                    return;
                } catch (err: any) {
                    if (attempt >= 2 || err?.status !== 409) {
                        throw err;
                    }
                }
            }
        } catch (err: any) {
            this.logger?.warn(`BaseCalendarEventRoute: couldn't record the answer to the invitation in message ${message.uid}: ${err.message}`);
        }
    }
}

/** What the invitation endpoints read from a message and its mailbox. */
interface InviteContext {
    message: any;
    mailbox: Mailbox;
    parsed: ParsedIcsEvent;
    addresses: Set<string>;
    existing: CalendarEvent | undefined;
}
