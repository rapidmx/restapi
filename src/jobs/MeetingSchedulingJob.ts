///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { ObjectDecorators } from "@rapidrest/core";
import { ApiErrors, BackgroundService, ModelUtils, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import { ScanPipeline } from "../scan/ScanPipeline.js";
import { normalizeAddress } from "../util/AddressUtils.js";
import { buildEventIcs } from "../util/IcsUtils.js";
import { scanAndRelay } from "../util/MailSendUtils.js";
import { isPlainAddress, safeDisplayName } from "../util/MimeHeaderUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { sendOrThrow } from "../transport/TransportResultUtils.js";
import type { MailTransport, OutboundMessage, TransportResult } from "../transport/MailTransport.js";
import { Attendee, CalendarEvent, CalendarEventAttendeeLink, CalendarEventStatus, Mailbox } from "../models/types.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

/** A mailbox's own identity, as this job sends for it: its (lowercased) addresses and its safe display name. */
interface MailboxIdentity {
    addresses: Set<string>;
    displayName?: string;
}

/** A keyset position in `(dateModified, uid)` order. */
interface InviteCursor {
    dateModified: Date;
    uid: string;
}

/**
 * Sends outbound iTIP meeting-request/cancellation emails on behalf of an organizer: an organizer creates/
 * updates a `CalendarEvent` with attendees, and this job sends each one an iTIP `REQUEST` (`.ics` invite);
 * cancelling a meeting (deleting it, or setting `status: CANCELLED`) sends each attendee an iTIP `CANCEL`.
 * Composed via `nodemailer`'s `MailComposer` and sent through `scanAndRelay()`, the same scan gate user-composed mail
 * passes - the title, location and attendee list are the organizer's (or a device's) input, not system text.
 *
 * **What is mailed.** The `From` (and the iCalendar `ORGANIZER;CN`) carries the organizer's mailbox's own display name,
 * never the stored `organizer.displayName` (a REST client or ActiveSync device sets that), and no name at all when the
 * mailbox's is address-like (`safeDisplayName()`); attendee `CN`s get the same rule. Attendees must be plain addresses
 * (`isPlainAddress()`) - others are skipped, logged and left out of the iCalendar attendee list - and are
 * deduplicated. An event with more than `mail:jobs:meeting_scheduling:max_attendees` (500, the compose cap of mapi and
 * activesync) mailable attendees isn't mailed at all (logged as an error).
 *
 * **How many messages are composed.** One message is composed and scanned per *event* - and relayed to each attendee on
 * its own envelope - for an event with no linked video meeting (the overwhelmingly common case, unchanged), and on any
 * cancellation whatsoever. One message is composed, scanned and relayed per *attendee* only for a `REQUEST` on an event
 * that has one (`CalendarEvent.videoMeetingUid` set), because then each attendee's copy carries their own personalized
 * `LOCATION`. That personalization is generic and plugin-agnostic: this job looks the event's own
 * `CalendarEventAttendeeLink` rows up by `calendarEventUid` and matches each attendee by normalized address - it has no
 * knowledge of, and never imports, whichever plugin wrote them (a plugin depends on this library, never the reverse).
 * An attendee with no matching row simply gets the event's own plain stored `location`, exactly as before, and so does
 * everyone when the lookup itself fails or returns nothing (a deleted meeting, an uninstalled plugin, a database error -
 * all logged as a warning, none of them ever aborting the send). A `CANCEL` never needs a join link, so the cancellation
 * path never looks anything up and is unconditionally byte-for-byte what it always was.
 *
 * **Recurring meetings**: a master row (`recurrenceRule` set) and any single-occurrence override rows
 * sharing its `icalUid` (`recurrenceId` set) are each their own independent `CalendarEvent` row with their
 * own `sequence`/`inviteSequenceSent` - the per-row loop below handles a whole-series invite and a later
 * single-occurrence change (a new/updated override row) with no extra logic, and `buildEventIcs()` already
 * emits `RECURRENCE-ID` instead of `RRULE` for an override row. Cancellation is the one place this needs
 * explicit handling: cancelling a master row implies every one of its override rows too, so an override
 * row's own occurrence-level `CANCEL` is skipped (its `cancelNoticeSentAt` is still stamped, so it doesn't
 * linger as a candidate) whenever its master is *also* being cancelled in the same pass.
 *
 * **Organizer-owned rows only.** Every mailbox that receives an invite gets its own `CalendarEvent` row (created by
 * `ScanQueueJob`'s iTIP processing) carrying the *remote* organizer and the full attendee list. Only a row whose
 * `organizer.address` is one of its own mailbox's addresses (`primarySmtpAddress`/`aliasAddresses`,
 * case-insensitive) is sent for - anything else would impersonate that organizer to every attendee. A row that
 * isn't organizer-owned (or whose mailbox no longer exists) is still stamped `inviteSequenceSent`/
 * `cancelNoticeSentAt` so it drops out of the candidate set, but nothing is sent.
 *
 * **Claim, then send.** Each row is claimed by the optimistic-lock (versioned) update of `inviteSequenceSent`/
 * `cancelNoticeSentAt` *before* anything is sent, and only sent if that update succeeded - a version conflict means
 * another replica (or a concurrent edit) got there first, and the row is left for whoever holds the newer version.
 * Every per-attendee relay goes through `sendOrThrow()`, so a transport that reports a rejected recipient counts as a
 * failure.
 *
 * **Known limitation**: no per-attendee send-retry tracking. A failed send to one attendee is logged and the rest
 * still go out; the row stays claimed (not rolled back), so that attendee isn't retried - un-claiming would resend
 * to every attendee that did succeed. The same holds for a message the scan refuses, and for an event over the
 * attendee cap. On the per-attendee (personalized) path that "log and continue" now also covers a *scan* refusal of
 * one attendee's own message, not just a transport rejection: each attendee's compose, scan and relay is its own
 * attempt, so one refused copy no longer takes the whole event's send down with it (on the shared path, where a
 * single message is scanned once for everybody, a refusal still fails the whole event - there is only one message to
 * refuse).
 *
 * Concrete entity classes are supplied by the Mongo/SQL subclasses (`MeetingSchedulingJobMongo`/
 * `MeetingSchedulingJobSQL`), following the same generic pattern `ScanQueueJob` uses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class MeetingSchedulingJob<CE extends CalendarEvent> extends BackgroundService {
    protected abstract calendarEventClass: any;
    protected abstract mailboxClass: any;
    /** The `CalendarEventAttendeeLink` entity class - see this class's doc comment on personalization. */
    protected abstract attendeeLinkClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private calendarEventRepo?: RecoverableRepoUtils<CE>;
    private mailboxRepo?: RepoUtils<any>;
    private attendeeLinkRepo?: RepoUtils<any>;

    @Inject("MailTransport")
    private mailTransport?: MailTransport;

    @Inject(ScanPipeline)
    private scanPipeline?: ScanPipeline;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Config("mail:jobs:meeting_scheduling:schedule", "0 */5 * * * *")
    private scheduleExpr: string = "0 */5 * * * *";

    @Config("mail:jobs:meeting_scheduling:batch_size", 100)
    private batchSize: number = 100;

    /** Page budget per run for each invite keyset walk (see `sendInvites()`). */
    @Config("mail:jobs:meeting_scheduling:max_pages", 10)
    private maxPages: number = 10;

    /** How far behind "now" the live invite walk rewinds once caught up (see `sendInvites()`). */
    @Config("mail:jobs:meeting_scheduling:rescan_lag_seconds", 600)
    private rescanLagSeconds: number = 600;

    /** Most attendees one invite or cancellation is mailed to - see this class's doc comment. */
    @Config("mail:jobs:meeting_scheduling:max_attendees", 500)
    private maxAttendees: number = 500;

    private liveInviteCursor?: InviteCursor;
    private catchUpInviteCursor?: InviteCursor;
    private catchUpInviteUntilMs?: number;

    @Logger
    private logger: any;

    public get schedule(): string | undefined {
        return this.scheduleExpr;
    }

    @Init
    public async init(): Promise<void> {
        this.calendarEventRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
            name: this.calendarEventClass.name,
            args: [this.calendarEventClass],
        });
        this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.mailboxClass.name,
            args: [this.mailboxClass],
        });
        // Built here with the others because building it is cheap and query-free - it issues no query at all
        // until an event that actually has a linked video meeting is being invited to.
        this.attendeeLinkRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.attendeeLinkClass.name,
            args: [this.attendeeLinkClass],
        });
    }

    public async start(): Promise<void> {
        // Nothing to do at startup beyond `init()` above; processing happens entirely in `run()`.
    }

    public stop(): Promise<void> | void {
        // Do nothing
    }

    public async run(): Promise<void> {
        if (!this.calendarEventRepo) {
            return;
        }

        // Per-run cache of each mailbox's own identity, keyed by mailbox uid.
        const identities: Map<string, MailboxIdentity> = new Map();
        await this.sendInvites(identities);
        await this.sendCancellations(identities);
    }

    /** The owning mailbox's identity when `event`'s organizer is one of that mailbox's own addresses - i.e. this row is
     * the organizer's copy, not an attendee copy received from someone else; otherwise `undefined`. */
    private async organizerIdentity(event: CE, cache: Map<string, MailboxIdentity>): Promise<MailboxIdentity | undefined> {
        const organizerAddress: string = (event.organizer?.address ?? "").trim().toLowerCase();
        if (!organizerAddress || !event.mailboxUid) {
            return undefined;
        }
        let identity: MailboxIdentity | undefined = cache.get(event.mailboxUid);
        if (!identity) {
            const mailbox: Mailbox | undefined = await this.mailboxRepo?.findOne(event.mailboxUid, { ignoreACL: true });
            identity = {
                addresses: new Set(
                    (mailbox ? [mailbox.primarySmtpAddress, ...(mailbox.aliasAddresses ?? [])] : [])
                        .filter((address) => typeof address === "string")
                        .map((address) => address.trim().toLowerCase()),
                ),
                displayName: safeDisplayName(mailbox?.displayName),
            };
            cache.set(event.mailboxUid, identity);
        }
        return identity.addresses.has(organizerAddress) ? identity : undefined;
    }

    /** Applies `changes` with an optimistic-lock update. Returns `false` (instead of throwing) only for a version
     * conflict - someone else already claimed or changed the row. */
    private async claim(event: CE, changes: Partial<CalendarEvent>): Promise<boolean> {
        // `RepoUtils.find()` on the Mongo backend returns raw documents, not entity instances, and
        // `RepoUtils.update()` only enforces the optimistic lock when `existing instanceof BaseEntity` - otherwise
        // it silently falls back to an unversioned `updateOne({ uid })` (and `$set`s the stale `version` back).
        // Instantiating the model class first is what makes this a real compare-and-set on both backends.
        const existing: CE = event instanceof this.calendarEventClass ? event : new this.calendarEventClass(event);
        try {
            await this.calendarEventRepo!.update({ uid: existing.uid, version: (existing as any).version, ...changes } as any, existing, { ignoreACL: true });
            return true;
        } catch (err: any) {
            if (err?.code === ApiErrors.INVALID_OBJECT_VERSION) {
                return false;
            }
            throw err;
        }
    }

    /**
     * Reads the next page of invite candidates strictly after `cursor`, ordered by `(dateModified, uid)`.
     *
     * `inviteSequenceSent !== sequence` (the real eligibility check) is a field-to-field comparison the shared query
     * DSL can't express, so it stays a client-side filter - which is why this can't just be a "top `batchSize`"
     * query. Any fixed top-N window starves: an unsorted one is permanently occupied by whichever rows the DB
     * returns first, and a `-dateModified` one is permanently occupied by the rows *this job itself* just stamped
     * (every claim refreshes `dateModified`), so once more than `batchSize` rows need an invite the rest never get
     * one. Instead the job walks the table with a keyset cursor: every row modified after the cursor is visited
     * exactly once per edit, including a row this job stamped (it reappears once, past the cursor, and is filtered
     * out without being touched again - so the walk converges).
     *
     * `limit` must be passed both via `options` (used by the Mongo backend) *and* baked into the query object
     * itself (all `ModelUtils.buildSearchQuerySQL` reads - it ignores `options.limit` entirely).
     */
    private async readInvitePage(cursor: InviteCursor): Promise<CE[]> {
        const query: Record<string, any> = {
            status: `ne(${CalendarEventStatus.CANCELLED})`,
            sort: { dateModified: "ASC", uid: "ASC" },
            limit: this.batchSize,
        };
        const at: string = cursor.dateModified.toISOString();
        query.$or = [{ dateModified: `gt(${at})` }, { dateModified: `eq(${at})`, uid: `gt(${cursor.uid})` }];
        return await this.calendarEventRepo!.find(query as any, { ignoreACL: true, limit: this.batchSize });
    }

    /**
     * Two keyset walks, both in-memory per process:
     * - The **live** walk, which every run advances first: on a process's first run it starts `rescan_lag_seconds`
     * in the past, and persists across runs (a backlog larger than `max_pages` pages simply continues next run).
     * Once it catches up it rewinds to `rescan_lag_seconds` ago (never forward), so a row whose `dateModified` was
     * stamped slightly behind the cursor - clock skew between replicas, or a write that committed after a
     * later-stamped one was already read - is still seen by the next run.
     * - The one-off **catch-up** walk from the beginning of the table up to where the live walk started, so rows
     * that needed an invite before this process started (e.g. edited during an outage) are still handled - with
     * its own page budget, after the live walk, so a large table never delays a new invite.
     */
    private async sendInvites(identities: Map<string, MailboxIdentity>): Promise<void> {
        const lagMs: number = Number(this.rescanLagSeconds) * 1000;
        if (!this.liveInviteCursor) {
            this.liveInviteCursor = { dateModified: new Date(Date.now() - lagMs), uid: "" };
            this.catchUpInviteCursor = { dateModified: new Date(0), uid: "" };
            this.catchUpInviteUntilMs = this.liveInviteCursor.dateModified.getTime();
        }

        const live = await this.walkInvites(this.liveInviteCursor, identities);
        this.liveInviteCursor = live.cursor;
        if (live.exhausted) {
            const rewindTo: Date = new Date(Date.now() - lagMs);
            if (this.liveInviteCursor.dateModified.getTime() > rewindTo.getTime()) {
                this.liveInviteCursor = { dateModified: rewindTo, uid: "" };
            }
        }

        if (this.catchUpInviteCursor) {
            const catchUp = await this.walkInvites(this.catchUpInviteCursor, identities, this.catchUpInviteUntilMs);
            this.catchUpInviteCursor = catchUp.exhausted ? undefined : catchUp.cursor;
        }
    }

    /** Walks up to `max_pages` pages from `cursor`, processing each row (and stopping at the first row modified after
     * `untilMs`, when given). `exhausted` means the walk reached the end (or `untilMs`). */
    private async walkInvites(
        cursor: InviteCursor,
        identities: Map<string, MailboxIdentity>,
        untilMs?: number,
    ): Promise<{ cursor: InviteCursor; exhausted: boolean }> {
        for (let page = 0; page < Math.max(1, Number(this.maxPages)); page++) {
            let candidates: CE[] = await this.readInvitePage(cursor);
            const fullPage: boolean = candidates.length >= this.batchSize;
            let pastUntil: boolean = false;
            if (untilMs !== undefined) {
                const cut: number = candidates.findIndex((row) => new Date(row.dateModified).getTime() > untilMs);
                if (cut >= 0) {
                    candidates = candidates.slice(0, cut);
                    pastUntil = true;
                }
            }
            await this.processInviteCandidates(candidates, identities);
            if (candidates.length > 0) {
                const last: CE = candidates[candidates.length - 1];
                cursor = { dateModified: new Date(last.dateModified), uid: last.uid };
            }
            if (pastUntil || !fullPage) {
                return { cursor, exhausted: true };
            }
        }
        return { cursor, exhausted: false };
    }

    private async processInviteCandidates(candidates: CE[], identities: Map<string, MailboxIdentity>): Promise<void> {
        for (const event of candidates) {
            try {
                if (!event.attendees || event.attendees.length === 0) {
                    continue;
                }
                // Defense in depth only: `find()`'s own `status: ne(CANCELLED)` filter above already excludes
                // every candidate this could match, and this job's own test files use a real database (not a
                // mocked repo) - so short of a genuine cancel racing in in between the query and this loop
                // reaching the row (a timing window this test suite can't force deterministically), no test
                // can make this `continue` actually fire.
                /* v8 ignore next */
                if (event.status === CalendarEventStatus.CANCELLED) {
                    continue;
                }
                if (event.inviteSequenceSent !== undefined && event.inviteSequenceSent === event.sequence) {
                    continue;
                }

                const organizer: MailboxIdentity | undefined = await this.organizerIdentity(event, identities);

                // Claim first: only the replica whose versioned update wins may send.
                if (!(await this.claim(event, { inviteSequenceSent: event.sequence }))) {
                    continue;
                }

                // Not the organizer's own copy (an attendee copy of someone else's meeting): stamped above so it
                // drops out, never sent. And an event the organizer explicitly chose to send encrypted is entirely
                // the client's own responsibility to compose and send (see this repo's server-side scope boundary -
                // real sign/encrypt only ever happens client-side) - this job never composes a plaintext iTIP
                // REQUEST for it. Both are the same "skip the send, still mark handled" shape
                // `isRedundantOccurrenceCancel` below uses.
                if (!organizer || event.encryptionOrigin === "originated") {
                    continue;
                }

                await this.sendToAttendees(event, organizer, "request");
            } catch (err: any) {
                this.logger?.warn(`MeetingSchedulingJob: failed to process invites for event ${event.uid}: ${err.message}`);
            }
        }
    }

    private async sendCancellations(identities: Map<string, MailboxIdentity>): Promise<void> {
        // `find()` has no `includeDeleted` option (unlike `findOne()`) - a soft-deleted row is only ever
        // returned by explicitly querying `{ deleted: true }`, which `ModelUtils.buildSearchQuery()` honors
        // as a literal filter value rather than "include deleted rows too." So this runs two separate
        // queries (an active `status: CANCELLED` one, and a soft-deleted-regardless-of-status one) and
        // merges them, deduplicating by `uid` in case a row somehow matches both.
        //
        // `cancelNoticeSentAt: null` is the whole eligibility condition, and every row either query returns is
        // stamped below (sent or not), so handled rows leave the result set and each batch makes progress. That
        // includes attendee-less rows: they need no notice, but left unstamped they would refill every batch
        // forever and starve real cancellations. Ordered by `(dateModified, uid)` for a stable, oldest-first batch.
        const sort = { dateModified: "ASC", uid: "ASC" };
        const statusCancelled: CE[] = await this.calendarEventRepo!.find(
            { status: CalendarEventStatus.CANCELLED, cancelNoticeSentAt: null, sort, limit: this.batchSize } as any,
            { ignoreACL: true, limit: this.batchSize },
        );
        const softDeleted: CE[] = await this.calendarEventRepo!.find(
            { deleted: true, cancelNoticeSentAt: null, sort, limit: this.batchSize } as any,
            { ignoreACL: true, limit: this.batchSize },
        );
        const seenUids = new Set<string>();
        const cancelling: CE[] = [];
        for (const event of [...statusCancelled, ...softDeleted]) {
            if (!seenUids.has(event.uid)) {
                seenUids.add(event.uid);
                cancelling.push(event);
            }
        }
        const hasAttendees = (event: CE): boolean => !!event.attendees && event.attendees.length > 0;
        // Keyed per mailbox: an attendee's own copy of the same series (same `icalUid`, different mailbox) being
        // deleted in the same batch must not suppress the organizer's occurrence-level CANCEL.
        const seriesKey = (event: CE): string => `${event.mailboxUid}|${event.icalUid}`;
        const cancellingMasterIcalUids = new Set(cancelling.filter((event) => !event.recurrenceId && hasAttendees(event)).map(seriesKey));

        for (const event of cancelling) {
            try {
                if (!hasAttendees(event)) {
                    // Nothing to send - stamped only so it drops out of the candidate set (see above).
                    await this.claim(event, { cancelNoticeSentAt: new Date() });
                    continue;
                }
                const isRedundantOccurrenceCancel = !!event.recurrenceId && cancellingMasterIcalUids.has(seriesKey(event));
                // Same "client's own responsibility" reasoning as `sendInvites()` above - an encrypted
                // event's CANCEL is never composed/sent by this job either.
                const isClientManagedEncrypted = event.encryptionOrigin === "originated";
                const organizer: MailboxIdentity | undefined = await this.organizerIdentity(event, identities);

                // Claim first, same as `sendInvites()`.
                if (!(await this.claim(event, { cancelNoticeSentAt: new Date() }))) {
                    continue;
                }

                if (!isRedundantOccurrenceCancel && !isClientManagedEncrypted && organizer) {
                    await this.sendToAttendees(event, organizer, "cancel");
                }
            } catch (err: any) {
                this.logger?.warn(`MeetingSchedulingJob: failed to process cancellation for event ${event.uid}: ${err.message}`);
            }
        }
    }

    /**
     * Mails the event's iTIP `method` to every mailable attendee except the organizer (see this class's doc comment): one
     * message, composed as the organizer's mailbox identity and scanned once by `scanAndRelay()`, relayed to each
     * attendee on its own envelope. A failure for one attendee is logged and the rest still go out (see this class's doc
     * comment for why the row stays claimed); a refused scan, or no attendee accepting it, throws.
     *
     * The one exception is a `REQUEST` for an event carrying a `videoMeetingUid`, which is handed to
     * `sendPersonalizedInvites()` instead - see its own doc comment. Everything above it here (the plain-address filter,
     * the deduplication that also excludes the organizer's own address, the attendee cap, the "nobody left to mail"
     * early return) is shared by both paths and deliberately identical for them.
     */
    private async sendToAttendees(event: CE, organizer: MailboxIdentity, method: "request" | "cancel"): Promise<void> {
        const what: string = method === "cancel" ? "cancellation" : "invite";
        const seen: Set<string> = new Set([normalizeAddress(event.organizer.address)]);
        const recipients: string[] = [];
        const listed: Attendee[] = [];
        for (const attendee of event.attendees) {
            if (!attendee?.address) {
                continue;
            }
            if (!isPlainAddress(attendee.address)) {
                this.logger?.warn(`MeetingSchedulingJob: skipping an attendee of event ${event.uid} that isn't a plain address: ${JSON.stringify(String(attendee.address).slice(0, 100))}`);
                continue;
            }
            listed.push({ ...attendee, displayName: safeDisplayName(attendee.displayName) });
            const normalized: string = normalizeAddress(attendee.address);
            if (!seen.has(normalized)) {
                seen.add(normalized);
                recipients.push(attendee.address);
            }
        }
        if (recipients.length === 0) {
            return;
        }
        if (recipients.length > Number(this.maxAttendees)) {
            this.logger?.error(
                `MeetingSchedulingJob: not sending the ${what} for event ${event.uid} - it has ${recipients.length} attendees, more than the ${this.maxAttendees} allowed.`,
            );
            return;
        }

        // The only new branch on the way to a send, and the only one an event with no linked video meeting ever
        // evaluates: a plain field read of a row already in memory, no query. Everything below it - the whole
        // compose-once, fan-out-by-envelope path - is untouched, and is still what every cancellation takes too.
        if (method === "request" && event.videoMeetingUid) {
            await this.sendPersonalizedInvites(event, organizer, listed, recipients, what);
            return;
        }

        const mailed: CE = { ...event, organizer: { ...event.organizer, displayName: organizer.displayName }, attendees: listed };
        const ics: string = buildEventIcs(mailed, method === "cancel" ? "CANCEL" : "REQUEST");
        const composed: Buffer = await new MailComposer({
            from: organizer.displayName ? { name: organizer.displayName, address: event.organizer.address } : event.organizer.address,
            to: recipients,
            subject: method === "cancel" ? `Cancelled: ${event.title}` : `Invitation: ${event.title}`,
            text: method === "cancel" ? `This meeting has been cancelled: ${event.title}` : `You have been invited to: ${event.title}`,
            icalEvent: { method, content: ics },
        })
            .compile()
            .build();

        // One relay per attendee, each through `sendOrThrow()`; `scanAndRelay()` sees the whole fan-out as one send.
        const fanOut = {
            send: async (outbound: OutboundMessage): Promise<TransportResult> => {
                const result: TransportResult = { accepted: [], rejected: [] };
                for (const to of outbound.envelopeTo) {
                    try {
                        await sendOrThrow(this.mailTransport!, { ...outbound, envelopeTo: [to] });
                        result.accepted.push(to);
                    } catch (err: any) {
                        result.rejected.push(to);
                        this.logger?.warn(`MeetingSchedulingJob: failed to send ${what} for event ${event.uid} to ${to}: ${err.message}`);
                    }
                }
                return result;
            },
        };
        await scanAndRelay(composed, event.organizer.address, recipients, this.scanPipeline!, fanOut, this.blobStore!);
    }

    /**
     * Mails a `REQUEST` for an event with a linked video meeting: one message composed, scanned and relayed *per
     * attendee*, each carrying that attendee's own personalized link (their own `LOCATION`, and a line naming it in the
     * body) from this event's `CalendarEventAttendeeLink` rows - see this class's doc comment for why that lookup is
     * generic and knows nothing of whichever plugin wrote those rows.
     *
     * Every fallback here is graceful and per-attendee: a lookup that fails outright, one that returns nothing, and one
     * that returns rows for only some attendees all end in the same place - an attendee with no matching row gets the
     * event's own plain stored `location` and today's plain invite text, exactly what the shared path would have mailed
     * them. `recipients` is the shared, already-deduplicated recipient list, which never contains the organizer's own
     * address; a stray `CalendarEventAttendeeLink` row for the organizer therefore cannot cause a message to them, since
     * this only ever mails addresses that list already holds.
     */
    private async sendPersonalizedInvites(event: CE, organizer: MailboxIdentity, listed: Attendee[], recipients: string[], what: string): Promise<void> {
        const links: Map<string, { url: string; label?: string }> = new Map();
        try {
            // Bounded by the same cap the attendee list itself is bounded by - there can be no more useful rows
            // than there are attendees this job is willing to mail.
            const rows: CalendarEventAttendeeLink[] = await this.attendeeLinkRepo!.find(
                { calendarEventUid: ModelUtils.literal(event.uid), limit: Number(this.maxAttendees) } as any,
                { ignoreACL: true, limit: Number(this.maxAttendees) },
            );
            for (const row of rows) {
                links.set(normalizeAddress(row.attendeeAddress), { url: row.url, label: row.label });
            }
        } catch (err: any) {
            // Never abort the send over this: an empty map means every attendee falls back to the event's own
            // stored location, which is exactly what would have been mailed before personalization existed.
            this.logger?.warn(`MeetingSchedulingJob: failed to read personalized attendee links for event ${event.uid}: ${err.message}`);
        }

        // Each attendee's own relay, through `sendOrThrow()` exactly like the shared path's fan-out - a transport
        // that reports its one recipient as rejected still counts as a failure.
        const relay = {
            name: this.mailTransport!.name,
            send: async (outbound: OutboundMessage): Promise<TransportResult> => await sendOrThrow(this.mailTransport!, outbound),
        };
        // Identical for every copy - only the location and the body's link line differ per attendee.
        const from = organizer.displayName ? { name: organizer.displayName, address: event.organizer.address } : event.organizer.address;
        for (const to of recipients) {
            try {
                const link: { url: string; label?: string } | undefined = links.get(normalizeAddress(to));
                const mailed: CE = {
                    ...event,
                    organizer: { ...event.organizer, displayName: organizer.displayName },
                    attendees: listed,
                    location: link ? link.url : event.location,
                };
                const ics: string = buildEventIcs(mailed, "REQUEST");
                const composed: Buffer = await new MailComposer({
                    from,
                    to: [to],
                    subject: `Invitation: ${event.title}`,
                    text: link ? `You have been invited to: ${event.title}\n\nJoin the video call: ${link.url}` : `You have been invited to: ${event.title}`,
                    icalEvent: { method: "request", content: ics },
                })
                    .compile()
                    .build();
                await scanAndRelay(composed, event.organizer.address, [to], this.scanPipeline!, relay, this.blobStore!);
            } catch (err: any) {
                this.logger?.warn(`MeetingSchedulingJob: failed to send ${what} for event ${event.uid} to ${to}: ${err.message}`);
            }
        }
    }
}
