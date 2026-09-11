///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory } from "@rapidrest/service-core";
import { buildEventIcs } from "../util/IcsUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { CalendarEvent, CalendarEventStatus } from "../models/types.js";
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
 * **Known limitation** (matching this codebase's existing "simplest correct-enough" precedent - see
 * `CalendarReminderJob`'s own doc comment for the same style): no per-attendee send-retry tracking. A
 * single bad attendee address doesn't block marking the whole event `inviteSequenceSent`/
 * `cancelNoticeSentAt` - it's logged and skipped, not retried indefinitely.
 *
 * Concrete entity classes are supplied by the Mongo/SQL subclasses (`MeetingSchedulingJobMongo`/
 * `MeetingSchedulingJobSQL`), following the same generic pattern `ScanQueueJob` uses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class MeetingSchedulingJob<CE extends CalendarEvent> extends BackgroundService {
    protected abstract calendarEventClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private calendarEventRepo?: RecoverableRepoUtils<CE>;

    @Inject("MailTransport")
    private mailTransport?: any;

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

        await this.sendInvites();
        await this.sendCancellations();
    }

    private async sendInvites(): Promise<void> {
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
                if (event.status === CalendarEventStatus.CANCELLED) {
                    continue;
                }
                if (event.inviteSequenceSent !== undefined && event.inviteSequenceSent === event.sequence) {
                    continue;
                }

                const ics = buildEventIcs(event, "REQUEST");
                for (const attendee of event.attendees) {
                    if (attendee.address.toLowerCase() === event.organizer.address.toLowerCase()) {
                        continue;
                    }
                    try {
                        await this.sendItipMail(event, ics, "request", attendee.address);
                    } catch (err: any) {
                        this.logger?.warn(`MeetingSchedulingJob: failed to send invite for event ${event.uid} to ${attendee.address}: ${err.message}`);
                    }
                }

                await this.calendarEventRepo!.update(
                    { uid: event.uid, version: (event as any).version, inviteSequenceSent: event.sequence } as any,
                    event,
                    { ignoreACL: true },
                );
            } catch (err: any) {
                this.logger?.warn(`MeetingSchedulingJob: failed to process invites for event ${event.uid}: ${err.message}`);
            }
        }
    }

    private async sendCancellations(): Promise<void> {
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
                if (!isRedundantOccurrenceCancel) {
                    const ics = buildEventIcs(event, "CANCEL");
                    for (const attendee of event.attendees) {
                        if (attendee.address.toLowerCase() === event.organizer.address.toLowerCase()) {
                            continue;
                        }
                        try {
                            await this.sendItipMail(event, ics, "cancel", attendee.address);
                        } catch (err: any) {
                            this.logger?.warn(`MeetingSchedulingJob: failed to send cancellation for event ${event.uid} to ${attendee.address}: ${err.message}`);
                        }
                    }
                }

                await this.calendarEventRepo!.update(
                    { uid: event.uid, version: (event as any).version, cancelNoticeSentAt: new Date() } as any,
                    event,
                    { ignoreACL: true },
                );
            } catch (err: any) {
                this.logger?.warn(`MeetingSchedulingJob: failed to process cancellation for event ${event.uid}: ${err.message}`);
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

        await this.mailTransport!.send({ raw: composed, envelopeFrom: event.organizer.address, envelopeTo: [to] });
    }
}
