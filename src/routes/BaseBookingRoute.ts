///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import {
    ApiErrorMessages,
    ApiErrors,
    DatabaseDecorators,
    DocDecorators,
    ObjectFactory,
    RepoUtils,
    RouteDecorators,
} from "@rapidrest/service-core";
import type { MailTransport } from "../transport/MailTransport.js";
import { generateCandidateSlots, normalizeSlug, subtractBusy } from "../util/BookingUtils.js";
import { findOrCreateWellKnownFolder } from "../util/FolderUtils.js";
import { computeBusyWindows } from "../util/FreeBusyUtils.js";
import { buildEventIcs, convertLocalToUtc, type OccurrenceWindow } from "../util/IcsUtils.js";
import {
    AttendeeRole,
    AttendeeResponseStatus,
    Booking,
    BookingStatus,
    BookingType,
    BusyStatus,
    CalendarEvent,
    CalendarEventStatus,
    Folder,
    FolderType,
    Mailbox,
    RecipientType,
} from "../models/types.js";
const { Config, Inject, Logger } = ObjectDecorators;
const { Description, Summary } = DocDecorators;
const { Transactional } = DatabaseDecorators;
const { Get, Param, Post, Query, RateLimit } = RouteDecorators;

/** Caps how many `CalendarEvent` rows any one availability lookup will pull back per query. */
const BUSY_EVENT_ROWS_LIMIT = 500;

/** The default number of days of availability returned when the caller supplies no `to`. Further constrained
 * by the booking type's own `bookingWindowDays`, which `generateCandidateSlots()` applies. */
const DEFAULT_SLOT_WINDOW_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The public projection of a `BookingType` - deliberately omits `mailboxUid`/`calendarFolderUid`, which are
 * internal identifiers an anonymous caller has no business learning. */
export interface PublicBookingType {
    slug: string;
    name: string;
    description?: string;
    hostDisplayName: string;
    durationMinutes: number;
    timezone: string;
    requiresApproval: boolean;
    minimumNoticeMinutes: number;
    bookingWindowDays: number;
}

/** The public projection of a `Booking`, as returned to the booker holding its `manageToken`. */
export interface PublicBooking {
    uid: string;
    bookingTypeSlug: string;
    name: string;
    hostDisplayName: string;
    bookerName: string;
    bookerEmail: string;
    bookerNotes?: string;
    bookerTimezone?: string;
    startDate: Date;
    endDate: Date;
    status: BookingStatus;
    /** Only ever returned by `book()` itself, never by a later lookup - the booker already has it by then. */
    manageToken?: string;
}

/** The request body accepted by `book()`. */
interface BookingRequestBody {
    start?: string;
    bookerName?: string;
    bookerEmail?: string;
    bookerNotes?: string;
    bookerTimezone?: string;
}

/** A very small sanity check on a booker-supplied address - deliberately not a full RFC 5322 parser. Its job is
 * to reject obvious junk before it becomes an envelope recipient, not to be authoritative. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

/**
 * The public, entirely unauthenticated half of appointment booking: a Calendly-style flow where a visitor with
 * nothing but a link picks a real slot from a mailbox owner's live availability, books it, and later manages
 * that booking through an emailed token. The host's own management of their offerings is `BaseBookingTypeRoute`.
 *
 * This is this library's first anonymous *write*, and it deliberately does not reuse the `?shareToken=`
 * mechanism `CalendarShareLink` uses: `resolveEffectiveUser()` is wired only into the read-shaped methods of
 * `BaseScopedChildRoute`, so there is no anonymous-write precedent to extend there. Instead this is a
 * standalone class in the shape of `BaseMailIngestRoute` - it is NOT a `CRUDRoute`/`BaseScopedChildRoute`
 * subclass, so no generic CRUD surface exists to be reached at all, it builds its own repos in `init()`, and
 * every repo call passes `ignoreACL: true` because it performs its own authorization by `slug` and by
 * `manageToken`. Both `BookingType` and `Booking` keep an ordinary deny-all class ACL; `"anonymous"` is never
 * granted an action anywhere, for the reason documented on `BaseMailboxRoute`.
 *
 * Like `BaseMailIngestRoute`/`BasePushRoute`, this class carries no `@Route` of its own - the consuming
 * application applies one (e.g. `@Route("/bookings")`) to its own subclass.
 *
 * ## Path shape
 *
 * The two families of endpoint are separated by a fixed literal first segment (`/types/...` and
 * `/manage/...`) rather than the prettier `/:slug` at the root. That is deliberate: with `/:slug` at the root,
 * `GET /manage/<token>` and `GET /:slug/slots` are both two-segment paths whose first segment is a parameter in
 * one and a literal in the other, leaving which one wins dependent on router registration order, and it would
 * additionally make `manage` a slug no host could ever use. A deployment that wants prettier public URLs can
 * rewrite them at its proxy.
 *
 * ## Rate limiting
 *
 * The three mutating endpoints carry `@RateLimit()`. That decorator keys its primary counter on
 * `` `${method} ${path}` `` - which, because the path embeds the slug, works out to a per-booking-type limit -
 * plus an independent, more permissive per-source-IP counter. The read endpoints deliberately do NOT carry it:
 * limits come from one shared `rateLimit` config block whose defaults (5 attempts / 5 minutes) are tuned for
 * credential endpoints, and applying that to a public availability page would throttle a single visitor simply
 * paging through a few weeks. A deployment exposing these routes should raise `rateLimit.maxAttempts` to suit
 * its own booking volume and front the read endpoints with an ordinary proxy/WAF limit.
 *
 * ## Known limitations
 *
 * **Double-booking race.** Availability is re-checked immediately before the event is written, and the write
 * pair is atomic (see `persistBooking()`), but two simultaneous bookers can still both pass the check before
 * either writes. Closing it needs a uniqueness guard the SQL backend can't express portably (a filtered unique
 * index over non-cancelled rows), so it is documented rather than silently assumed away.
 *
 * **`manageToken` never expires** and has no GC job. It is 32 bytes of `crypto.randomBytes` entropy, so
 * guessing is not the concern; a booker who forwards their link has permanently delegated cancel/reschedule.
 * Note the nearest precedent, `CalendarShareLink.expiresAt`, is itself only enforced by a daily job and never
 * at request time.
 *
 * **DST.** Availability math inherits `expandOccurrences()`'s documented DST-naivety for *recurring* busy
 * blocks; see `computeBusyWindows()`.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseBookingRoute<
    BT extends BookingType,
    B extends Booking,
    CE extends CalendarEvent,
    F extends Folder,
    M extends Mailbox,
> {
    protected abstract bookingTypeClass: any;
    protected abstract bookingClass: any;
    protected abstract calendarEventClass: any;
    protected abstract folderClass: any;
    protected abstract mailboxClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private bookingTypeRepo?: RepoUtils<BT>;
    private bookingRepo?: RepoUtils<B>;
    private calendarEventRepo?: RepoUtils<CE>;
    private folderRepo?: RepoUtils<F>;
    private mailboxRepo?: RepoUtils<M>;

    @Inject("MailTransport")
    private mailTransport?: MailTransport;

    /** The externally reachable base URL this route is mounted at, used to build the manage link mailed to the
     * booker. Same single-value-config pattern as `mail:auth_server_url`; when unset the confirmation simply
     * omits the link rather than mailing a broken one. */
    @Config("mail:booking:public_url", "")
    private publicUrl: string = "";

    @Logger
    private logger: any;

    /**
     * Exposes the `@Model(...)`-supplied entity class as an instance property so `@Transactional()` on
     * `persistBooking()` can resolve which datasource to open a transaction against. `ModelRoute` defines the
     * identical getter for its own subclasses; this class deliberately doesn't extend `ModelRoute` (see the
     * class doc comment), so it needs its own.
     */
    public get modelClass(): any {
        return (this.constructor as any).modelClass;
    }

    private async init(): Promise<void> {
        if (!this.bookingTypeRepo) {
            this.bookingTypeRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.bookingTypeClass.name,
                args: [this.bookingTypeClass],
            });
        }
        if (!this.bookingRepo) {
            this.bookingRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.bookingClass.name,
                args: [this.bookingClass],
            });
        }
        if (!this.calendarEventRepo) {
            this.calendarEventRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.calendarEventClass.name,
                args: [this.calendarEventClass],
            });
        }
        if (!this.folderRepo) {
            this.folderRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.folderClass.name,
                args: [this.folderClass],
            });
        }
        if (!this.mailboxRepo) {
            this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.mailboxClass.name,
                args: [this.mailboxClass],
            });
        }
    }

    /** Looks up an enabled booking type by its public slug. A disabled one is reported as a `404` rather than a
     * `403`, so a paused link is indistinguishable from one that never existed. */
    private async requireBookingType(slug: string): Promise<BT> {
        const matches: BT[] = await this.bookingTypeRepo!.find({ slug: normalizeSlug(slug ?? "") } as any, {
            ignoreACL: true,
            limit: 1,
        });
        if (matches.length === 0 || !matches[0].enabled) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        return matches[0];
    }

    private async requireBookingByToken(token: string): Promise<B> {
        const matches: B[] = await this.bookingRepo!.find({ manageToken: token ?? "" } as any, { ignoreACL: true, limit: 1 });
        if (matches.length === 0) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        return matches[0];
    }

    private toPublicBookingType(bookingType: BT): PublicBookingType {
        return {
            slug: bookingType.slug,
            name: bookingType.name,
            description: bookingType.description,
            hostDisplayName: bookingType.hostDisplayName,
            durationMinutes: bookingType.durationMinutes,
            timezone: bookingType.timezone,
            requiresApproval: bookingType.requiresApproval,
            minimumNoticeMinutes: bookingType.minimumNoticeMinutes,
            bookingWindowDays: bookingType.bookingWindowDays,
        };
    }

    private toPublicBooking(booking: B, bookingType: BT, includeToken: boolean): PublicBooking {
        return {
            uid: booking.uid,
            bookingTypeSlug: bookingType.slug,
            name: bookingType.name,
            hostDisplayName: bookingType.hostDisplayName,
            bookerName: booking.bookerName,
            bookerEmail: booking.bookerEmail,
            bookerNotes: booking.bookerNotes,
            bookerTimezone: booking.bookerTimezone,
            startDate: booking.startDate,
            endDate: booking.endDate,
            status: booking.status,
            manageToken: includeToken ? booking.manageToken : undefined,
        };
    }

    /**
     * Loads every `CalendarEvent` in `folderUid` that could possibly occupy any part of `[windowStart,
     * windowEnd]`, using three narrow database queries rather than one broad fetch-and-filter:
     *
     * Query 1 takes events that directly overlap the window (`startDate < windowEnd && endDate > windowStart`).
     * This is exact for the non-recurring events that make up nearly every calendar, and additionally excludes
     * cancelled and free-busy-status rows in the query itself.
     *
     * Query 2 takes recurring *masters* (`recurrenceRule` is not null), whose stored `startDate`/`endDate`
     * describe only their first occurrence and so are invisible to query 1 once the series has moved past the
     * window.
     *
     * Query 3 takes recurring *overrides* (`recurrenceId` is not null), which `computeBusyWindows()` needs even
     * when they fall outside the window and even when cancelled - a master must not phantom-generate an
     * occurrence an override already replaced. Neither query 2 nor query 3 filters on status/busyStatus for
     * that reason; `computeBusyWindows()` applies those itself where they are actually meaningful.
     *
     * Recurring rows are a small minority of any real calendar, so queries 2 and 3 stay cheap while query 1
     * carries the volume. Results are de-duplicated by `uid`, since a row can legitimately match more than one.
     */
    private async findBusyEvents(folderUid: string, windowStart: Date, windowEnd: Date): Promise<CE[]> {
        const [overlapping, masters, overrides] = await Promise.all([
            this.calendarEventRepo!.find(
                {
                    folderUid,
                    startDate: `lt(${windowEnd.toISOString()})`,
                    endDate: `gt(${windowStart.toISOString()})`,
                    status: `ne(${CalendarEventStatus.CANCELLED})`,
                    busyStatus: `ne(${BusyStatus.FREE})`,
                    limit: BUSY_EVENT_ROWS_LIMIT,
                } as any,
                { ignoreACL: true, limit: BUSY_EVENT_ROWS_LIMIT },
            ),
            this.calendarEventRepo!.find({ folderUid, recurrenceRule: "ne(null)", limit: BUSY_EVENT_ROWS_LIMIT } as any, {
                ignoreACL: true,
                limit: BUSY_EVENT_ROWS_LIMIT,
            }),
            this.calendarEventRepo!.find({ folderUid, recurrenceId: "ne(null)", limit: BUSY_EVENT_ROWS_LIMIT } as any, {
                ignoreACL: true,
                limit: BUSY_EVENT_ROWS_LIMIT,
            }),
        ]);

        const byUid: Map<string, CE> = new Map();
        for (const event of [...overlapping, ...masters, ...overrides]) {
            byUid.set(event.uid, event);
        }
        return [...byUid.values()];
    }

    /**
     * Counts the non-cancelled bookings already placed on the local calendar date containing `slotStart`.
     *
     * A single `range()` count query. This used to be two `count()` queries subtracted instead, because the
     * query DSL's `range()` operator fell back to comparing ISO timestamps as raw strings against a real
     * datetime column - fixed by `@rapidrest/service-core` 2.0's improved operand type coercion, confirmed by
     * reading its `ModelUtils.coerceOperand()` (both `range()` operands now go through the exact same
     * Date-aware coercion `gte()`/`lte()` already used). `range()` is inclusive on both ends (TypeORM
     * `Between()` / Mongo `$gte`+`$lte`), so the upper bound is `dayEnd` minus one millisecond to keep this
     * the same half-open `[dayStart, dayEnd)` window the old workaround computed - without it, a booking
     * starting at exactly the next day's midnight would double-count into both days.
     */
    private async countBookingsOnDay(bookingType: BT, slotStart: Date): Promise<number> {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: bookingType.timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).formatToParts(slotStart);
        const values: Record<string, string> = {};
        for (const part of parts) {
            values[part.type] = part.value;
        }
        const dayStart: Date = convertLocalToUtc(Number(values.year), Number(values.month), Number(values.day), 0, 0, 0, bookingType.timezone)!;
        const dayEnd: Date = new Date(dayStart.getTime() + MS_PER_DAY - 1);

        return await this.bookingRepo!.count(
            {
                bookingTypeUid: bookingType.uid,
                status: `ne(${BookingStatus.CANCELLED})`,
                startDate: `range(${dayStart.toISOString()},${dayEnd.toISOString()})`,
            } as any,
            { ignoreACL: true },
        );
    }

    /**
     * Re-derives whether `start` is still genuinely bookable and returns the slot it corresponds to, throwing a
     * `409` otherwise. Everything is recomputed from the booking type's configuration and the host's live
     * calendar - the caller's claim that a slot was free when they loaded the page is never trusted.
     *
     * `excludeEventUid` is the booking's own calendar event when rescheduling, which must not be treated as a
     * conflict with itself.
     */
    private async requireAvailableSlot(bookingType: BT, start: Date, now: Date, excludeEventUid?: string): Promise<OccurrenceWindow> {
        const candidates: OccurrenceWindow[] = generateCandidateSlots(bookingType, start, new Date(start.getTime() + 1), now);
        const slot: OccurrenceWindow | undefined = candidates.find((candidate) => candidate.start.getTime() === start.getTime());
        if (!slot) {
            throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "That time is not available for booking.");
        }

        const paddedStart: Date = new Date(slot.start.getTime() - bookingType.bufferBeforeMinutes * 60_000);
        const paddedEnd: Date = new Date(slot.end.getTime() + bookingType.bufferAfterMinutes * 60_000);
        const events: CE[] = (await this.findBusyEvents(bookingType.calendarFolderUid, paddedStart, paddedEnd)).filter(
            (event) => event.uid !== excludeEventUid,
        );
        const busy: OccurrenceWindow[] = computeBusyWindows(events, paddedStart, paddedEnd);
        if (subtractBusy([slot], busy, bookingType.bufferBeforeMinutes, bookingType.bufferAfterMinutes).length === 0) {
            throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "That time is no longer available.");
        }

        if (bookingType.maxPerDay != null && (await this.countBookingsOnDay(bookingType, slot.start)) >= bookingType.maxPerDay) {
            throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "That day is fully booked.");
        }

        return slot;
    }

    /** Parses a caller-supplied ISO timestamp, rejecting anything unparseable with a `400`. */
    private requireDate(value: string | undefined, fieldName: string): Date {
        const parsed: Date = new Date(value ?? "");
        if (!value || isNaN(parsed.valueOf())) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'${fieldName}' must be a valid ISO 8601 date/time.`);
        }
        return parsed;
    }

    /** The manage link mailed to the booker, or `undefined` when no public URL is configured. */
    private manageUrl(booking: B): string | undefined {
        return this.publicUrl ? `${this.publicUrl.replace(/\/+$/, "")}/manage/${booking.manageToken}` : undefined;
    }

    /**
     * Writes the `CalendarEvent`/`Booking` pair for a new booking. `@Transactional()` (resolving its datasource
     * from the `@Model(...)` on the concrete subclass, via the `modelClass` getter above) makes the two writes
     * atomic, so a failure partway through can never leave an event on the host's calendar with no booking row
     * behind it, or vice versa. `RepoUtils` picks the ambient transaction up on its own - no plumbing needed at
     * the call sites. Note this makes the pair atomic; it does not serialize two concurrent bookers, which is
     * the separate limitation documented on this class.
     */
    @Transactional()
    protected async persistBooking(bookingType: BT, folder: F, mailbox: M, slot: OccurrenceWindow, body: BookingRequestBody): Promise<B> {
        const bookerEmail: string = body.bookerEmail!.trim().toLowerCase();
        const confirmed: boolean = !bookingType.requiresApproval;

        const event: CE = await this.calendarEventRepo!.create(
            new this.calendarEventClass({
                folderUid: folder.uid,
                mailboxUid: bookingType.mailboxUid,
                title: `${bookingType.name} with ${body.bookerName!.trim()}`,
                startDate: slot.start,
                endDate: slot.end,
                allDay: false,
                timezone: bookingType.timezone,
                organizer: {
                    address: mailbox.primarySmtpAddress,
                    displayName: bookingType.hostDisplayName,
                    type: RecipientType.TO,
                },
                attendees: [
                    {
                        address: bookerEmail,
                        displayName: body.bookerName!.trim(),
                        role: AttendeeRole.REQUIRED,
                        responseStatus: AttendeeResponseStatus.ACCEPTED,
                        isOrganizer: false,
                    },
                ],
                status: confirmed ? CalendarEventStatus.CONFIRMED : CalendarEventStatus.TENTATIVE,
                busyStatus: confirmed ? BusyStatus.BUSY : BusyStatus.TENTATIVE,
                // The model default for `icalUid` is an empty string, which would break iTIP threading for
                // every booking at once - mint a real one, matching `ScanQueueJob`'s own event creation.
                icalUid: crypto.randomUUID(),
                sequence: 0,
            }),
            { ignoreACL: true, acl: { uid: crypto.randomUUID(), parentUid: folder.uid, records: [] } },
        );

        return await this.bookingRepo!.create(
            new this.bookingClass({
                bookingTypeUid: bookingType.uid,
                mailboxUid: bookingType.mailboxUid,
                folderUid: folder.uid,
                calendarEventUid: event.uid,
                bookerName: body.bookerName!.trim(),
                bookerEmail,
                bookerNotes: body.bookerNotes,
                bookerTimezone: body.bookerTimezone,
                startDate: slot.start,
                endDate: slot.end,
                status: confirmed ? BookingStatus.CONFIRMED : BookingStatus.PENDING,
                manageToken: crypto.randomBytes(32).toString("base64url"),
            }),
            { ignoreACL: true },
        );
    }

    /**
     * Mails the booker their confirmation (or an updated one after a reschedule) with the real iTIP invite
     * attached, then stamps `inviteSequenceSent` so `MeetingSchedulingJob` doesn't send a second, generic invite
     * for the same revision. Sending inline rather than leaving it to that job is deliberate: the booker expects
     * an immediate confirmation, and the mail has to carry the manage link, which the job's generic invite
     * cannot know about. The job remains the backstop for everything else.
     *
     * Best-effort throughout, matching `ScanQueueJob.finalizeResourceDecision()` - the booking itself has
     * already been committed, so a mail failure is logged rather than thrown back at the booker.
     */
    private async sendBookingMail(bookingType: BT, booking: B, event: CE, mailbox: M, cancelled: boolean): Promise<void> {
        try {
            const manageUrl: string | undefined = this.manageUrl(booking);
            const lines: string[] = [
                cancelled
                    ? `Your booking for '${bookingType.name}' with ${bookingType.hostDisplayName} has been cancelled.`
                    : `Your booking for '${bookingType.name}' with ${bookingType.hostDisplayName} is confirmed.`,
                `When: ${booking.startDate.toISOString()} - ${booking.endDate.toISOString()} (UTC)`,
            ];
            if (!cancelled && bookingType.requiresApproval) {
                lines.push("This booking is awaiting confirmation by the host.");
            }
            if (!cancelled && manageUrl) {
                lines.push(`To cancel or reschedule, visit: ${manageUrl}`);
            }

            const composed: Buffer = await new MailComposer({
                from: { name: bookingType.hostDisplayName, address: mailbox.primarySmtpAddress },
                to: booking.bookerEmail,
                subject: `${cancelled ? "Cancelled" : "Confirmed"}: ${bookingType.name}`,
                text: lines.join("\n"),
                icalEvent: { method: cancelled ? "cancel" : "request", content: buildEventIcs(event, cancelled ? "CANCEL" : "REQUEST") },
            })
                .compile()
                .build();
            await this.mailTransport!.send({
                raw: composed,
                envelopeFrom: mailbox.primarySmtpAddress,
                envelopeTo: [booking.bookerEmail],
            });
        } catch (err: any) {
            this.logger?.warn(`BookingRoute: failed to send booking mail for ${booking.uid}: ${err.message}`);
        }
    }

    @Summary("Retrieves the public details of a booking type.")
    @Description("Returns the publicly visible details of an enabled booking type. Requires no authentication.")
    @Get("/types/:slug")
    public async publicBookingType(@Param("slug") slug: string): Promise<PublicBookingType> {
        await this.init();
        return this.toPublicBookingType(await this.requireBookingType(slug));
    }

    @Summary("Lists the bookable slots for a booking type.")
    @Description(
        "Returns every slot the booking type's availability allows within the requested window that the host " +
            "is not already busy for. Requires no authentication.",
    )
    @Get("/types/:slug/slots")
    public async slots(
        @Param("slug") slug: string,
        @Query("from") from: string | undefined,
        @Query("to") to: string | undefined,
    ): Promise<OccurrenceWindow[]> {
        await this.init();
        const bookingType: BT = await this.requireBookingType(slug);

        const now: Date = new Date();
        const windowStart: Date = from ? this.requireDate(from, "from") : now;
        const windowEnd: Date = to ? this.requireDate(to, "to") : new Date(windowStart.getTime() + DEFAULT_SLOT_WINDOW_DAYS * MS_PER_DAY);

        const candidates: OccurrenceWindow[] = generateCandidateSlots(bookingType, windowStart, windowEnd, now);
        if (candidates.length === 0) {
            // Nothing the configuration allows, so nothing the calendar could possibly free up - skip the
            // busy-time queries entirely rather than paying for them to filter an empty list.
            return [];
        }

        const busyFrom: Date = new Date(candidates[0].start.getTime() - bookingType.bufferBeforeMinutes * 60_000);
        const busyTo: Date = new Date(candidates[candidates.length - 1].end.getTime() + bookingType.bufferAfterMinutes * 60_000);
        const events: CE[] = await this.findBusyEvents(bookingType.calendarFolderUid, busyFrom, busyTo);
        const busy: OccurrenceWindow[] = computeBusyWindows(events, busyFrom, busyTo);

        return subtractBusy(candidates, busy, bookingType.bufferBeforeMinutes, bookingType.bufferAfterMinutes);
    }

    @Summary("Books an appointment.")
    @Description(
        "Books the requested slot, creating a real calendar event on the host's calendar and emailing the " +
            "booker a confirmation containing their manage link. Requires no authentication.",
    )
    @RateLimit()
    @Post("/types/:slug")
    public async book(@Param("slug") slug: string, body: BookingRequestBody | undefined): Promise<PublicBooking> {
        await this.init();
        const bookingType: BT = await this.requireBookingType(slug);

        if (!body?.bookerName?.trim()) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'bookerName' is required.");
        }
        if (!body.bookerEmail || !EMAIL_PATTERN.test(body.bookerEmail.trim())) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'bookerEmail' must be a valid email address.");
        }
        const start: Date = this.requireDate(body.start, "start");
        const slot: OccurrenceWindow = await this.requireAvailableSlot(bookingType, start, new Date());

        const folder: F = await findOrCreateWellKnownFolder(this.folderRepo!, this.folderClass, bookingType.mailboxUid, FolderType.CALENDAR);
        const mailbox: M | undefined = await this.mailboxRepo!.findOne(bookingType.mailboxUid, { ignoreACL: true });
        if (!mailbox) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }

        const booking: B = await this.persistBooking(bookingType, folder, mailbox, slot, body);

        // Deliberately outside `persistBooking()`'s transaction: mailing a confirmation for a booking that
        // subsequently rolled back is not something a `try`/`catch` could take back.
        const event: CE | undefined = await this.calendarEventRepo!.findOne(booking.calendarEventUid, { ignoreACL: true });
        if (event) {
            await this.sendBookingMail(bookingType, booking, event, mailbox, false);
            await this.calendarEventRepo!.update(
                { uid: event.uid, version: (event as any).version, inviteSequenceSent: event.sequence } as any,
                event,
                { ignoreACL: true },
            );
        }

        return this.toPublicBooking(booking, bookingType, true);
    }

    @Summary("Retrieves a booking by its manage token.")
    @Description("Returns the booker's own view of their booking. Requires no authentication beyond the token itself.")
    @Get("/manage/:token")
    public async manage(@Param("token") token: string): Promise<PublicBooking> {
        await this.init();
        const booking: B = await this.requireBookingByToken(token);
        const bookingType: BT | undefined = await this.bookingTypeRepo!.findOne(booking.bookingTypeUid, { ignoreACL: true });
        if (!bookingType) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        return this.toPublicBooking(booking, bookingType, false);
    }

    @Summary("Cancels a booking.")
    @Description(
        "Cancels the booking identified by the manage token and marks its calendar event cancelled, which " +
            "causes MeetingSchedulingJob to send the iTIP cancellation. Requires no authentication beyond the token.",
    )
    @RateLimit()
    @Post("/manage/:token/cancel")
    public async cancel(@Param("token") token: string): Promise<PublicBooking> {
        await this.init();
        const booking: B = await this.requireBookingByToken(token);
        const bookingType: BT | undefined = await this.bookingTypeRepo!.findOne(booking.bookingTypeUid, { ignoreACL: true });
        if (!bookingType) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        if (booking.status === BookingStatus.CANCELLED) {
            // Idempotent - a booker who clicks their cancel link twice gets the same answer, not an error.
            return this.toPublicBooking(booking, bookingType, false);
        }

        const event: CE | undefined = await this.calendarEventRepo!.findOne(booking.calendarEventUid, { ignoreACL: true });
        if (event) {
            // `cancelNoticeSentAt` is deliberately left unset: `MeetingSchedulingJob.sendCancellations()` picks
            // up any CANCELLED event that hasn't had one and mails the iTIP CANCEL itself.
            await this.calendarEventRepo!.update(
                { uid: event.uid, version: (event as any).version, status: CalendarEventStatus.CANCELLED } as any,
                event,
                { ignoreACL: true },
            );
        }

        const updated: B = await this.bookingRepo!.update(
            { uid: booking.uid, version: (booking as any).version, status: BookingStatus.CANCELLED, cancelledAt: new Date() } as any,
            booking,
            { ignoreACL: true },
        );
        return this.toPublicBooking(updated, bookingType, false);
    }

    @Summary("Reschedules a booking.")
    @Description(
        "Moves the booking identified by the manage token to a new slot, which is validated against live " +
            "availability exactly as a fresh booking would be. Requires no authentication beyond the token.",
    )
    @RateLimit()
    @Post("/manage/:token/reschedule")
    public async reschedule(@Param("token") token: string, body: { start?: string } | undefined): Promise<PublicBooking> {
        await this.init();
        const booking: B = await this.requireBookingByToken(token);
        if (booking.status === BookingStatus.CANCELLED) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A cancelled booking cannot be rescheduled.");
        }

        const bookingType: BT | undefined = await this.bookingTypeRepo!.findOne(booking.bookingTypeUid, { ignoreACL: true });
        if (!bookingType || !bookingType.enabled) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }

        const start: Date = this.requireDate(body?.start, "start");
        const slot: OccurrenceWindow = await this.requireAvailableSlot(bookingType, start, new Date(), booking.calendarEventUid);

        const event: CE | undefined = await this.calendarEventRepo!.findOne(booking.calendarEventUid, { ignoreACL: true });
        const mailbox: M | undefined = await this.mailboxRepo!.findOne(booking.mailboxUid, { ignoreACL: true });
        if (event && mailbox) {
            // Bumping `sequence` past `inviteSequenceSent` is what marks this revision as needing to go out;
            // it is re-stamped below once the updated invite has actually been mailed.
            const moved: CE = await this.calendarEventRepo!.update(
                { uid: event.uid, version: (event as any).version, startDate: slot.start, endDate: slot.end, sequence: event.sequence + 1 } as any,
                event,
                { ignoreACL: true },
            );
            const updated: B = await this.bookingRepo!.update(
                { uid: booking.uid, version: (booking as any).version, startDate: slot.start, endDate: slot.end } as any,
                booking,
                { ignoreACL: true },
            );
            await this.sendBookingMail(bookingType, updated, moved, mailbox, false);
            await this.calendarEventRepo!.update(
                { uid: moved.uid, version: (moved as any).version, inviteSequenceSent: moved.sequence } as any,
                moved,
                { ignoreACL: true },
            );
            return this.toPublicBooking(updated, bookingType, false);
        }

        // The booking's event or host mailbox has been deleted out from under it - there is nothing coherent
        // left to reschedule.
        throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
    }
}
