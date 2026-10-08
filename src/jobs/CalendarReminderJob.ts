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

/** The two alarms of an occurrence: the lead-time reminder and the alarm at the occurrence start itself. */
type AlarmKind = "reminder" | "start";

/** How far past a run's fire window `processEvent()` looks for a recurring master's next occurrence, to remember when it is next due. */
const NEXT_REMINDER_LOOKAHEAD_MS = 400 * 24 * 60 * MS_PER_MINUTE;

/**
 * Dispatches a `"reminder"` push notification (to the event's folder and mailbox channels) when an alarm of an
 * event occurrence comes due. Every occurrence has up to two alarms, each sent as the same `"reminder"` push:
 * the REMINDER at `occurrence start - reminderMinutesBeforeStart` (only when that is set and greater than 0) and
 * the START alarm at the occurrence start itself - so an event alarms at its start even with no reminder at all.
 * A lead of `0` makes the two coincide: it fires once, as the reminder. Cancelled events never alarm, and the
 * START alarm is skipped for `allDay` events (their start is midnight; an all-day event's reminder still fires).
 * The payload carries
 * the event's own `location` verbatim (`{ eventUid, title, startDate, location }`) - plain, undecorated text a
 * client is free to read as a join link when it looks like one (e.g. a video-conferencing URL), same as anywhere
 * else `location` is already shown as-is. Not actually encrypted today regardless of `encryptionOrigin` (see that
 * field's own doc comment on `CalendarEvent` - field-level encryption of `location` is deferred, future work), so
 * there is nothing to decrypt here.
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
 * fires its own alarms from its own row.
 *
 * **Candidates.** Every event is a candidate whether or not it has a reminder (it alarms at its start regardless).
 * Non-recurring rows and override rows are read by `startDate` from the watermark up to
 * `now + window_seconds + max_lead_minutes`, keyset-paged on `(startDate, uid)` in `batch_size` pages; recurring
 * masters are read separately (their `startDate` is the series start, not the next occurrence), narrowed to
 * non-cancelled masters starting before that same upper bound, and skipped before expansion when their
 * `recurrenceRule.until` has already passed. There is no page cap: every candidate is read each run. A reminder set further ahead than
 * `max_lead_minutes` (default 14 days) on a non-recurring event is never picked up (its start alarm still is) -
 * raise the setting if such reminders matter.
 *
 * **Exactly once across replicas.** Before sending, the job claims the occurrence by writing the kind's marker
 * (`reminderSentFor` for the reminder, `startAlarmSentFor` for the start alarm) `= occurrence start` with an
 * optimistic-lock (versioned) update. The two kinds are processed sequentially (reminder first), each with its own claim. Only the replica whose update
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

    protected calendarEventRepo?: RecoverableRepoUtils<CE>;

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

    /** Per recurring master and alarm kind (`${uid}:reminder` / `${uid}:start`): the row version it was expanded at, and the earliest time
     * that alarm of it can next be due - see `processKind()`. In memory and per process, so a restart simply expands every master once more. */
    private nextDue: Map<string, { version: number; notBeforeMs: number }> = new Map();

    public get schedule(): string | undefined {
        return this.scheduleExpr;
    }

    @Init
    public async init(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.calendarEventRepo && this.calendarEventClass) {
            this.calendarEventRepo = await this._objectFactory.newInstance(RecoverableRepoUtils, {
                name: this.calendarEventClass.name,
                args: [this.calendarEventClass],
            });
        }
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
        await this.readKeyset(
            {},
            "startDate",
            new Date(lowerMs),
            (rows) => {
                for (const row of rows) {
                    if (new Date(row.startDate).getTime() > upperStartMs) {
                        return true;
                    }
                    candidates.set(row.uid, row);
                }
                return false;
            },
        );
        // Recurring masters: `startDate` is the series start, so it only bounds them from above (a series can't have
        // an occurrence before it starts). A series whose `recurrenceRule.until` is already before the fire window
        // can't have a due occurrence either, but `recurrenceRule` is a JSON column on SQL that the query DSL can't
        // filter into, so that check is client-side - before any (potentially long) occurrence expansion.
        await this.readKeyset(
            {
                recurrenceRule: "ne(null)",
                recurrenceId: null,
                status: `ne(${CalendarEventStatus.CANCELLED})`,
                startDate: `lte(${new Date(upperStartMs).toISOString()})`,
            },
            undefined,
            undefined,
            (rows) => {
                for (const row of rows) {
                    const until: any = row.recurrenceRule?.until;
                    if (until !== undefined && until !== null && new Date(until).getTime() < lowerMs) {
                        continue;
                    }
                    candidates.set(row.uid, row);
                }
                return false;
            },
        );

        for (const event of candidates.values()) {
            try {
                await this.processEvent(event, lowerMs, horizonMs);
            } catch (err: any) {
                this.logger?.warn(`CalendarReminderJob: failed to process reminder for event ${event.uid}: ${err.message}`);
            }
        }

        // A master that is no longer a candidate (ended, cancelled, deleted) needs no remembered time.
        for (const key of this.nextDue.keys()) {
            if (!candidates.has(key.slice(0, key.lastIndexOf(":")))) {
                this.nextDue.delete(key);
            }
        }

        this.watermarkMs = horizonMs;
    }

    /**
     * Reads every row matching `query` in `batch_size` pages, by keyset rather than offset: ordered by
     * `(field, uid)` when `field` is given (else by `uid` alone), each page continuing strictly after the previous
     * page's last row. Unlike offset paging, rows sharing the same `field` value can't be skipped or repeated
     * across a page boundary, and there's no page cap - every matching row is read (until `consume` returns `true`).
     *
     * `firstPageLowerBound` is the first page's inclusive lower bound on `field` (required when `field` is). `limit` is
     * passed both via `options` (Mongo) and in the query itself (SQL's `buildSearchQuerySQL` reads only the query).
     */
    private async readKeyset(
        query: Record<string, any>,
        field: "startDate" | undefined,
        firstPageLowerBound: Date | undefined,
        consume: (rows: CE[]) => boolean,
    ): Promise<void> {
        let last: CE | undefined;
        for (;;) {
            const pageQuery: Record<string, any> = {
                ...query,
                sort: field ? { [field]: "ASC", uid: "ASC" } : { uid: "ASC" },
                limit: this.batchSize,
            };
            if (!field) {
                if (last) {
                    pageQuery.uid = `gt(${last.uid})`;
                }
            } else if (!last) {
                pageQuery[field] = `gte(${firstPageLowerBound!.toISOString()})`;
            } else {
                const at: string = new Date((last as any)[field]).toISOString();
                pageQuery.$or = [{ [field]: `gt(${at})` }, { [field]: `eq(${at})`, uid: `gt(${last.uid})` }];
            }
            const rows: CE[] = await this.calendarEventRepo!.find(pageQuery as any, { ignoreACL: true, limit: this.batchSize });
            if (consume(rows) || rows.length < this.batchSize) {
                return;
            }
            last = rows[rows.length - 1];
        }
    }

    /** The starts of `event`'s occurrences inside `(windowStart, windowEnd)`, as zero-length occurrences. */
    private expandStarts(event: CE, isMaster: boolean, excludeDates: (Date | string)[] | undefined, windowStart: Date, windowEnd: Date): OccurrenceWindow[] {
        return expandOccurrences(
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
        );
    }

    private async processEvent(event: CE, lowerMs: number, horizonMs: number): Promise<void> {
        if (event.status === CalendarEventStatus.CANCELLED) {
            return;
        }
        const minutes = event.reminderMinutesBeforeStart;
        const lead: number = minutes === undefined || minutes === null ? -1 : Number(minutes);
        // Sequential on purpose: the second claim must see the row version the first claim's update produced.
        if (lead >= 0) {
            // A lead of 0 is the reminder at the start itself - the one alarm of that occurrence.
            await this.processKind(event, "reminder", lead * MS_PER_MINUTE, lowerMs, horizonMs);
        }
        // An all-day event's "start" is midnight - not an alarm anyone wants; with a lead of 0 the reminder already is the start alarm.
        if (lead !== 0 && !event.allDay) {
            await this.processKind(event, "start", 0, lowerMs, horizonMs);
        }
    }

    /** Fires `event`'s due alarm of `kind` (if any) - `leadMs` is how long before the occurrence start it fires. */
    private async processKind(event: CE, kind: AlarmKind, leadMs: number, lowerMs: number, horizonMs: number): Promise<void> {
        const marker: string = kind === "reminder" ? "reminderSentFor" : "startAlarmSentFor";
        const cacheKey = `${event.uid}:${kind}`;
        const isMaster: boolean = !!event.recurrenceRule && !event.recurrenceId;

        // A master whose next alarm was found, on an earlier run, to be further away than this run's window is not expanded
        // again until then (expanding a series is the costly part of every run, done on the event loop) - unless its row has
        // changed since, which makes what was remembered stale.
        const remembered: { version: number; notBeforeMs: number } | undefined = isMaster ? this.nextDue.get(cacheKey) : undefined;
        if (remembered && remembered.version === (event as any).version && horizonMs < remembered.notBeforeMs) {
            return;
        }

        let excludeDates: (Date | string)[] | undefined;
        if (isMaster) {
            excludeDates = [...(event.recurrenceRule?.exceptions ?? [])];
        }
        // Only occurrence *starts* matter here, so expand as zero-length occurrences: `expandOccurrences()`'s
        // overlap test then reduces to `windowStart < start < windowEnd` (hence the 1ms on the inclusive end), and a
        // row with a missing/inverted `endDate` can't hide its alarm.
        const windowStart = new Date(lowerMs + leadMs);
        const windowEnd = new Date(horizonMs + leadMs + 1);
        const expand = (): OccurrenceWindow[] =>
            this.expandStarts(event, isMaster, excludeDates, windowStart, windowEnd).filter((occurrence) => {
                const fireAtMs = occurrence.start.getTime() - leadMs;
                return fireAtMs > lowerMs && fireAtMs <= horizonMs;
            });

        let due: OccurrenceWindow[] = expand();
        if (due.length === 0) {
            if (isMaster) {
                // Remember when to look again: the first occurrence after this window, or - when none comes within the
                // look-ahead - when the look-ahead itself runs out.
                const lookAheadEnd = new Date(windowEnd.getTime() + NEXT_REMINDER_LOOKAHEAD_MS);
                const [next] = this.expandStarts(event, isMaster, excludeDates, new Date(windowEnd.getTime() - 1), lookAheadEnd);
                this.nextDue.set(cacheKey, {
                    version: (event as any).version,
                    notBeforeMs: next ? next.start.getTime() - leadMs : lookAheadEnd.getTime() - leadMs,
                });
            }
            return;
        }
        if (isMaster) {
            // Only worth the extra query once an occurrence is actually due: a sibling override row represents
            // that occurrence itself (and fires its own alarms from its own row).
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
        // alarms for the same series.
        const occurrence: OccurrenceWindow = due[due.length - 1];
        if (!(await this.claim(event, marker, occurrence.start, isMaster))) {
            return;
        }
        this.notificationUtils?.sendMessage([event.folderUid, event.mailboxUid], "CalendarEvent", "reminder", {
            eventUid: event.uid,
            title: event.title,
            startDate: occurrence.start,
            location: event.location,
        });
    }

    /** `true` if `occurrenceStart` has already had its alarm claimed on `event` (in `marker`). */
    private alreadySent(event: CE, marker: string, occurrenceStart: Date, isMaster: boolean): boolean {
        const sent: any = (event as any)[marker];
        if (sent === undefined || sent === null) {
            return false;
        }
        const sentMs: number = new Date(sent).getTime();
        // A recurring series only ever moves forward. A single event can be rescheduled earlier or later, and
        // either way its new start deserves a reminder.
        return isMaster ? occurrenceStart.getTime() <= sentMs : occurrenceStart.getTime() === sentMs;
    }

    /**
     * Claims `occurrenceStart`'s alarm with a versioned update of `marker`. Returns `false` if it was
     * already claimed (possibly by another replica). On a version conflict, re-reads the row once: if the fresh
     * row is already claimed another replica won; otherwise the conflict came from an unrelated edit, so retry.
     */
    private async claim(event: CE, marker: string, occurrenceStart: Date, isMaster: boolean): Promise<boolean> {
        let current: CE | undefined = event;
        for (let attempt = 0; attempt < 2 && current; attempt++) {
            if (this.alreadySent(current, marker, occurrenceStart, isMaster)) {
                return false;
            }
            // `RepoUtils.find()` on the Mongo backend returns raw documents, and `RepoUtils.update()` only enforces
            // the optimistic lock when `existing instanceof BaseEntity` - otherwise it silently does an unversioned
            // `updateOne({ uid })`. Instantiating the model class is what makes the claim a real compare-and-set.
            const existing: CE = current instanceof this.calendarEventClass ? current : new this.calendarEventClass(current);
            try {
                const saved: any = await this.calendarEventRepo!.update(
                    { uid: existing.uid, version: (existing as any).version, [marker]: occurrenceStart } as any,
                    existing,
                    // The marker is job bookkeeping, not a user-visible change - don't broadcast an "update" push.
                    { ignoreACL: true, skipPush: true },
                );
                // Carry the claim over to the caller's copy, so the next alarm kind of this same row claims against the
                // row's new version instead of failing its first attempt on a stale one.
                (event as any).version = saved.version;
                (event as any)[marker] = occurrenceStart;
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
