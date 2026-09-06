///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory } from "@rapidrest/service-core";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { CalendarEvent } from "../models/types.js";
const { Config, Init, Logger } = ObjectDecorators;

/**
 * Scheduled placeholder for outbound iTIP meeting-request processing: an organizer creates/updates a
 * `CalendarEvent` with attendees, and an iTIP `REQUEST` email needs to go out to each attendee.
 *
 * TODO: Full iTIP send/response processing is deferred pending (1) an `IcsUtils` helper for composing RFC 5546
 * iTIP messages/ICS payloads, which does not exist in this codebase yet, and (2) a persisted `CalendarEvent`
 * invite-tracking field (there is currently no way to tell "attendees were already invited" apart from
 * "attendees were just added and haven't been invited yet"). Inventing either of those here would just have to
 * be redone once the real implementations land. This job currently exists purely as a scheduled placeholder so
 * the surrounding plumbing (config, DI, `jobs/index.ts` registration) is already in place when that follow-up
 * work is ready - `run()` only finds and logs candidate events, it does not compose or send anything.
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

        // `attendees.length > 0` can't be pushed into the shared `find()` query DSL (array-length queries are
        // backend-specific), so this fetches a batch and filters in-process, same as the other simplicity
        // trade-offs this job's siblings make.
        //
        // `limit` must be passed both via `options` (used by the Mongo backend) *and* baked into the query
        // object itself (all `ModelUtils.buildSearchQuerySQL` reads - it ignores `options.limit` entirely and
        // falls back to its own default of 100 otherwise). Confirmed by real-database testing: on the SQL
        // backend, `options.limit` alone silently caps at 100 regardless of the configured batch size.
        const candidates: CE[] = await this.calendarEventRepo.find(
            { limit: this.batchSize } as any,
            { ignoreACL: true, limit: this.batchSize },
        );

        let needingInvite = 0;
        for (const event of candidates) {
            try {
                if (event.attendees && event.attendees.length > 0) {
                    needingInvite++;
                }
            } catch (err: any) {
                /* v8 ignore next -- unreachable via real data: `event.attendees` round-trips through Mongo
                   BSON or a SQL `simple-json` column as a plain array or is absent entirely; no real write
                   path can produce a value that survives `find()` yet throws on `&&`/`.length` here. */
                this.logger?.warn(`MeetingSchedulingJob: failed to inspect event ${event.uid}: ${err.message}`);
            }
        }

        // TODO: Once `IcsUtils` and an invite-tracking field exist, replace this log line with actual iTIP
        // REQUEST composition/send per candidate event (and mark each as invited so it isn't re-selected).
        this.logger?.debug(
            `MeetingSchedulingJob: found ${needingInvite} candidate event(s) with attendees needing outbound iTIP processing (not yet implemented).`,
        );
    }
}
