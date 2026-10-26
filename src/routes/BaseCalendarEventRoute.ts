///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { PROTECTED_SUBJECT, sealEventFields } from "../zeroaccess/ZeroAccessSealer.js";
import { zeroAccessTargetFor, type ZeroAccessTarget } from "../zeroaccess/ZeroAccessResolver.js";
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
import { CorrespondentUtils, eventObservations } from "../util/CorrespondentUtils.js";
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
import { addressDomainOf, normalizeAddress, stripPlusTag } from "../util/AddressUtils.js";
import { DomainUtils } from "../util/DomainUtils.js";
import {
    BUSY_TITLE,
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
import { computeBusyIntervals, mergeBusyIntervals } from "../util/FreeBusyUtils.js";
import {
    FREE_BUSY_MAX_ATTEMPTS,
    FREE_BUSY_WINDOW_SECONDS,
    lookupFreeBusy,
    freeBusyCalendarFolders,
    parseFreeBusyRequest,
    type FreeBusyResponse,
} from "../util/FreeBusyLookupUtils.js";
import { isPlainAddress, safeDisplayName, verifiedFromAddress } from "../util/MimeHeaderUtils.js";
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
    SealedEventContent,
    RecipientType,
} from "../models/types.js";
import { hasSealedFields, isSealedEvent } from "../zeroaccess/ZeroAccessFieldSealer.js";
import { ZeroAccessRouteSealing } from "../zeroaccess/ZeroAccessRouteSealing.js";
import { type InvitationContent, invitationsPending, MeetingInviteSender, type MeetingLinkSecrets, meetingLinkSecretsOf } from "../scheduling/MeetingInviteSender.js";
const { Config, Init, Inject } = ObjectDecorators;
const { Description, Returns, Summary } = DocDecorators;
const { Auth, Get, Param, Post, RateLimit, Request, User: AuthUser } = RouteDecorators;

/** The routes that mail an iTIP message (a reply, a change request, a proposal) are limited per user, so one account can't use them to send bulk mail. */
const ITIP_MAIL_MAX_ATTEMPTS: number = 120;
const ITIP_MAIL_WINDOW_SECONDS: number = 3600;

const RESPOND_STATUS_MAP: Record<string, AttendeeResponseStatus> = {
    accepted: AttendeeResponseStatus.ACCEPTED,
    declined: AttendeeResponseStatus.DECLINED,
    tentative: AttendeeResponseStatus.TENTATIVE,
};

/** The status `answer` names - only an own key of `RESPOND_STATUS_MAP` (`constructor`/`toString`/`__proto__` name none). */
function respondStatusOf(answer: unknown): AttendeeResponseStatus | undefined {
    return typeof answer === "string" && Object.prototype.hasOwnProperty.call(RESPOND_STATUS_MAP, answer) ? RESPOND_STATUS_MAP[answer] : undefined;
}

/** The calendar file a client sends for an invitation in a zero-access message (see `BaseCalendarEventRoute.loadInvite()`). */
export interface InviteSource {
    ics?: string;
}

/** What a reply or change request names an event by when its content is sealed and the request didn't send it (`withInvitationContent()`). */
const UNNAMED_EVENT: string = "Meeting invitation";

/** The longest calendar file a client may send for a zero-access invitation. */
const MAX_CLIENT_ICS_LENGTH: number = 1024 * 1024;

/** The content fields an event made from a zero-access mailbox's invitation keeps only sealed. */
const SEALED_EVENT_FIELDS: readonly string[] = ["title", "location", "description", "descriptionHtml"];

/** Per update body (`prepareUpdate()` to `update()`, in memory for the request only): the content an event still held readable when the
 * update sealed it, which its invitations are composed with when the request sent no `invitationContent`. */
const READABLE_CONTENT: WeakMap<object, InvitationContent> = new WeakMap();

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
     * values. `zeroAccessBackfillError` is `ZeroAccessBackfillJob`'s. */
    protected readonly serverManagedFields: readonly string[] = [
        "inviteSequenceSent",
        "cancelNoticeSentAt",
        "reminderSentFor",
        "startAlarmSentFor",
        "zeroAccessBackfillError",
    ];

    /** The concrete `Folder` entity class, supplied by the Mongo/SQL concrete subclass - used only by
     * `resolveMailboxUidFor()` below. */
    protected abstract folderClass: any;

    /** The concrete `Correspondent` entity class, supplied by the Mongo/SQL concrete subclass - the organizer and attendees of
     * every event saved through `create()`/`update()` are recorded into it, for recipient suggestions. */
    protected abstract correspondentClass: any;

    /** The concrete `Message` entity class, supplied by the Mongo/SQL concrete subclass - the invitation endpoints read a
     * message's calendar file and record the reader's answer on it. */
    protected abstract messageClass: any;

    protected mailboxRepo?: RepoUtils<any>;
    protected messageRepo?: RepoUtils<any>;
    protected folderRepo?: RepoUtils<any>;
    /** The backend's `EncryptionPolicy` model, for zero-access sealing of events (`ZeroAccessRouteSealing`). */
    protected encryptionPolicyClass?: any;
    protected sealing?: ZeroAccessRouteSealing;
    /** Sends the invitations of a protected event at save time (`sendProtectedInvitations()`). */
    protected inviteSender?: MeetingInviteSender;
    /** The backend's `CalendarEventAttendeeLink` model: invitations sent at save time carry each attendee's own video link too. */
    protected attendeeLinkClass?: any;
    protected attendeeLinkRepo?: RepoUtils<any>;
    /** The backend's `Domain` model: which addresses are this server's, for what an invitation may carry (`mayCarryMeetingKey()`). */
    protected domainClass?: any;
    protected domainUtils?: DomainUtils;
    protected correspondentRepo?: RepoUtils<any>;
    protected correspondentUtils?: CorrespondentUtils;

    @Inject("MailTransport")
    private mailTransport?: any;

    /** The `authserv-id` of the MTA's own `Authentication-Results` header (`mail:security:trusted_authserv_id`): what makes a message's sender
     * verified (`acceptProposal()`). Empty: nothing is. */
    @Config("mail:security:trusted_authserv_id", "")
    private trustedAuthservId: string = "";

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    /** `icalUid` is bounded (`boundIndexedValue()`) for every caller: an update is written as a patch without the model
     * constructor that normally bounds it, and an over-long value would fail the write on MySQL/MariaDB `varchar(255)`. */
    protected async prepareUpdate(obj: any, existing: T, user: JWTUser | undefined): Promise<void> {
        await super.prepareUpdate(obj, existing, user);
        BaseCalendarEventRoute.assertParticipants(obj, existing);
        // Before `keepSealed()` would seal again to the key of the mailbox the event is leaving.
        ZeroAccessRouteSealing.refuseSealedMove(obj, existing);
        // Before `keepSealed()` too, as on a create: what it seals (and composes the revision's invitations from) is the checked, bounded
        // and sanitized description, never the request's own.
        BaseCalendarEventRoute.normalizeDescriptionAndPolicy(obj, true);
        await this.keepSealedFromClient(obj, existing, false);
        if (typeof obj.icalUid === "string") {
            obj.icalUid = boundIndexedValue(obj.icalUid);
        }
        // A request's invitation content is for composing invitations only, never stored (`takeInvitationContent()`).
        delete obj.invitationContent;
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
        // Sealed last, once everything above has read the plaintext. An event made from a zero-access invitation keeps its own sealing
        // (`keepSealed()`, one sealed blob).
        if (!(existing as any).sealedContent) {
            if (!hasSealedFields(existing)) {
                // Still readable (the backfill hadn't reached it, or it moved here): if this write is its first protected one, its
                // invitations are composed from what it held, since the client had nothing sealed to send `invitationContent` for.
                const readable = BaseCalendarEventRoute.takeInvitationContent(
                    { invitationContent: Object.fromEntries(SEALED_EVENT_FIELDS.map((field) => [field, field in obj ? obj[field] : (existing as any)[field]])) },
                    false,
                );
                if (readable) {
                    READABLE_CONTENT.set(obj, readable);
                }
            }
            await this.sealing?.seal(obj, existing);
        }
        // Read by field sealing alone (`ZeroAccessRouteSealing.takeClearedFields()`), never stored.
        delete obj.clearedFields;
    }

    /**
     * An event made from an invitation that reached a zero-access mailbox keeps its title, location and description only sealed
     * (`CalendarEvent.sealedContent`, `specs/search.md` §4). An edit of them - the reader's own, decrypted client-side and sent back in the
     * request - is sealed again to the same zero-access key, and the row keeps the placeholders: the plaintext is never stored. An edit
     * sends the fields it keeps along with the one it changes (the event dialog sends them all); one it leaves out is dropped, since the
     * server can't read the sealed value to keep it. A `sealedContent` from the client is ignored: only the server writes it.
     *
     * Content naming a title drops the row's per-field `sealedFields` (only ever the title's copy on such a row), as
     * `ScanQueueJob.supersededSealing()` does for a revision with a SUMMARY.
     *
     * Returns what it sealed when that names a title - the plaintext an invitation for the revision is composed from - else `undefined`.
     */
    private async keepSealed(obj: any, existing: T): Promise<InvitationContent | undefined> {
        delete obj.sealedContent;
        const sealed: SealedEventContent | undefined = (existing as any).sealedContent ?? undefined;
        if (!sealed || !SEALED_EVENT_FIELDS.some((field) => obj[field] !== undefined)) {
            return undefined;
        }
        const mailbox: Mailbox | undefined = await this.mailboxRepo!.findOne(existing.mailboxUid, { ignoreACL: true });
        const target: ZeroAccessTarget | undefined = mailbox ? zeroAccessTargetFor(mailbox, sealed.keyFingerprint) : undefined;
        if (!target) {
            // The key is gone (the mailbox's keys were replaced wholesale): nothing can be sealed to it, and storing plaintext isn't an option.
            throw new ApiError(ApiErrors.INVALID_REQUEST, 409, "This event's details are sealed to a key this mailbox no longer has, so they can't be changed.");
        }
        const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
        const content = {
            title: typeof obj.title === "string" && obj.title !== PROTECTED_SUBJECT ? obj.title : "",
            location: text(obj.location),
            description: text(obj.description),
            descriptionHtml: text(obj.descriptionHtml),
        };
        obj.sealedContent = { keyFingerprint: target.key.fingerprint, sealed: await sealEventFields(content, target.certDer) };
        obj.title = PROTECTED_SUBJECT;
        obj.location = null;
        obj.description = null;
        obj.descriptionHtml = null;
        if (content.title && (existing as any).sealedFields?.title) {
            // The title's per-field copy (kept by a revision that named none, `sealInvite()`/`ScanQueueJob.supersededSealing()`) is
            // superseded by the one just sealed: left, a client opening both would show the old title over the new.
            obj.sealedFields = null;
        }
        return content.title ? content : undefined;
    }

    /**
     * `keepSealed()` for a client's create or update body - `existing` the row it updates, or (`creating`) the series an occurrence is
     * detached from - with the echo rule field sealing applies (`sealFieldsOnWrite()`): a client that couldn't open the content (no keys, or
     * locked) sends back what it was shown, the placeholder title and no location or description, and that is no change. Resealing it would
     * replace the real content with empty content for good. Such a body's content fields are dropped, so the row keeps its `sealedContent`
     * (a detached occurrence takes the series'). A body that changes the location or description but sends the placeholder title (or none)
     * is refused (`409`), since resealing it would lose the title. What an opened body seals is what the revision's invitations are composed
     * from when the request carries no `invitationContent` (`READABLE_CONTENT`).
     */
    private async keepSealedFromClient(obj: any, existing: T, creating: boolean): Promise<void> {
        const sealed: SealedEventContent | undefined = (existing as any).sealedContent ?? undefined;
        if (sealed) {
            const echo = (field: string): boolean =>
                field === "title" ? obj.title === undefined || obj.title === PROTECTED_SUBJECT : obj[field] === undefined || obj[field] === null || obj[field] === "";
            if (SEALED_EVENT_FIELDS.every(echo)) {
                delete obj.sealedContent;
                for (const field of SEALED_EVENT_FIELDS) {
                    delete obj[field];
                }
                if (creating) {
                    // A series whose sealed content names no title holds it in `sealedFields.title` alone (`sealInvite()`), which the
                    // occurrence takes too, or it would open untitled.
                    const sealedTitle: string | undefined = (existing as any).sealedFields?.title;
                    Object.assign(obj, {
                        sealedContent: { ...sealed },
                        ...(sealedTitle ? { sealedFields: { title: sealedTitle } } : {}),
                        title: PROTECTED_SUBJECT,
                        location: null,
                        description: null,
                        descriptionHtml: null,
                    });
                }
                return;
            }
            if (echo("title")) {
                throw new ApiError(
                    ApiErrors.INVALID_REQUEST,
                    409,
                    "This event's details are sealed: a change of its location or description must be sent with its opened title.",
                );
            }
        }
        const opened: InvitationContent | undefined = await this.keepSealed(obj, existing);
        if (opened) {
            READABLE_CONTENT.set(obj, opened);
        }
    }

    /** Refuses (400) an event whose organizer or attendees can't be mailed safely - see `assertParticipants()` - and a bad description, visibility or guest permission. */
    protected async prepareCreate(obj: any, user: JWTUser | undefined): Promise<void> {
        await super.prepareCreate(obj, user);
        // Only the server seals an event's content (from an invitation that reached a zero-access mailbox).
        delete obj.sealedContent;
        BaseCalendarEventRoute.assertParticipants(obj);
        BaseCalendarEventRoute.normalizeDescriptionAndPolicy(obj, false);
        delete obj.invitationContent;
        const sealedSibling: T | undefined = await this.findSealedSibling(obj);
        if (sealedSibling) {
            // One occurrence of an event filed from a zero-access invitation, detached (a drag, a resize, "This event only"): the
            // client sends the content it opened, which is sealed again into one blob to the series' key and never stored readable,
            // whatever the calendar's own setting (a 409 when that key is gone, as for an update).
            ZeroAccessRouteSealing.takeClearedFields(obj);
            delete obj.sealedFields;
            await this.keepSealedFromClient(obj, sealedSibling, true);
            const origin: string | undefined = (sealedSibling as any).encryptionOrigin;
            // Sticky across a series' instances (`CalendarEvent.encryptionOrigin`).
            obj.encryptionOrigin = origin && origin !== "none" ? origin : "derived";
        } else {
            await this.sealing?.seal(obj, undefined);
        }
        delete obj.clearedFields;
    }

    /** A row of the create body's mailbox with the body's `icalUid` (the series, or another occurrence of it) whose content is sealed whole
     * (`sealedContent`): the body is then an occurrence of an event filed from a zero-access invitation (`prepareCreate()`). The `icalUid`
     * is the client's value and is matched as a literal. */
    private async findSealedSibling(obj: any): Promise<T | undefined> {
        if (typeof obj.mailboxUid !== "string" || typeof obj.icalUid !== "string" || obj.icalUid.length === 0) {
            return undefined;
        }
        const key: string = boundIndexedValue(obj.icalUid);
        const rows: T[] = await this.repoUtils!.find({ mailboxUid: obj.mailboxUid, icalUid: ModelUtils.literal(key), limit: 50 } as any, {
            ignoreACL: true,
            limit: 50,
        });
        const sealed: T[] = rows.filter((row) => row.icalUid === key && (row as any).sealedContent);
        // The series' own row first: what the occurrence is a part of.
        return sealed.find((row) => !row.recurrenceId) ?? sealed[0];
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
        const mailbox: Mailbox | undefined = await this.mailboxRepo!.findOne(existing.mailboxUid, { ignoreACL: true });
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

    @Init
    protected async initCalendarEventRepos(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.mailboxRepo && this.mailboxClass) {
            this.mailboxRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.mailboxClass.name, args: [this.mailboxClass] });
        }
        if (!this.messageRepo && this.messageClass) {
            this.messageRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.messageClass.name, args: [this.messageClass] });
        }
        if (!this.folderRepo && this.folderClass) {
            this.folderRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.folderClass.name, args: [this.folderClass] });
        }
        if (!this.attendeeLinkRepo && this.attendeeLinkClass) {
            this.attendeeLinkRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.attendeeLinkClass.name, args: [this.attendeeLinkClass] });
        }
        if (!this.correspondentRepo && this.correspondentClass) {
            this.correspondentRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.correspondentClass.name,
                args: [this.correspondentClass],
            });
        }
        if (!this.domainUtils && this.domainClass) {
            const domainRepo: RepoUtils<any> = await this._objectFactory.newInstance(RepoUtils, { name: this.domainClass.name, args: [this.domainClass] });
            this.domainUtils = await this._objectFactory.newInstance(DomainUtils, { name: this.domainClass.name, args: [domainRepo] });
        }
        if (!this.sealing && this.encryptionPolicyClass) {
            this.sealing = await ZeroAccessRouteSealing.create(this._objectFactory, "calendar", this.mailboxClass, this.encryptionPolicyClass);
        }
        if (!this.correspondentUtils && this.correspondentClass) {
            this.correspondentUtils = await this._objectFactory.newInstance(CorrespondentUtils, {
                name: this.correspondentClass.name,
                args: [this.correspondentRepo, this.mailboxRepo],
            });
        }
    }

    /** See `BaseScopedChildRoute.resolveMailboxUidFor()`'s own doc comment - `CalendarEvent` carries its
     * own denormalized `mailboxUid` that must never diverge from its actual folder's mailbox. */
    protected async resolveMailboxUidFor(scopeUid: string, rejectDeleted?: boolean): Promise<string | undefined> {
        return getMailboxUidForFolder(this.folderRepo!, scopeUid, { rejectDeleted });
    }

    /** Coerces every date field to a real `Date` (a `400` for an unparseable one) before anything is saved - see
     * `util/DateCoercionUtils.ts` for why MongoDB would otherwise store the client's ISO strings as strings. */
    public async create(obj: T | T[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T | T[]> {
        const contents: (InvitationContent | undefined)[] = [];
        const secrets: (MeetingLinkSecrets | undefined)[] = [];
        for (const single of Array.isArray(obj) ? obj : [obj]) {
            coerceCalendarEventDates(single);
            secrets.push(meetingLinkSecretsOf((single as any)?.invitationContent?.meetingLinkSecrets));
            contents.push(BaseCalendarEventRoute.takeInvitationContent(single, true));
        }
        const created: T | T[] = await super.create(obj, req, user);
        const events: T[] = Array.isArray(created) ? created : [created];
        for (let i = 0; i < events.length; i++) {
            await this.recordEventCorrespondents(events[i]);
            events[i] = await this.sendProtectedInvitations(events[i], contents[i], secrets[i]);
        }
        return Array.isArray(created) ? events : events[0];
    }

    /**
     * `event` named by the request's `invitationContent` when its own content is sealed - field by field (`sealedFields`), or whole as an
     * event filed from a zero-access invitation (`sealedContent`) - what a reply or a change request about it says; `event` itself when it
     * isn't. A sealed event the request sends no content for has none: its title, location and description are left empty rather than
     * named by their placeholders, so its iTIP message carries no `SUMMARY` an organizer's server could take for the real title (an
     * unprotected organizer's applies a change request's title) and its mail names it `UNNAMED_EVENT`.
     */
    private static withInvitationContent<E extends CalendarEvent>(event: E, body: any): E {
        if (!hasSealedFields(event) && !event.sealedContent) {
            return event;
        }
        const content: InvitationContent | undefined = BaseCalendarEventRoute.takeInvitationContent(body, false);
        return content ? { ...event, ...content } : { ...event, title: "", location: undefined, description: undefined, descriptionHtml: undefined };
    }

    /**
     * The title, location and description an invitation for `obj` (a create or update body) is composed with: its `invitationContent`
     * when the client sends one - all of them, also those it doesn't change (a client editing a protected event sends only the fields it
     * changes, so that a change is recognized; the stored ones are sealed and the server can't compare them) - else, on a create, the
     * body's own fields. `undefined` when there is no title to compose with, and on a create whose `invitationContent` is
     * `{ defer: true }`: the client defers the invitations to the save that follows (the event editor attaches a video meeting first), so
     * attendees get one invitation, the one with the link.
     */
    private static takeInvitationContent(obj: any, create: boolean): InvitationContent | undefined {
        if (create && obj?.invitationContent?.defer === true) {
            return undefined;
        }
        const given: any = obj?.invitationContent && typeof obj.invitationContent === "object" ? obj.invitationContent : create ? obj : undefined;
        const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
        // The placeholder of an event whose content is sealed whole is what a client that could not open it sends back: no title.
        const title: string | undefined = given?.title === PROTECTED_SUBJECT ? undefined : text(given?.title);
        return title ? { title, location: text(given.location), description: text(given.description), descriptionHtml: text(given.descriptionHtml) } : undefined;
    }

    /**
     * Sends the invitations of a protected event - sealed, or a meeting with a per-meeting key - at save time, from the request's
     * plaintext `content` and the guests' link keys - see `MeetingInviteSender.sendProtectedInvitations()`. Returns the event as stored
     * afterwards: claiming the revision writes a new `version`, which the response and a notification then carry, so the client's next
     * save isn't refused as stale.
     */
    private async sendProtectedInvitations(event: T, content: InvitationContent | undefined, secrets?: MeetingLinkSecrets): Promise<T> {
        if (!invitationsPending(event) || !(isSealedEvent(event) || event.videoMeetingUid)) {
            return event;
        }
        const claimed = (await (await this.getInviteSender()).sendProtectedInvitations(event, content, this.repoUtils!, "BaseCalendarEventRoute", secrets)) as
            | T
            | undefined;
        if (!claimed) {
            return event;
        }
        this.notify(claimed.folderUid, "update", claimed);
        return claimed;
    }

    /** This route's `MeetingInviteSender`. Built on first use: most events are never protected. Unnamed, so it is this route's own: a named
     * instance is shared through the factory, and another caller's (`MeetingSchedulingJob`'s, another backend's route) would come back
     * without this route's `mayCarryMeetingKey` and repositories. */
    private async getInviteSender(): Promise<MeetingInviteSender> {
        this.inviteSender ??= await this._objectFactory!.newInstance(MeetingInviteSender, {
            args: [this.mailboxRepo, this.attendeeLinkRepo, { mayCarryMeetingKey: (address: string) => this.mayCarryMeetingKey(address) }],
        });
        return this.inviteSender;
    }

    /**
     * Whether an invitation to `address` may carry its link's per-meeting key (meet-plugin `specs/meeting_privacy.md` §4.1, which the
     * server must never store): yes for an address elsewhere, whose copy leaves this server; for one of this server's mailboxes only when
     * its mail is stored zero-access encrypted, since its copy - the message and the event filed from it - is stored here. An address
     * of this server's domains that isn't a mailbox (a list, an unknown one) can't be told, so it is a no.
     */
    private async mayCarryMeetingKey(address: string): Promise<boolean> {
        const domains: string[] = this.domainUtils ? (await this.domainUtils.getVerifiedDomainNames()).map((name) => name.toLowerCase()) : [];
        for (const candidate of new Set([address, stripPlusTag(address)])) {
            const rewritten: string | undefined = await this.domainUtils?.resolveDomainAlias(candidate);
            for (const exact of rewritten ? [candidate, rewritten] : [candidate]) {
                const mailbox: Mailbox | undefined =
                    (await this.mailboxRepo!.find({ primarySmtpAddress: ModelUtils.literal(exact) } as any, { ignoreACL: true, limit: 1 }))[0] ??
                    (await this.mailboxRepo!.find({ aliasAddresses: this.aliasQueryValue(exact) } as any, { ignoreACL: true, limit: 1 }))[0];
                if (mailbox) {
                    return !!(await this.sealing?.sealsMail(mailbox));
                }
            }
        }
        return !domains.includes(addressDomainOf(address) ?? "");
    }

    /** Records an event's organizer and attendees as correspondents of the mailbox it is on, for recipient suggestions.
     * Best-effort - `CorrespondentUtils.recordCorrespondents()` never throws. */
    private async recordEventCorrespondents(event: CalendarEvent): Promise<void> {
        await this.correspondentUtils!.recordCorrespondents(event.mailboxUid, eventObservations(event), "event");
    }

    /** Also serves `updateBulk()`/`updateProperty()`, which `BaseScopedChildRoute` routes through `update()`. */
    public async update(id: string, obj: UpdateObject<T>, req?: HttpRequest, user?: JWTUser): Promise<T> {
        if (!this.repoUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        coerceCalendarEventDates(obj);
        const secrets: MeetingLinkSecrets | undefined = meetingLinkSecretsOf((obj as any)?.invitationContent?.meetingLinkSecrets);
        const content: InvitationContent | undefined = BaseCalendarEventRoute.takeInvitationContent(obj, false);
        const existing: T | undefined = await this.repoUtils.findOne(id, { ignoreACL: true });
        if (existing && this.isSchedulingRelevantChange(existing, obj)) {
            (obj as any).sequence = existing.sequence + 1;
        } else if (existing && (existing as any).sealedContent && !(typeof (obj as any).sequence === "number" && (obj as any).sequence > existing.sequence)) {
            // Content sealed whole: the server can't see a change of its location or description (`keepSealed()` nulls both before
            // `changesInvitation()` compares them), so a client that opened it raises the sequence itself when it changes either. Any other
            // value it sends (the one it read back) is dropped, never lowering the stored one.
            delete (obj as any).sequence;
        }
        const stored: T = await super.update(id, obj, req, user);
        // Without invitationContent, an event this write sealed for the first time is invited for from what it held readable (`prepareUpdate()`).
        const updated: T = await this.sendProtectedInvitations(stored, content ?? READABLE_CONTENT.get(obj), secrets);
        // Only an update that names the people involved is a new sighting of them (a move or a rename is not).
        if ((obj as any).attendees !== undefined || (obj as any).organizer !== undefined) {
            await this.recordEventCorrespondents(updated);
        }
        return updated;
    }

    /** `true` if any of `startDate`/`endDate`/`location`/`attendees`/`status`/`recurrenceRule` in `obj`
     * differs from `existing`'s current value - fields `obj` doesn't touch at all are ignored, matching
     * this route family's ordinary partial-update semantics. The `location` of an event whose content is sealed whole
     * (`sealedContent`) is not compared: the stored one is a placeholder, and every save of the opened event sends the real one,
     * which would otherwise raise the sequence each time (an attendee's copy then ignoring the organizer's next revision as stale,
     * an organizer's meeting re-inviting everyone). Its client raises the sequence itself for a real change (`update()`). */
    private isSchedulingRelevantChange(existing: T, obj: UpdateObject<T>): boolean {
        const incoming: any = obj;
        // `new Date()` on the stored side too - a row saved before dates were coerced on write can hold a string.
        if (incoming.startDate !== undefined && new Date(incoming.startDate).getTime() !== new Date(existing.startDate).getTime()) {
            return true;
        }
        if (incoming.endDate !== undefined && new Date(incoming.endDate).getTime() !== new Date(existing.endDate).getTime()) {
            return true;
        }
        const fields: (keyof CalendarEvent)[] = (existing as any).sealedContent ? ["attendees", "status", "recurrenceRule"] : ["location", "attendees", "status", "recurrenceRule"];
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
                mailboxRepo: this.mailboxRepo!,
                folderRepo: this.folderRepo!,
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
    @RateLimit({ perUser: true, maxAttempts: ITIP_MAIL_MAX_ATTEMPTS, windowSeconds: ITIP_MAIL_WINDOW_SECONDS })
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

        const responseStatus = respondStatusOf(body?.responseStatus);
        if (!responseStatus) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }

        const mailboxRepo = this.mailboxRepo!;
        const mailbox: Mailbox | undefined = await mailboxRepo.findOne(event.mailboxUid, { ignoreACL: true });
        const mailboxAddresses = mailbox ? [mailbox.primarySmtpAddress, ...mailbox.aliasAddresses].map((a) => a.toLowerCase()) : [];
        const respondingAttendee: Attendee | undefined = event.attendees.find((attendee) =>
            mailboxAddresses.includes(attendee.address.toLowerCase()),
        );
        if (!respondingAttendee) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }

        const updatedAttendee: Attendee = { ...respondingAttendee, responseStatus };
        // A protected event's reply names it by the title the reader's client sends, not the stored placeholder.
        const shown: T = BaseCalendarEventRoute.withInvitationContent(event, body);
        const ics = buildEventIcs({ ...shown, attendees: [updatedAttendee] }, "REPLY", { onlyAttendee: updatedAttendee });

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

        await this.sendItipReply(shown, mailbox, respondingAttendee, body.responseStatus, ics);

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
        const name: string = event.title || UNNAMED_EVENT;
        await this.sendItipMail(
            event,
            mailbox,
            responder,
            `${answer === "declined" ? "Declined" : answer === "tentative" ? "Tentative" : "Accepted"}: ${name}`,
            `${responder.displayName ?? responder.address} has responded ${answer} to: ${name}`,
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
    @RateLimit({ perUser: true, maxAttempts: ITIP_MAIL_MAX_ATTEMPTS, windowSeconds: ITIP_MAIL_WINDOW_SECONDS })
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
            invitationContent?: InvitationContent;
        } | undefined,
        @AuthUser user?: JWTUser,
    ): Promise<{ requested: true; changes: string[]; addAttendees: { address: string; displayName?: string }[] }> {
        if (!this.repoUtils || !this.mailTransport) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const stored: T | undefined = await this.repoUtils.findOne(id, { ignoreACL: true });
        if (!stored) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        if (!(await this.hasMailAccess(user, stored.folderUid, ACLAction.UPDATE))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        // A protected event's request names it, and compares the asked-for changes with it, by what the reader's client sends.
        const event: T = BaseCalendarEventRoute.withInvitationContent(stored, body);
        const invalid = (message: string): ApiError => new ApiError(ApiErrors.INVALID_REQUEST, 400, message);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw invalid(ApiErrorMessages.INVALID_REQUEST);
        }

        const mailbox: Mailbox | undefined = await this.mailboxRepo!.findOne(event.mailboxUid, { ignoreACL: true });
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
            // The title is always named (the organizer's card shows it) - but for a sealed event whose content the request didn't send
            // (`withInvitationContent()`); the location only when it is asked to change - a guest's own copy may hold a link of their own
            // (`CalendarEventAttendeeLink`) that must never be mistaken for a request.
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
        const note: string = `${proposer.displayName ?? proposer.address} asked to change: ${event.title || UNNAMED_EVENT}\n\n${lines.join("\n")}`;
        const sent: boolean = await this.sendItipMail(
            event,
            mailbox,
            proposer,
            `Change requested: ${event.title || UNNAMED_EVENT}`,
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
     * `getInvite()` for a zero-access message, whose stored source is sealed: the client sends the calendar file from its decrypted copy
     * (`ics`), which every other invitation endpoint takes in its body too. See `loadInvite()`.
     */
    @Summary("Read the meeting invitation in a zero-access message")
    @Description("Reports the calendar invitation of a zero-access message from the calendar file the client decrypted, as GET /invite/:messageUid does.")
    @Returns([Object])
    @Post("/invite/:messageUid/view")
    public async viewInvite(@Param("messageUid") messageUid: string, body: InviteSource | undefined, @AuthUser user?: JWTUser): Promise<MessageInvite> {
        const context = await this.loadInvite(messageUid, user, ACLAction.READ, body?.ics);
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
    @RateLimit({ perUser: true, maxAttempts: ITIP_MAIL_MAX_ATTEMPTS, windowSeconds: ITIP_MAIL_WINDOW_SECONDS })
    @Post("/invite/:messageUid/respond")
    public async respondToInvite(
        @Param("messageUid") messageUid: string,
        body: ({ responseStatus?: InviteResponse } & InviteSource) | undefined,
        @AuthUser user?: JWTUser,
    ): Promise<MessageInvite> {
        const context = await this.loadInvite(messageUid, user, ACLAction.UPDATE, body?.ics);
        const answer: InviteResponse | undefined = body?.responseStatus;
        const status: AttendeeResponseStatus | undefined = answer ? respondStatusOf(answer) : undefined;
        if (!answer || !status) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'responseStatus' must be accepted, tentative or declined.");
        }
        await this.assertFromOrganizer(context);
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
    public async removeInvite(@Param("messageUid") messageUid: string, body: InviteSource | undefined, @AuthUser user?: JWTUser): Promise<MessageInvite> {
        const context = await this.loadInvite(messageUid, user, ACLAction.UPDATE, body?.ics);
        await this.assertFromOrganizer(context);
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
    @RateLimit({ perUser: true, maxAttempts: ITIP_MAIL_MAX_ATTEMPTS, windowSeconds: ITIP_MAIL_WINDOW_SECONDS })
    @Post("/invite/:messageUid/propose")
    public async proposeNewTime(
        @Param("messageUid") messageUid: string,
        body: ({ startDate?: string; endDate?: string; comment?: string } & InviteSource) | undefined,
        @AuthUser user?: JWTUser,
    ): Promise<MessageInvite> {
        const context = await this.loadInvite(messageUid, user, ACLAction.UPDATE, body?.ics);
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
     *
     * A meeting whose content is sealed, or that is protected by a per-meeting key, is one the scheduling job can't invite for: its updated
     * invitations are sent here, from the plaintext title, location and description and the guests' link keys the organizer's client sends
     * in `invitationContent` (and its `meetingLinkSecrets`), as a save does (`MeetingInviteSender.sendProtectedInvitations()`). Without them
     * it is a `400` and nothing moves, rather than a meeting moved that no guest is told of.
     */
    @Summary("Accept a proposed new time")
    @Description("Moves the meeting to the time an attendee proposed (an iTIP COUNTER) and re-invites the attendees.")
    @Returns([Object])
    @Post("/invite/:messageUid/accept-proposal")
    public async acceptProposal(
        @Param("messageUid") messageUid: string,
        body: (InviteSource & { invitationContent?: InvitationContent & { meetingLinkSecrets?: MeetingLinkSecrets } }) | undefined,
        @AuthUser user?: JWTUser,
    ): Promise<MessageInvite> {
        const context = await this.loadInvite(messageUid, user, ACLAction.UPDATE, body?.ics);
        const view: MessageInvite = await this.describe(context);
        const existing: CalendarEvent | undefined = context.existing;
        // "You organize it" is what the calendar copy says, not the file the sender wrote: a guest's counter-proposal naming the reader as `ORGANIZER`
        // must not move a meeting the reader only attends.
        if (!view.canAcceptProposal || !existing || !context.parsed.startDate || !context.parsed.endDate || !context.addresses.has(normalizeAddress(existing.organizer?.address ?? ""))) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "This message isn't a proposed time for a meeting you organize.");
        }
        // The message's `From` is only as good as the DKIM result behind it: inbound processing applies a proposal from an authenticated sender only.
        if (context.verifiedSender !== normalizeAddress(context.message.from.address)) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, "This proposal's sender could not be verified.");
        }
        const content: InvitationContent | undefined = BaseCalendarEventRoute.takeInvitationContent(body, false);
        const secrets: MeetingLinkSecrets | undefined = meetingLinkSecretsOf(body?.invitationContent?.meetingLinkSecrets);
        if (existing.encryptionOrigin !== "originated" && ((isSealedEvent(existing) && !content) || ((await (await this.getInviteSender()).isKeyedMeeting(existing)) && !secrets))) {
            throw new ApiError(
                ApiErrors.INVALID_REQUEST,
                400,
                "This meeting's invitations are protected: accepting a proposal needs its invitationContent (and the guests' meetingLinkSecrets).",
            );
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
        const updated: CalendarEvent = await this.sendProtectedInvitations(await this.repoUtils!.update(patch, existing as any, { user, ignoreACL: true }), content, secrets);
        await this.recordInviteAnswer(context.message, "accepted");
        context.message.meetingResponse = "accepted";
        return await this.describe(context, { existing: updated });
    }

    /** The `MessageInvite` for `context`, with the schedule around it read from the mailbox's calendar. `overrides` replaces the calendar row or message it describes. */
    private async describe(context: InviteContext, overrides?: { existing?: CalendarEvent | undefined; message?: any }): Promise<MessageInvite> {
        const existing: CalendarEvent | undefined = overrides && "existing" in overrides ? overrides.existing : context.existing;
        const schedule: InviteScheduleEntry[] = await this.loadSchedule(context);
        return describeInvite(context.parsed, context.addresses, existing, overrides?.message ?? context.message, schedule);
    }

    /**
     * The reader's own events from 12 hours before the invitation starts to 12 hours after it ends, recurring series expanded, without the
     * meeting itself. Bounded reads (200 rows each of what overlaps the window and of the recurring masters): a mailbox with more than that
     * gets a partial schedule, never a failure - it only decorates the card.
     *
     * Each event is shown as the caller may see it on its calendar: in a calendar they can't read (a grantee of the Inbox alone) only as
     * `POST /free-busy` would show it, and only when the mailbox's free/busy is shown to them at all (`freeBusyCalendarFolders()`, the
     * owner's `freeBusyVisibility`) - merged busy windows without a title or a row's uid, from the live calendars only, leaving out free
     * and declined events (`computeBusyIntervals()`, `mergeBusyIntervals()`); a private or confidential one, to a reader without `UPDATE` on its calendar, as
     * `BUSY_TITLE` (`redactReadRecords()`). The owner and delegates with `UPDATE` see every title.
     */
    private async loadSchedule(context: InviteContext): Promise<InviteScheduleEntry[]> {
        const { mailbox, parsed, addresses, user } = context;
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
            const access: Map<string, Promise<{ read: boolean; details: boolean }>> = new Map();
            const accessTo = (folderUid: string): Promise<{ read: boolean; details: boolean }> => {
                if (!access.has(folderUid)) {
                    access.set(
                        folderUid,
                        (async () => {
                            const read: boolean = await this.hasMailAccess(user, folderUid, ACLAction.READ);
                            return { read, details: read && (await this.seesEventDetails(user, folderUid)) };
                        })(),
                    );
                }
                return access.get(folderUid)!;
            };
            // Asked once, and only for a row in a calendar the caller can't read. `user` is set: `loadInvite()` found them access to the message.
            let freeBusy: Promise<ReadonlySet<string> | undefined> | undefined;
            const freeBusyFolders = (): Promise<ReadonlySet<string> | undefined> =>
                (freeBusy ??= freeBusyCalendarFolders(
                    {
                        caller: user!,
                        mailboxRepo: this.mailboxRepo!,
                        folderRepo: this.folderRepo!,
                        hasAccess: (uid, action) => this.hasMailAccess(user, uid, action),
                    },
                    mailbox,
                ));
            const entries: InviteScheduleEntry[] = [];
            // The rows of calendars the caller can't read that free/busy counts, shown below as free/busy shows them.
            const unreadable: CalendarEvent[] = [];
            for (const row of rows.values()) {
                if (row.icalUid === own || row.status === CalendarEventStatus.CANCELLED) {
                    continue;
                }
                const seen: { read: boolean; details: boolean } = await accessTo(row.folderUid);
                if (!seen.read) {
                    if ((await freeBusyFolders())?.has(row.folderUid)) {
                        unreadable.push(row);
                    }
                    continue;
                }
                const title: string = hidesDetailsFromReaders(row) && !seen.details ? BUSY_TITLE : (row.title ?? "");
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
                        title,
                        startDate: occurrence.start.toISOString(),
                        endDate: occurrence.end.toISOString(),
                        allDay: !!row.allDay,
                        busy: row.busyStatus !== BusyStatus.FREE && mine?.responseStatus !== AttendeeResponseStatus.DECLINED,
                        tentative: row.busyStatus === BusyStatus.TENTATIVE || mine?.responseStatus === AttendeeResponseStatus.NEEDS_ACTION || mine?.responseStatus === AttendeeResponseStatus.TENTATIVE,
                    });
                }
            }
            // No more than `POST /free-busy` gives: merged busy windows, without the free or declined events, their boundaries or uids.
            // An entry's uid only has to be unique in the schedule (a client keys it), and windows never overlap.
            for (const window of mergeBusyIntervals(computeBusyIntervals(unreadable, windowStart, windowEnd, mailboxAddressSet(mailbox)), windowStart, windowEnd)) {
                entries.push({
                    uid: `busy:${window.start.toISOString()}`,
                    title: "",
                    startDate: window.start.toISOString(),
                    endDate: window.end.toISOString(),
                    allDay: false,
                    busy: true,
                    tentative: window.tentative,
                });
            }
            return entries.sort((a, b) => a.startDate.localeCompare(b.startDate)).slice(0, 200);
        } catch (err: any) {
            this.logger?.warn(`BaseCalendarEventRoute: couldn't read the schedule around invitation ${parsed.uid}: ${err.message}`);
            return [];
        }
    }

    /**
     * What the invitation endpoints work from: the message, its mailbox, the calendar file's event and the calendar row that already stands for it.
     *
     * A zero-access message's stored source is sealed, so its calendar file comes from the client (`clientIcs`, out of its decrypted copy) and
     * is required (`404` without it, as for a message with no invitation); a `clientIcs` for any other message is a `400`, the server reading
     * that file itself. The sender's DKIM verification still comes from the stored message - the sealed copy keeps its `Authentication-Results`
     * in the clear - never from the client. The client's file is trusted as far as its sender's own calendar is: a mailbox's user acting on it
     * changes only their calendar and answers as themselves, which they can do directly.
     */
    private async loadInvite(messageUid: string, user: JWTUser | undefined, action: string, clientIcs?: unknown): Promise<InviteContext> {
        if (!this.repoUtils || !this.blobStore) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const message: any = await this.messageRepo!.findOne(messageUid, { ignoreACL: true });
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
        const sealed: boolean = !!message.zeroAccess;
        if (clientIcs !== undefined && (!sealed || typeof clientIcs !== "string" || clientIcs.length > MAX_CLIENT_ICS_LENGTH)) {
            throw new ApiError(
                ApiErrors.INVALID_REQUEST,
                400,
                sealed ? `'ics' must be the calendar file, at most ${MAX_CLIENT_ICS_LENGTH} characters.` : "'ics' applies only to a zero-access message.",
            );
        }
        if (sealed && clientIcs === undefined) {
            throw noInvite();
        }
        let raw: Buffer;
        try {
            raw = await this.blobStore.get(message.bodyBlobKey);
        } catch {
            throw noInvite();
        }
        const ics: string | undefined = sealed ? (clientIcs) : await extractIcsFromRaw(raw);
        const parsed: ParsedIcsEvent | undefined = ics ? parseInviteIcs(ics) : undefined;
        if (!parsed) {
            throw noInvite();
        }
        const mailbox: Mailbox | undefined = await this.mailboxRepo!.findOne(message.mailboxUid, { ignoreACL: true });
        if (!mailbox) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        return {
            verifiedSender: verifiedFromAddress(raw, this.trustedAuthservId),
            user,
            message,
            mailbox,
            parsed,
            addresses: mailboxAddressSet(mailbox),
            existing: await this.findInviteRow(mailbox.uid, parsed),
        };
    }

    /**
     * Refuses (403) acting on a `REQUEST` or `CANCEL` for a meeting already on the calendar unless it comes from that meeting's organizer: the
     * file's `ORGANIZER`, the calendar's organizer for the meeting and the message's sender must all be the same address, and the sender must
     * be DKIM-verified (`verifiedSender`, as `acceptProposal()` requires) - the `From` header alone is anyone's. Matching on the `UID` alone would
     * let anybody who knows it (every co-attendee does) rewrite or delete the reader's real event with a forged invitation or cancellation when
     * the reader clicks Accept or Remove. "On the calendar" is the whole series: an occurrence (`RECURRENCE-ID`) of a series whose other rows
     * are there is held to the series' organizer, though that occurrence has no row of its own yet. Nothing is checked for a meeting that isn't
     * on the calendar at all.
     */
    private async assertFromOrganizer(context: InviteContext): Promise<void> {
        const method: string = context.parsed.method.toUpperCase();
        if (method !== "REQUEST" && method !== "CANCEL") {
            return;
        }
        const rows: T[] = await this.findInviteRows(context.mailbox.uid, context.parsed);
        const onCalendar: CalendarEvent | undefined = context.existing ?? rows.find((row) => !row.recurrenceId) ?? rows[0];
        if (!onCalendar) {
            return;
        }
        const organizer: string = normalizeAddress(context.parsed.organizer?.address ?? "");
        const known: string = normalizeAddress(onCalendar.organizer?.address ?? "");
        const sender: string = normalizeAddress(context.message.from.address);
        if (!organizer || organizer !== known || organizer !== sender || context.verifiedSender !== sender) {
            throw new ApiError(
                ApiErrors.AUTH_PERMISSION_FAILURE,
                403,
                "This message doesn't come from the organizer of the meeting on your calendar, so it can't change it.",
            );
        }
    }

    /** Every row of the mailbox's calendar that carries this invitation's `UID` (the series and its overridden occurrences). The `UID` is a
     * sender's value and is matched as a literal, exactly: a value like `ne(x)` would otherwise be read as a query operator. */
    private async findInviteRows(mailboxUid: string, parsed: ParsedIcsEvent): Promise<T[]> {
        const key: string = boundIndexedValue(parsed.uid);
        const rows: T[] = await this.repoUtils!.find({ mailboxUid, icalUid: ModelUtils.literal(key), limit: 50 } as any, { ignoreACL: true, limit: 50 });
        return rows.filter((row) => row.icalUid === key);
    }

    /** The mailbox's calendar row for this invitation's own occurrence (or the series, for no `RECURRENCE-ID`), if it has one. */
    private async findInviteRow(mailboxUid: string, parsed: ParsedIcsEvent): Promise<CalendarEvent | undefined> {
        return (await this.findInviteRows(mailboxUid, parsed)).find((row) => sameRecurrenceId(row.recurrenceId, parsed.recurrenceId));
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
            guestsCanInviteOthers: parsed.guestsCanInviteOthers ?? parsed.fromRapidMx === true,
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

    /**
     * Seals the content of `obj` - a row filed from the invitation (`existing` undefined) or a patch of `existing` - which is in this request
     * in plaintext (decrypted by the reader for a zero-access message), so it is never stored readable where it must not be: a row made from
     * a zero-access invitation keeps its one sealed blob (`keepSealed()`); otherwise it is sealed field by field when the calendar is
     * protected; and the invitation of a zero-access message is sealed to that message's key whatever the calendar's setting, as inbound
     * delivery files it (`ScanQueueJob`, `specs/search.md` §3: no plaintext of a zero-access mailbox's mail at rest). That last is decided on
     * what field sealing left readable, not on the row: a row sealed field by field while the calendar was protected, answered once it no
     * longer is, gets its content in `sealedContent` too, and loses the per-field copies it replaces - but the title's, when the revision
     * names no title.
     */
    private async sealInvite(obj: any, existing: CalendarEvent | undefined, context: InviteContext): Promise<void> {
        if ((existing as any)?.sealedContent) {
            await this.keepSealed(obj, existing as T);
            return;
        }
        // The revision's own empty fields are clears: the invitation says what the event now is.
        await this.sealing?.seal(obj, existing, true);
        const zeroAccess: { keyFingerprint: string } | undefined = context.message.zeroAccess ?? undefined;
        const readable: boolean = SEALED_EVENT_FIELDS.some((field) => obj[field] !== undefined && obj[field] !== null && obj[field] !== "" && obj.sealedFields?.[field] === undefined);
        if (zeroAccess && readable) {
            // A revision without SUMMARY: the title's sealed per-field copy is the only one there is (field sealing kept it, dropping the
            // placeholder echo) and the new content can't carry it, so it stays - as `ScanQueueJob.supersededSealing()` keeps it.
            const sealedTitle: string | undefined =
                context.parsed.summary === undefined ? (obj.sealedFields?.title ?? (existing as any)?.sealedFields?.title) : undefined;
            await this.keepSealed(obj, { mailboxUid: context.mailbox.uid, sealedContent: { keyFingerprint: zeroAccess.keyFingerprint } } as any);
            obj.sealedFields = sealedTitle ? { title: sealedTitle } : null;
            if (!existing) {
                obj.encryptionOrigin = "derived";
            }
        }
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
                              // An explicit clear: SQL's update skips an undefined value, which would keep the old location readable.
                              location: parsed.location ?? null,
                              description: parsed.description ?? null,
                              descriptionHtml: parsed.descriptionHtml ?? null,
                              visibility: parsed.visibility ?? "default",
                              guestsCanModify: parsed.guestsCanModify ?? false,
                              guestsCanInviteOthers: parsed.guestsCanInviteOthers ?? parsed.fromRapidMx === true,
                              guestsCanSeeGuestList: parsed.guestsCanSeeGuestList ?? true,
                              startDate: parsed.startDate ?? existing.startDate,
                              endDate: parsed.endDate ?? existing.endDate,
                              recurrenceRule: parsed.recurrenceRule ?? existing.recurrenceRule,
                              sequence: parsed.sequence,
                              inviteSequenceSent: parsed.sequence,
                          }
                        : {}),
                };
                await this.sealInvite(patch, existing, context);
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

            const folder = await findOrCreateWellKnownFolder(this.folderRepo!, this.folderClass, mailbox.uid, FolderType.CALENDAR);
            // A copy the reader declined or removed earlier is only soft-deleted and still holds this uid; clear it so the fresh copy can be filed
            // (answering Accept after a Decline would otherwise fail as a duplicate).
            const filedUid: string = nameBasedUuid(`itip:${mailbox.uid}:${parsed.uid}:${parsed.recurrenceId ? parsed.recurrenceId.toISOString() : "master"}`);
            const trashed: any = await this.repoUtils!.findOne(filedUid, { ignoreACL: true, includeDeleted: true });
            if (trashed?.deleted) {
                await this.repoUtils!.delete(filedUid, { ignoreACL: true, purge: true });
            }
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
            const filed: any = {
                ...this.eventFromInvite(parsed, attendees, mailbox.uid),
                // The uid inbound processing (`ScanQueueJob`) derives for the same invitation, so the two can't make two copies.
                uid: filedUid,
                folderUid: folder.uid,
                busyStatus,
                // Somebody else's invitation: marked as already sent, so the scheduling job never mails it again as though this mailbox organized it.
                inviteSequenceSent: parsed.sequence,
            };
            await this.sealInvite(filed, undefined, context);
            try {
                await this.repoUtils!.create(new Entity(filed), { user, ignoreACL: true });
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
        const repo: RepoUtils<any> = this.messageRepo!;
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
    /** The message's `From` address when its raw source carries a passing, aligned DKIM result from this deployment's trusted MTA hop. */
    verifiedSender: string | undefined;
    /** Who is acting on the invitation: the schedule around it is shown as they may see the calendar (`loadSchedule()`). */
    user: JWTUser | undefined;
    message: any;
    mailbox: Mailbox;
    parsed: ParsedIcsEvent;
    addresses: Set<string>;
    existing: CalendarEvent | undefined;
}
