///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { ApiErrors, BackgroundService, NotificationUtils, ObjectFactory } from "@rapidrest/service-core";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { expandOccurrences, OccurrenceWindow } from "../util/IcsUtils.js";
import { CalendarEvent, CalendarEventStatus } from "../models/types.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

const MS_PER_MINUTE = 60 * 1000;
/** Safety net on how many `batch_size` pages of candidates one run will read per query. */
const MAX_PAGES = 50;

/**
 * Dispatches a `"reminder"` push notification (to the event's folder and mailbox channels) when an event
 * occurrence's reminder fire time (`occurrence start - reminderMinutesBeforeStart`) comes due.
 *
 * **Fire window.** Each run fires every occurrence whose fire time falls in `(watermark, now + window_seconds]`,
 * then advances the in-memory watermark to `now + window_seconds`. Firing up to `window_seconds` ahead keeps a
 * reminder from going out late by up to a whole schedule tick; the watermark means a run that was delayed
 * (scheduler drift, a slow previous run, an event-loop stall) still catches every fire time since the last run
 * instead of only looking at a fixed-width window. The watermark is per process: on a process's first run it
 * starts `initial_lookback_seconds` in the past, so a restart catches reminders that came due during a short
 * outage without replaying arbitrarily old ones.
 *
 * **Recurring events.** Masters (`recurrenceRule` set) are expanded through `expandOccurrences()` (in the event's
 * own time zone), excluding `RecurrenceRule.exceptions` and the `recurrenceId` of every sibling override row, which
 * fires its own reminder from its own row.
 *
 * **Candidates.** Non-recurring rows and override rows are read by `startDate` from the watermark up to
 * `now + window_seconds + max_lead_minutes`, paged in `batch_size` pages; recurring masters are read separately
 * (their `startDate` is the series start, not the next occurrence). A reminder set further ahead than
 * `max_lead_minutes` (default 14 days) on a non-recurring event is never picked up - raise the setting if such
 * reminders matter.
 *
 * **Exactly once across replicas.** Before sending, the job claims the occurrence by writing
 * `reminderSentFor = occurrence start` with an optimistic-lock (versioned) update. Only the replica whose update
 * wins sends; a replica that loses re-reads the row and retries once if the conflict came from an unrelated edit
 * rather than another replica's claim. The claim is written before the send, so a notification that then fails to
 * publish is logged and not retried (at-most-once, which suits a reminder).
 *
 * Concrete entity classes are supplied by the Mongo/SQL subclasses (`CalendarReminderJobMongo`/
 * `CalendarReminderJobSQL`), following the same generic pattern `ScanQueueJob` uses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class CalendarReminderJob<CE extends CalendarEvent> extends BackgroundService {
    protected abstract calendarEventClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private calendarEventRepo?: RecoverableRepoUtils<CE>;

    @Inject(NotificationUtils)
    private notificationUtils?: NotificationUtils;

    @Config("mail:jobs:calendar_reminder:schedule", "0 * * * * *")
    private scheduleExpr: string = "0 * * * * *";

    @Config("mail:jobs:calendar_reminder:batch_size", 200)
    private batchSize: number = 200;

    /** How far ahead of `now` a run fires reminders - normally the schedule's own interval. */
    @Config("mail:jobs:calendar_reminder:window_seconds", 60)
    private windowSeconds: number = 60;

    /** How far back a process's first run looks for reminders that came due while no run was happening. */
    @Config("mail:jobs:calendar_reminder:initial_lookback_seconds", 120)
    private initialLookbackSeconds: number = 120;

    /** The largest `reminderMinutesBeforeStart` the non-recurring candidate query is guaranteed to cover. */
    @Config("mail:jobs:calendar_reminder:max_lead_minutes", 20160)
    private maxLeadMinutes: number = 20160;

    @Logger
    private logger: any;

    /** Upper bound (epoch ms) of the fire window the previous successful run in this process covered. */
    private watermarkMs?: number;

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

        const nowMs: number = Date.now();
        const horizonMs: number = nowMs + Number(this.windowSeconds) * 1000;
        const lowerMs: number = Math.min(this.watermarkMs ?? nowMs - Number(this.initialLookbackSeconds) * 1000, horizonMs);

        const candidates: Map<string, CE> = new Map();
        // Non-recurring rows and single-occurrence overrides: an occurrence's start is never before its fire
        // time, so `startDate > lowerMs` is a safe lower bound; the upper bound is the longest lead we cover.
        // `limit` is passed both via `options` (Mongo) and in the query itself (SQL's `buildSearchQuerySQL` reads
        // only the query) - same for `page`.
        const upperStartMs: number = horizonMs + Number(this.maxLeadMinutes) * MS_PER_MINUTE;
        await this.readPages(
            { startDate: `gte(${new Date(lowerMs).toISOString()})`, reminderMinutesBeforeStart: "ne(null)", sort: "startDate" },
            (rows) => {
                let pastUpper = false;
                for (const row of rows) {
                    if (new Date(row.startDate).getTime() > upperStartMs) {
                        pastUpper = true;
                    } else {
                        candidates.set(row.uid, row);
                    }
                }
                return pastUpper;
            },
        );
        // Recurring masters: `startDate` is the series start, so they can't be narrowed by it.
        await this.readPages({ recurrenceRule: "ne(null)", reminderMinutesBeforeStart: "ne(null)", sort: "startDate" }, (rows) => {
            for (const row of rows) {
                candidates.set(row.uid, row);
            }
            return false;
        });

        for (const event of candidates.values()) {
            try {
                await this.processEvent(event, lowerMs, horizonMs);
            } catch (err: any) {
                this.logger?.warn(`CalendarReminderJob: failed to process reminder for event ${event.uid}: ${err.message}`);
            }
        }

        this.watermarkMs = horizonMs;
    }

    private async readPages(query: Record<string, any>, consume: (rows: CE[]) => boolean): Promise<void> {
        for (let page = 0; page < MAX_PAGES; page++) {
            const rows: CE[] = await this.calendarEventRepo!.find({ ...query, limit: this.batchSize, page } as any, {
                ignoreACL: true,
                limit: this.batchSize,
                page,
            });
            const stop: boolean = consume(rows);
            if (stop || rows.length < this.batchSize) {
                return;
            }
        }
        this.logger?.warn(`CalendarReminderJob: candidate query ${JSON.stringify(query)} exceeded ${MAX_PAGES} pages; remaining rows skipped this run.`);
    }

    private async processEvent(event: CE, lowerMs: number, horizonMs: number): Promise<void> {
        const reminderMinutes = event.reminderMinutesBeforeStart;
        if (reminderMinutes === undefined || reminderMinutes === null || Number(reminderMinutes) < 0 || event.status === CalendarEventStatus.CANCELLED) {
            return;
        }
        const leadMs: number = Number(reminderMinutes) * MS_PER_MINUTE;
        const isMaster: boolean = !!event.recurrenceRule && !event.recurrenceId;

        let excludeDates: (Date | string)[] | undefined;
        if (isMaster) {
            excludeDates = [...(event.recurrenceRule?.exceptions ?? [])];
        }
        // Only occurrence *starts* matter here, so expand as zero-length occurrences: `expandOccurrences()`'s
        // overlap test then reduces to `windowStart < start < windowEnd` (hence the 1ms on the inclusive end), and a
        // row with a missing/inverted `endDate` can't hide its reminder.
        const windowStart = new Date(lowerMs + leadMs);
        const windowEnd = new Date(horizonMs + leadMs + 1);
        const expand = (): OccurrenceWindow[] =>
            expandOccurrences(
                {
                    startDate: event.startDate,
                    endDate: event.startDate,
                    // An override row is a single concrete occurrence - never re-expand it by an inherited rule.
                    recurrenceRule: isMaster ? event.recurrenceRule : undefined,
                    timezone: event.timezone,
                    allDay: event.allDay,
                },
                windowStart,
                windowEnd,
                excludeDates,
            ).filter((occurrence) => {
                const fireAtMs = occurrence.start.getTime() - leadMs;
                return fireAtMs > lowerMs && fireAtMs <= horizonMs;
            });

        let due: OccurrenceWindow[] = expand();
        if (due.length === 0) {
            return;
        }
        if (isMaster) {
            // Only worth the extra query once an occurrence is actually due: a sibling override row represents
            // that occurrence itself (and fires its own reminder from its own row).
            const overrides: CE[] = await this.calendarEventRepo!.find(
                { icalUid: event.icalUid, mailboxUid: event.mailboxUid, recurrenceId: "ne(null)", limit: 1000 } as any,
                { ignoreACL: true, limit: 1000 },
            );
            excludeDates!.push(...overrides.filter((row) => row.uid !== event.uid && row.recurrenceId).map((row) => row.recurrenceId!));
            due = expand();
            if (due.length === 0) {
                return;
            }
        }

        // Only the latest due occurrence gets a notification - after downtime there's no value in a burst of stale
        // reminders for the same series.
        const occurrence: OccurrenceWindow = due[due.length - 1];
        if (!(await this.claim(event, occurrence.start, isMaster))) {
            return;
        }
        this.notificationUtils?.sendMessage([event.folderUid, event.mailboxUid], "CalendarEvent", "reminder", {
            eventUid: event.uid,
            title: event.title,
            startDate: occurrence.start,
        });
    }

    /** `true` if `occurrenceStart` has already had its reminder claimed on `event`. */
    private alreadySent(event: CE, occurrenceStart: Date, isMaster: boolean): boolean {
        if (event.reminderSentFor === undefined || event.reminderSentFor === null) {
            return false;
        }
        const sentMs: number = new Date(event.reminderSentFor).getTime();
        // A recurring series only ever moves forward. A single event can be rescheduled earlier or later, and
        // either way its new start deserves a reminder.
        return isMaster ? occurrenceStart.getTime() <= sentMs : occurrenceStart.getTime() === sentMs;
    }

    /**
     * Claims `occurrenceStart`'s reminder with a versioned update of `reminderSentFor`. Returns `false` if it was
     * already claimed (possibly by another replica). On a version conflict, re-reads the row once: if the fresh
     * row is already claimed another replica won; otherwise the conflict came from an unrelated edit, so retry.
     */
    private async claim(event: CE, occurrenceStart: Date, isMaster: boolean): Promise<boolean> {
        let current: CE | undefined = event;
        for (let attempt = 0; attempt < 2 && current; attempt++) {
            if (this.alreadySent(current, occurrenceStart, isMaster)) {
                return false;
            }
            // `RepoUtils.find()` on the Mongo backend returns raw documents, and `RepoUtils.update()` only enforces
            // the optimistic lock when `existing instanceof BaseEntity` - otherwise it silently does an unversioned
            // `updateOne({ uid })`. Instantiating the model class is what makes the claim a real compare-and-set.
            const existing: CE = current instanceof this.calendarEventClass ? current : new this.calendarEventClass(current);
            try {
                await this.calendarEventRepo!.update(
                    { uid: existing.uid, version: (existing as any).version, reminderSentFor: occurrenceStart } as any,
                    existing,
                    // The marker is job bookkeeping, not a user-visible change - don't broadcast an "update" push.
                    { ignoreACL: true, skipPush: true },
                );
                return true;
            } catch (err: any) {
                if (err?.code !== ApiErrors.INVALID_OBJECT_VERSION) {
                    throw err;
                }
                current = await this.calendarEventRepo!.findOne(current.uid, { ignoreACL: true });
            }
        }
        return false;
    }
}
