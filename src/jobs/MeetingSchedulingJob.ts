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

    private async sendInvites(ownAddresses: Map<string, Set<string>>): Promise<void> {
        // `limit` must be passed both via `options` (used by the Mongo backend) *and* baked into the query
        // object itself (all `ModelUtils.buildSearchQuerySQL` reads - it ignores `options.limit` entirely and
        // falls back to its own default of 100 otherwise). Confirmed by real-database testing: on the SQL
        // backend, `options.limit` alone silently caps at 100 regardless of the configured batch size.
        //
        // `inviteSequenceSent !== sequence` (the real eligibility check) is a field-to-field comparison the
        // shared query DSL can't express, so it stays a client-side filter below - but an unfiltered,
        // unsorted `find()` meant that once total `CalendarEvent` rows exceeded `batchSize`, whichever fixed
        // set of rows the DB happened to return first (typically the oldest, by insertion order) permanently
        // occupied the whole window, silently starving any event that needed an invite. `status: ne(CANCELLED)`
        // prunes the (usually large) share of rows that can never need an invite, and `sort: -dateModified`
        // guarantees a genuinely new or just-edited event - which always has the most recent `dateModified`,
        // since `RepoUtils.update()` unconditionally refreshes it - sorts to the front of the window ahead of
        // old, already-fully-processed rows, rather than being starved behind them.
        const candidates: CE[] = await this.calendarEventRepo!.find(
            { status: `ne(${CalendarEventStatus.CANCELLED})`, sort: "-dateModified", limit: this.batchSize } as any,
            { ignoreACL: true, limit: this.batchSize },
        );

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
        const statusCancelled: CE[] = await this.calendarEventRepo!.find(
            { status: CalendarEventStatus.CANCELLED, cancelNoticeSentAt: null, limit: this.batchSize } as any,
            { ignoreACL: true, limit: this.batchSize },
        );
        const softDeleted: CE[] = await this.calendarEventRepo!.find(
            { deleted: true, cancelNoticeSentAt: null, limit: this.batchSize } as any,
            { ignoreACL: true, limit: this.batchSize },
        );
        const seenUids = new Set<string>();
        const cancelling: CE[] = [];
        for (const event of [...statusCancelled, ...softDeleted]) {
            if (!seenUids.has(event.uid) && event.attendees && event.attendees.length > 0) {
                seenUids.add(event.uid);
                cancelling.push(event);
            }
        }
        const cancellingMasterIcalUids = new Set(cancelling.filter((event) => !event.recurrenceId).map((event) => event.icalUid));

        for (const event of cancelling) {
            try {
                const isRedundantOccurrenceCancel = !!event.recurrenceId && cancellingMasterIcalUids.has(event.icalUid);
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
