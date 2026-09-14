///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { ObjectDecorators } from "@rapidrest/core";
import { ApiErrors, BackgroundService, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { buildEventIcs } from "../util/IcsUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { sendOrThrow } from "../transport/TransportResultUtils.js";
import type { MailTransport } from "../transport/MailTransport.js";
import { CalendarEvent, CalendarEventStatus, Mailbox } from "../models/types.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

/** A keyset position in `(dateModified, uid)` order. */
interface InviteCursor {
    dateModified: Date;
    uid: string;
}

/**
 * Sends outbound iTIP meeting-request/cancellation emails on behalf of an organizer: an organizer creates/
 * updates a `CalendarEvent` with attendees, and this job sends each one an iTIP `REQUEST` (`.ics` invite);
 * cancelling a meeting (deleting it, or setting `status: CANCELLED`) sends each attendee an iTIP `CANCEL`.
 * Composed via `nodemailer`'s `MailComposer` and relayed directly through `MailTransport` - bypasses
 * `scanAndRelay()` (system-generated content, not user-composed `Message.bodyBlobKey` MIME, same bypass
 * `ScanQueueJob.maybeSendAutoReply()` already uses for the same reason).
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
 * Every send goes through `sendOrThrow()`, so a transport that reports a rejected recipient counts as a failure.
 *
 * **Known limitation**: no per-attendee send-retry tracking. A failed send to one attendee is logged and the rest
 * still go out; the row stays claimed (not rolled back), so that attendee isn't retried - un-claiming would resend
 * to every attendee that did succeed.
 *
 * Concrete entity classes are supplied by the Mongo/SQL subclasses (`MeetingSchedulingJobMongo`/
 * `MeetingSchedulingJobSQL`), following the same generic pattern `ScanQueueJob` uses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class MeetingSchedulingJob<CE extends CalendarEvent> extends BackgroundService {
    protected abstract calendarEventClass: any;
    protected abstract mailboxClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private calendarEventRepo?: RecoverableRepoUtils<CE>;
    private mailboxRepo?: RepoUtils<any>;

    @Inject("MailTransport")
    private mailTransport?: MailTransport;

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

        // Per-run cache of each mailbox's own (lowercased) addresses, keyed by mailbox uid.
        const ownAddresses: Map<string, Set<string>> = new Map();
        await this.sendInvites(ownAddresses);
        await this.sendCancellations(ownAddresses);
    }

    /** `true` if `event`'s organizer is one of its owning mailbox's own addresses - i.e. this row is the organizer's
     * copy, not an attendee copy received from someone else. */
    private async isOrganizerCopy(event: CE, cache: Map<string, Set<string>>): Promise<boolean> {
        const organizerAddress: string = (event.organizer?.address ?? "").trim().toLowerCase();
        if (!organizerAddress || !event.mailboxUid) {
            return false;
        }
        let addresses: Set<string> | undefined = cache.get(event.mailboxUid);
        if (!addresses) {
            const mailbox: Mailbox | undefined = await this.mailboxRepo?.findOne(event.mailboxUid, { ignoreACL: true });
            addresses = new Set(
                (mailbox ? [mailbox.primarySmtpAddress, ...(mailbox.aliasAddresses ?? [])] : [])
                    .filter((address) => typeof address === "string")
                    .map((address) => address.trim().toLowerCase()),
            );
            cache.set(event.mailboxUid, addresses);
        }
        return addresses.has(organizerAddress);
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
    private async sendInvites(ownAddresses: Map<string, Set<string>>): Promise<void> {
        const lagMs: number = Number(this.rescanLagSeconds) * 1000;
        if (!this.liveInviteCursor) {
            this.liveInviteCursor = { dateModified: new Date(Date.now() - lagMs), uid: "" };
            this.catchUpInviteCursor = { dateModified: new Date(0), uid: "" };
            this.catchUpInviteUntilMs = this.liveInviteCursor.dateModified.getTime();
        }

        const live = await this.walkInvites(this.liveInviteCursor, ownAddresses);
        this.liveInviteCursor = live.cursor;
        if (live.exhausted) {
            const rewindTo: Date = new Date(Date.now() - lagMs);
            if (this.liveInviteCursor.dateModified.getTime() > rewindTo.getTime()) {
                this.liveInviteCursor = { dateModified: rewindTo, uid: "" };
            }
        }

        if (this.catchUpInviteCursor) {
            const catchUp = await this.walkInvites(this.catchUpInviteCursor, ownAddresses, this.catchUpInviteUntilMs);
            this.catchUpInviteCursor = catchUp.exhausted ? undefined : catchUp.cursor;
        }
    }

    /** Walks up to `max_pages` pages from `cursor`, processing each row (and stopping at the first row modified after
     * `untilMs`, when given). `exhausted` means the walk reached the end (or `untilMs`). */
    private async walkInvites(
        cursor: InviteCursor,
        ownAddresses: Map<string, Set<string>>,
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
            await this.processInviteCandidates(candidates, ownAddresses);
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

    private async processInviteCandidates(candidates: CE[], ownAddresses: Map<string, Set<string>>): Promise<void> {
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

                const isOrganizerCopy: boolean = await this.isOrganizerCopy(event, ownAddresses);

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
                if (!isOrganizerCopy || event.encryptionOrigin === "originated") {
                    continue;
                }

                const ics = buildEventIcs(event, "REQUEST");
                await this.sendToAttendees(event, ics, "request");
            } catch (err: any) {
                this.logger?.warn(`MeetingSchedulingJob: failed to process invites for event ${event.uid}: ${err.message}`);
            }
        }
    }

    private async sendCancellations(ownAddresses: Map<string, Set<string>>): Promise<void> {
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
                const isOrganizerCopy: boolean = await this.isOrganizerCopy(event, ownAddresses);

                // Claim first, same as `sendInvites()`.
                if (!(await this.claim(event, { cancelNoticeSentAt: new Date() }))) {
                    continue;
                }

                if (!isRedundantOccurrenceCancel && !isClientManagedEncrypted && isOrganizerCopy) {
                    const ics = buildEventIcs(event, "CANCEL");
                    await this.sendToAttendees(event, ics, "cancel");
                }
            } catch (err: any) {
                this.logger?.warn(`MeetingSchedulingJob: failed to process cancellation for event ${event.uid}: ${err.message}`);
            }
        }
    }

    /** Sends `ics` to every attendee except the organizer. A failure for one attendee is logged and the rest
     * still go out (see this class's doc comment for why the row stays claimed). */
    private async sendToAttendees(event: CE, ics: string, method: "request" | "cancel"): Promise<void> {
        for (const attendee of event.attendees) {
            if (!attendee?.address || attendee.address.toLowerCase() === event.organizer.address.toLowerCase()) {
                continue;
            }
            try {
                await this.sendItipMail(event, ics, method, attendee.address);
            } catch (err: any) {
                const what = method === "cancel" ? "cancellation" : "invite";
                this.logger?.warn(`MeetingSchedulingJob: failed to send ${what} for event ${event.uid} to ${attendee.address}: ${err.message}`);
            }
        }
    }

    private async sendItipMail(event: CE, ics: string, method: "request" | "cancel", to: string): Promise<void> {
        const subject = method === "cancel" ? `Cancelled: ${event.title}` : `Invitation: ${event.title}`;
        const composed: Buffer = await new MailComposer({
            from: { name: event.organizer.displayName, address: event.organizer.address },
            to,
            subject,
            text: method === "cancel" ? `This meeting has been cancelled: ${event.title}` : `You have been invited to: ${event.title}`,
            icalEvent: { method, content: ics },
        })
            .compile()
            .build();

        await sendOrThrow(this.mailTransport!, { raw: composed, envelopeFrom: event.organizer.address, envelopeTo: [to] });
    }
}
