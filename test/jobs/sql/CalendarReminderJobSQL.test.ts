///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for CalendarReminderJobSQL: a real SQLite (better-sqlite3) connection and a
// real `ObjectFactory` construct the job exactly as production wiring would - see
// CalendarReminderJobMongo.test.ts's file header for the full rationale (also applies here verbatim). Uses
// `config.sql.ts`, whose `acl` datastore is ALSO SQL-backed (`AccessControlListSQL`, auto-selected by `ACLUtils`
// from the connection's runtime type) - so this file has no MongoDB dependency at all.
import { ACLUtils, AccessControlListSQL, ConnectionManager, NotificationUtils, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import config from "../../config.sql.js";
import { CalendarReminderJobSQL } from "../../../src/jobs/sql/CalendarReminderJobSQL.js";
import { CalendarEventSQL } from "../../../src/models/sql/CalendarEventSQL.js";
import { BusyStatus, CalendarEventStatus, RecipientType, RecurrenceFrequency } from "../../../src/models/types.js";

const JobClass = CalendarReminderJobSQL;

/**
 * A minimal fake standing in for the real `redis` client `NotificationUtils` publishes through - the actual
 * external-service boundary being doubled here (see CalendarReminderJobMongo.test.ts's file header). Records
 * every publish so tests can assert on what was broadcast, and throws synchronously for a specifically-marked
 * channel so the job's own per-event catch/continue behavior can be exercised via a genuine failure of that
 * boundary, rather than a hand-mocked `CalendarReminderJob` dependency.
 */
class FakeRedisClient {
    public published: Array<{ channel: string; message: string }> = [];

    // Deliberately NOT declared `async`: a real redis client (e.g. node-redis) can throw synchronously, before
    // ever returning a promise, when a command is issued while disconnected (its `ClientClosedError`) - this
    // reproduces that same synchronous-throw shape so `NotificationUtils.sendMessage()`'s fire-and-forget
    // `?.catch(...)` (which only ever handles a *rejected promise*) does NOT swallow it, letting it propagate
    // up into `CalendarReminderJob.run()`'s own per-event try/catch, exactly as a real disconnected-client
    // failure would.
    public publish(channel: string, message: string): Promise<number> {
        if (channel === "force-publish-failure") {
            throw new Error("redis publish failed");
        }
        this.published.push({ channel, message });
        return Promise.resolve(1);
    }
}

describe("CalendarReminderJobSQL Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: CalendarReminderJobSQL;
    let calendarEventRepo: Repository<CalendarEventSQL>;
    let fakeRedis: FakeRedisClient;

    const mailboxUid = uuid.v4();
    const folderUid = uuid.v4();

    const createEvent = async (data?: Partial<CalendarEventSQL>): Promise<CalendarEventSQL> => {
        const obj = new CalendarEventSQL({
            folderUid,
            mailboxUid,
            title: "Team Sync",
            timezone: "UTC",
            organizer: { address: "organizer@example.com", type: RecipientType.TO },
            attendees: [],
            status: CalendarEventStatus.CONFIRMED,
            busyStatus: BusyStatus.BUSY,
            icalUid: uuid.v4(),
            startDate: new Date(),
            endDate: new Date(),
            ...data,
        });
        return await calendarEventRepo.save(obj);
    };

    beforeAll(async () => {
        objectFactory = new ObjectFactory(config, logger);
        // Normally registered by `Server`'s own bootstrap - registered explicitly here since this file
        // deliberately bypasses `Server` (see CalendarReminderJobMongo.test.ts's header comment).
        objectFactory.register(ACLUtils);

        // Pre-create the real `NotificationUtils` singleton (under its `@Inject`-default name) wired to our fake
        // Redis boundary, so both this job's own `@Inject(NotificationUtils)` field and its internal
        // `RepoUtils`' identical injection resolve to this exact instance rather than each independently
        // constructing a real `NotificationUtils` with no redis client at all (which would silently no-op).
        fakeRedis = new FakeRedisClient();
        await objectFactory.newInstance(NotificationUtils, { name: "default", args: [fakeRedis] });

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        // Not auto-discovered here the way `Server`'s `ClassLoader` scan would - a bare TypeORM `DataSource`
        // throws "No metadata found" from `getRepository()` for any entity not explicitly in this map.
        models.set("AccessControlListSQL", AccessControlListSQL);
        models.set("CalendarEventSQL", CalendarEventSQL);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        calendarEventRepo = conn.getRepository(CalendarEventSQL);

        // Constructed once via real ObjectFactory DI: `@Init` builds its real `RepoUtils` against the live
        // connection above, and `@Inject(NotificationUtils)` resolves to the pre-created singleton above.
        job = await objectFactory.newInstance(CalendarReminderJobSQL, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        fakeRedis.published = [];
        // The job keeps a per-process fire-window watermark; each test starts as a fresh process would.
        (job as any).watermarkMs = undefined;
        (job as any).nextDue = new Map();
        await calendarEventRepo.clear();
    });

    it("Exposes the configured cron schedule.", () => {
        expect(job.schedule).toBe(config.get("mail:jobs:calendar_reminder:schedule"));
    });

    it("start() and stop() are no-ops beyond init().", async () => {
        await expect(job.start()).resolves.toBeUndefined();
        expect(job.stop()).toBeUndefined();
    });

    it("Does nothing when there are no candidate events.", async () => {
        await expect(job.run()).resolves.toBeUndefined();
        expect(fakeRedis.published).toHaveLength(0);
    });

    // `calendarEventRepo` is always set by the time `run()` can be called through real DI - `@Init` completes
    // before `objectFactory.newInstance()` ever resolves, and `BackgroundServiceManager` always awaits
    // construction before scheduling. The only way to exercise this defensive guard is to force the field back
    // to `undefined` on an otherwise fully real job instance.
    it("Does nothing when calendarEventRepo is not yet initialized.", async () => {
        const real = (job as any).calendarEventRepo;
        (job as any).calendarEventRepo = undefined;
        try {
            await expect(job.run()).resolves.toBeUndefined();
        } finally {
            (job as any).calendarEventRepo = real;
        }
    });

    it("Excludes an event whose startDate has already passed.", async () => {
        const now = Date.now();
        await createEvent({ startDate: new Date(now - 60 * 60 * 1000), reminderMinutesBeforeStart: 5 });

        await job.run();

        expect(fakeRedis.published).toHaveLength(0);
    });

    it("Sends a reminder notification (to both the folder and mailbox channels) when the fire time falls within the polling window.", async () => {
        const now = Date.now();
        // reminderMinutesBeforeStart=4.5, startDate=now+5min -> fireAt=now+30s, comfortably inside [now,
        // windowEnd] (windowEnd=now+60s) with margin on both sides so the small, real processing delay between
        // capturing `now` here and the job computing its own `now` inside `run()` can never tip this over the
        // boundary (unlike fireAt=now exactly, which is flaky by construction).
        const event = await createEvent({ startDate: new Date(now + 5 * 60 * 1000), reminderMinutesBeforeStart: 4.5 });

        await job.run();

        expect(fakeRedis.published).toHaveLength(2);
        const channels = fakeRedis.published.map((p) => p.channel).sort();
        expect(channels).toEqual([folderUid, mailboxUid].sort());
        for (const entry of fakeRedis.published) {
            const parsed = JSON.parse(entry.message);
            expect(parsed).toEqual({
                type: "CalendarEvent",
                action: "reminder",
                // A fresh SQL read of an unset nullable `text` column comes back `null`, not `undefined` - unlike
                // Mongo, where the field is genuinely absent and JSON.stringify() drops it from the payload entirely.
                data: { eventUid: event.uid, title: event.title, startDate: event.startDate.toISOString(), location: null },
            });
        }
    });

    it("Carries the event's own location in the reminder, verbatim.", async () => {
        const now = Date.now();
        const event = await createEvent({
            startDate: new Date(now + 5 * 60 * 1000),
            reminderMinutesBeforeStart: 4.5,
            location: "https://meet.example.com/room/abc",
        });

        await job.run();

        expect(fakeRedis.published).toHaveLength(2);
        for (const entry of fakeRedis.published) {
            const parsed = JSON.parse(entry.message);
            expect(parsed.data.location).toBe("https://meet.example.com/room/abc");
        }
    });

    it("Does not fire an event with no reminderMinutesBeforeStart configured before its start.", async () => {
        const now = Date.now();
        await createEvent({ startDate: new Date(now + 5 * 60 * 1000), reminderMinutesBeforeStart: undefined });

        await job.run();

        expect(fakeRedis.published).toHaveLength(0);
    });

    it("Does not fire an event with a null reminderMinutesBeforeStart before its start.", async () => {
        const now = Date.now();
        await createEvent({ startDate: new Date(now + 5 * 60 * 1000), reminderMinutesBeforeStart: null as any });

        await job.run();

        expect(fakeRedis.published).toHaveLength(0);
    });

    it("Skips an event whose reminder fire time is still far in the future.", async () => {
        const now = Date.now();
        await createEvent({ startDate: new Date(now + 25 * 60 * 60 * 1000), reminderMinutesBeforeStart: 5 });

        await job.run();

        expect(fakeRedis.published).toHaveLength(0);
    });

    it("Skips the reminder of an event whose reminder fire time has already passed, but still alarms at its start.", async () => {
        const now = Date.now();
        // startDate=now+1min, reminderMinutesBeforeStart=10 -> fireAt=now-9min, before `now`; the start alarm is due.
        const event = await createEvent({ startDate: new Date(now + 60 * 1000), reminderMinutesBeforeStart: 10 });

        await job.run();

        expect(fakeRedis.published).toHaveLength(2);
        const stored: any = await calendarEventRepo.findOne({ where: { uid: event.uid } });
        expect(stored.reminderSentFor).toBeFalsy();
        expect(stored.startAlarmSentFor).toBeTruthy();
    });

    it("Skips an event whose reminder fire time is beyond the polling window.", async () => {
        const now = Date.now();
        // startDate=now+1hr, reminderMinutesBeforeStart=1 -> fireAt=now+59min, beyond the 60s windowEnd.
        await createEvent({ startDate: new Date(now + 60 * 60 * 1000), reminderMinutesBeforeStart: 1 });

        await job.run();

        expect(fakeRedis.published).toHaveLength(0);
    });

    it("Continues processing subsequent events when broadcasting one throws.", async () => {
        const now = Date.now();
        // `folderUid: "force-publish-failure"` makes the fake Redis boundary throw synchronously for this
        // event's first channel, exercising the job's real per-event catch/continue - a genuine failure of the
        // real external boundary, not a hand-mocked job dependency.
        await createEvent({
            folderUid: "force-publish-failure",
            mailboxUid: "mailbox-bad",
            startDate: new Date(now + 5 * 60 * 1000),
            reminderMinutesBeforeStart: 4.5,
        });
        const goodEvent = await createEvent({ startDate: new Date(now + 5 * 60 * 1000), reminderMinutesBeforeStart: 4.5 });

        await expect(job.run()).resolves.toBeUndefined();

        // The good event's own notification still went out to both of its channels.
        const goodPublishes = fakeRedis.published.filter((p) => [folderUid, mailboxUid].includes(p.channel));
        expect(goodPublishes).toHaveLength(2);
        for (const entry of goodPublishes) {
            expect(JSON.parse(entry.message).data.eventUid).toBe(goodEvent.uid);
        }
    });

    it("Never sends the same occurrence's reminder twice across runs, and persists reminderSentFor.", async () => {
        const now = Date.now();
        const event = await createEvent({ startDate: new Date(now + 5 * 60 * 1000), reminderMinutesBeforeStart: 4.5 });

        await job.run();
        (job as any).watermarkMs = undefined;
        await job.run();

        expect(fakeRedis.published).toHaveLength(2);
        const stored: any = await calendarEventRepo.findOne({ where: { uid: event.uid } });
        expect(new Date(stored.reminderSentFor).getTime()).toBe(new Date(event.startDate).getTime());
    });

    it("Sends exactly one reminder when two replicas run at the same moment (claim-then-send).", async () => {
        const now = Date.now();
        await createEvent({ startDate: new Date(now + 5 * 60 * 1000), reminderMinutesBeforeStart: 4.5 });
        const replica = await objectFactory.newInstance(JobClass, { name: "replica" });
        // Force the race deterministically: the replica reads its candidates (so it holds the row at its
        // pre-claim version), then the other replica runs to completion - claiming and sending - before the first
        // one continues. The first replica's own claim must then lose the optimistic-lock race and not send.
        const replicaRepo: any = (replica as any).calendarEventRepo;
        const realFind = replicaRepo.find.bind(replicaRepo);
        let raced = false;
        const findSpy = vi.spyOn(replicaRepo, "find").mockImplementation(async (...args: any[]) => {
            const rows = await realFind(...args);
            if (!raced) {
                raced = true;
                await job.run();
            }
            return rows;
        });

        try {
            await replica.run();
        } finally {
            findSpy.mockRestore();
        }

        // One notification = one publish per channel (folder + mailbox).
        expect(fakeRedis.published).toHaveLength(2);
    });

    it("Sends a new reminder when a non-recurring event with an already-sent reminder is rescheduled.", async () => {
        const now = Date.now();
        await createEvent({
            startDate: new Date(now + 5 * 60 * 1000),
            reminderMinutesBeforeStart: 4.5,
            reminderSentFor: new Date(now + 3 * 24 * 60 * 60 * 1000),
        });

        await job.run();

        expect(fakeRedis.published).toHaveLength(2);
    });

    it("Fires a reminder set more than 24 hours ahead.", async () => {
        const now = Date.now();
        // startDate = now + 3 days, lead = 3 days - 30s -> fireAt = now + 30s.
        await createEvent({ startDate: new Date(now + 3 * 24 * 60 * 60 * 1000), reminderMinutesBeforeStart: 3 * 24 * 60 - 0.5 });

        await job.run();

        expect(fakeRedis.published).toHaveLength(2);
    });

    it("Catches a fire time that fell between runs after scheduler drift (watermark), but not one older than the initial lookback on a first run.", async () => {
        const now = Date.now();
        // fireAt = now - 5 min: older than the 120s first-run lookback (the start alarm, at now + 5 min, is not yet due)...
        await createEvent({ startDate: new Date(now + 5 * 60 * 1000), reminderMinutesBeforeStart: 10 });

        await job.run();
        expect(fakeRedis.published).toHaveLength(0);

        // ...but inside the window since the previous run when that run was 10 minutes ago.
        await calendarEventRepo.clear();
        await createEvent({ startDate: new Date(now + 5 * 60 * 1000), reminderMinutesBeforeStart: 10 });
        (job as any).watermarkMs = now - 10 * 60 * 1000;
        await job.run();
        expect(fakeRedis.published).toHaveLength(2);
    });

    it("Keyset-pages every candidate with no page cap, never skipping rows that share a startDate across page boundaries.", async () => {
        const now = Date.now();
        const savedBatchSize = (job as any).batchSize;
        (job as any).batchSize = 2;
        try {
            const start = new Date(now + 5 * 60 * 1000);
            for (let i = 0; i < 7; i++) {
                await createEvent({ startDate: start, reminderMinutesBeforeStart: 4.5 });
            }
            const icalStart = new Date(Math.floor((now + 5 * 60 * 1000) / 1000) * 1000 - 3 * 24 * 60 * 60 * 1000);
            for (let i = 0; i < 5; i++) {
                await createEvent({
                    startDate: icalStart,
                    endDate: new Date(icalStart.getTime() + 30 * 60 * 1000),
                    recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, exceptions: [] },
                    reminderMinutesBeforeStart: 4.5,
                });
            }

            await job.run();

            // 12 events, each published to its folder and mailbox channels.
            expect(fakeRedis.published).toHaveLength(24);
        } finally {
            (job as any).batchSize = savedBatchSize;
        }
    });

    it("Never reads recurring masters that can't have a due occurrence (cancelled, starting after the lead horizon) and skips expanding an ended series.", async () => {
        const now = Date.now();
        const seriesStart = new Date(Math.floor((now + 5 * 60 * 1000) / 1000) * 1000 - 10 * 24 * 60 * 60 * 1000);
        const daily = { freq: RecurrenceFrequency.DAILY, interval: 1, exceptions: [] };
        const ended = await createEvent({
            startDate: seriesStart,
            endDate: new Date(seriesStart.getTime() + 30 * 60 * 1000),
            recurrenceRule: { ...daily, until: new Date(now - 2 * 24 * 60 * 60 * 1000) },
            reminderMinutesBeforeStart: 4.5,
        });
        const cancelled = await createEvent({
            startDate: seriesStart,
            recurrenceRule: daily,
            status: CalendarEventStatus.CANCELLED,
            reminderMinutesBeforeStart: 4.5,
        });
        const future = await createEvent({ startDate: new Date(now + 60 * 24 * 60 * 60 * 1000), recurrenceRule: daily, reminderMinutesBeforeStart: 4.5 });
        const live = await createEvent({ startDate: seriesStart, recurrenceRule: { ...daily, until: new Date(now + 24 * 60 * 60 * 1000) }, reminderMinutesBeforeStart: 4.5 });
        const processSpy = vi.spyOn(job as any, "processEvent");
        try {
            await job.run();

            const processed: string[] = processSpy.mock.calls.map((call: any[]) => call[0].uid);
            expect(processed).toContain(live.uid);
            expect(processed).not.toContain(ended.uid);
            expect(processed).not.toContain(cancelled.uid);
            expect(processed).not.toContain(future.uid);
            expect(fakeRedis.published).toHaveLength(2);
        } finally {
            processSpy.mockRestore();
        }
    });

    it("Expands a recurring master that started long ago and fires for today's occurrence.", async () => {
        const now = Date.now();
        // A daily series that started 400 days ago, at a time of day that puts today's occurrence 5 minutes out.
        const occurrenceStart = new Date(Math.floor((now + 5 * 60 * 1000) / 1000) * 1000);
        const seriesStart = new Date(occurrenceStart.getTime() - 400 * 24 * 60 * 60 * 1000);
        const event = await createEvent({
            startDate: seriesStart,
            endDate: new Date(seriesStart.getTime() + 30 * 60 * 1000),
            recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, exceptions: [] },
            reminderMinutesBeforeStart: 4.5,
        });

        await job.run();

        expect(fakeRedis.published).toHaveLength(2);
        expect(JSON.parse(fakeRedis.published[0].message).data).toEqual({
            eventUid: event.uid,
            title: event.title,
            startDate: occurrenceStart.toISOString(),
            // A fresh SQL read of an unset nullable `text` column comes back `null`, not `undefined` - unlike
            // Mongo, where the field is genuinely absent and JSON.stringify() drops it from the payload entirely.
            location: null,
        });
    });

    describe("Skipping recurring masters with nothing due yet", () => {
        const weekly = (startDate: Date, extra: any = {}) => ({
            startDate,
            endDate: new Date(startDate.getTime() + 30 * 60 * 1000),
            recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, exceptions: [] },
            reminderMinutesBeforeStart: 4.5,
            ...extra,
        });

        it("Remembers when a master's next reminder is due, so later runs don't expand it again until then.", async () => {
            const now = Date.now();
            // Weekly, last occurred about an hour ago: the next one is a week less an hour from now.
            const seriesStart = new Date(Math.floor((now - 60 * 60 * 1000) / 1000) * 1000 - 14 * 24 * 60 * 60 * 1000);
            const event = await createEvent(weekly(seriesStart));
            const nextStartMs = seriesStart.getTime() + 21 * 24 * 60 * 60 * 1000;

            await job.run();

            expect(fakeRedis.published).toHaveLength(0);
            const remembered = (job as any).nextDue.get(`${event.uid}:reminder`);
            const stored = (await calendarEventRepo.findOne({ where: { uid: event.uid } }))!;
            expect(remembered.notBeforeMs).toBe(nextStartMs - Number(stored.reminderMinutesBeforeStart) * 60 * 1000);
            expect(remembered.version).toBe((await calendarEventRepo.findOne({ where: { uid: event.uid } }))!.version);

            // Not expanded again while its next reminder is more than a window away.
            const expandSpy = vi.spyOn(job as any, "expandStarts");
            await job.run();
            expect(expandSpy).not.toHaveBeenCalled();
            expandSpy.mockRestore();
        });

        it("Does not skip a master whose row changed since it was remembered, nor one whose remembered time has come.", async () => {
            const now = Date.now();
            const occurrenceStart = new Date(Math.floor((now + 5 * 60 * 1000) / 1000) * 1000);
            const seriesStart = new Date(occurrenceStart.getTime() - 14 * 24 * 60 * 60 * 1000);
            const event = await createEvent(weekly(seriesStart));
            const version = (await calendarEventRepo.findOne({ where: { uid: event.uid } }))!.version;

            // Remembered as not due for a day: skipped.
            (job as any).nextDue.set(`${event.uid}:reminder`, { version, notBeforeMs: now + 24 * 60 * 60 * 1000 });
            await job.run();
            expect(fakeRedis.published).toHaveLength(0);

            // The row has been edited since (another version): expanded again, and the reminder goes out.
            (job as any).watermarkMs = undefined;
            (job as any).nextDue.set(`${event.uid}:reminder`, { version: version - 1, notBeforeMs: now + 24 * 60 * 60 * 1000 });
            await job.run();
            expect(fakeRedis.published).toHaveLength(2);
        });

        it("Forgets a master that no longer comes up as a candidate.", async () => {
            (job as any).nextDue.set("gone:reminder", { version: 0, notBeforeMs: Date.now() + 1000 });

            await job.run();

            expect((job as any).nextDue.has("gone:reminder")).toBe(false);
        });
    });

    it("Does not fire a recurring master's reminder for an occurrence excluded by EXDATE or replaced by an override row.", async () => {
        const now = Date.now();
        const occurrenceStart = new Date(Math.floor((now + 5 * 60 * 1000) / 1000) * 1000);
        const seriesStart = new Date(occurrenceStart.getTime() - 10 * 24 * 60 * 60 * 1000);
        const icalUid = uuid.v4();
        await createEvent({
            icalUid,
            startDate: seriesStart,
            endDate: new Date(seriesStart.getTime() + 30 * 60 * 1000),
            recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, exceptions: [] },
            reminderMinutesBeforeStart: 4.5,
        });
        // The override moved today's occurrence two hours later and has no reminder of its own.
        await createEvent({
            icalUid,
            recurrenceId: occurrenceStart,
            startDate: new Date(occurrenceStart.getTime() + 2 * 60 * 60 * 1000),
            endDate: new Date(occurrenceStart.getTime() + 2.5 * 60 * 60 * 1000),
        });
        await createEvent({
            startDate: seriesStart,
            endDate: new Date(seriesStart.getTime() + 30 * 60 * 1000),
            recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, exceptions: [occurrenceStart] },
            reminderMinutesBeforeStart: 4.5,
        });

        await job.run();

        expect(fakeRedis.published).toHaveLength(0);
    });

    describe("Start-time alarm", () => {
        const readRow = async (uid: string): Promise<any> => calendarEventRepo.findOne({ where: { uid } });
        /** The notifications broadcast so far (one publish per channel, so count the folder channel's). */
        const notifications = (): any[] => fakeRedis.published.filter((p) => p.channel === folderUid).map((p) => JSON.parse(p.message));
        const daily = { freq: RecurrenceFrequency.DAILY, interval: 1, exceptions: [] };
        const secondsFromNow = (seconds: number): Date => new Date(Math.floor((Date.now() + seconds * 1000) / 1000) * 1000);
        const claimedMarkers = (updateSpy: any): string[] =>
            updateSpy.mock.calls.map((call: any[]) => ("reminderSentFor" in call[0] ? "reminderSentFor" : "startAlarmSentFor"));

        it("Fires at the start of an event that has no reminder, with the unchanged push shape.", async () => {
            const event = await createEvent({ startDate: secondsFromNow(30), location: "Room 1" });

            await job.run();

            expect(fakeRedis.published).toHaveLength(2);
            expect(notifications()).toEqual([
                {
                    type: "CalendarEvent",
                    action: "reminder",
                    data: { eventUid: event.uid, title: event.title, startDate: event.startDate.toISOString(), location: "Room 1" },
                },
            ]);
            const stored = await readRow(event.uid);
            expect(new Date(stored.startAlarmSentFor).getTime()).toBe(new Date(event.startDate).getTime());
            expect(stored.reminderSentFor).toBeFalsy();
        });

        it("Fires at the start of an event with a null or negative reminder.", async () => {
            await createEvent({ startDate: secondsFromNow(30), reminderMinutesBeforeStart: null as any });
            await createEvent({ startDate: secondsFromNow(30), reminderMinutesBeforeStart: -5 });

            await job.run();

            expect(notifications()).toHaveLength(2);
        });

        it("Fires both the reminder and the start alarm of one event, separately, each once and in order.", async () => {
            const event = await createEvent({ startDate: secondsFromNow(30), reminderMinutesBeforeStart: 1 });
            // The previous run (conceptually) was long enough ago that the reminder's fire time is inside this run's window too.
            (job as any).watermarkMs = Date.now() - 10 * 60 * 1000;
            const updateSpy = vi.spyOn((job as any).calendarEventRepo, "update");
            try {
                await job.run();
                (job as any).watermarkMs = Date.now() - 10 * 60 * 1000;
                await job.run();

                expect(claimedMarkers(updateSpy)).toEqual(["reminderSentFor", "startAlarmSentFor"]);
            } finally {
                updateSpy.mockRestore();
            }

            expect(notifications()).toHaveLength(2);
            const stored = await readRow(event.uid);
            expect(new Date(stored.reminderSentFor).getTime()).toBe(new Date(event.startDate).getTime());
            expect(new Date(stored.startAlarmSentFor).getTime()).toBe(new Date(event.startDate).getTime());
        });

        it("Fires once, as the reminder, when the lead is 0.", async () => {
            const event = await createEvent({ startDate: secondsFromNow(30), reminderMinutesBeforeStart: 0 });

            await job.run();

            expect(notifications()).toHaveLength(1);
            const stored = await readRow(event.uid);
            expect(new Date(stored.reminderSentFor).getTime()).toBe(new Date(event.startDate).getTime());
            expect(stored.startAlarmSentFor).toBeFalsy();
        });

        it("Fires nothing for an all-day event with no reminder.", async () => {
            await createEvent({ startDate: secondsFromNow(30), allDay: true });

            await job.run();

            expect(fakeRedis.published).toHaveLength(0);
        });

        it("Fires only the reminder for an all-day event with a reminder (and nothing for a lead of 0 on a different day).", async () => {
            const event = await createEvent({ startDate: secondsFromNow(30), allDay: true, reminderMinutesBeforeStart: 1 });
            (job as any).watermarkMs = Date.now() - 10 * 60 * 1000;

            await job.run();

            expect(notifications()).toHaveLength(1);
            const stored = await readRow(event.uid);
            expect(stored.reminderSentFor).toBeTruthy();
            expect(stored.startAlarmSentFor).toBeFalsy();
        });

        it("Fires nothing for a cancelled event, reminder or not.", async () => {
            await createEvent({ startDate: secondsFromNow(30), status: CalendarEventStatus.CANCELLED });
            await createEvent({ startDate: secondsFromNow(30), status: CalendarEventStatus.CANCELLED, reminderMinutesBeforeStart: 0 });

            await job.run();

            expect(fakeRedis.published).toHaveLength(0);
        });

        it("Never sends the same occurrence's start alarm twice across runs.", async () => {
            await createEvent({ startDate: secondsFromNow(30) });

            await job.run();
            (job as any).watermarkMs = undefined;
            await job.run();

            expect(notifications()).toHaveLength(1);
        });

        it("Sends exactly one start alarm when two replicas run at the same moment.", async () => {
            await createEvent({ startDate: secondsFromNow(30) });
            const replica = await objectFactory.newInstance(JobClass, { name: "replica-start" });
            const replicaRepo: any = (replica as any).calendarEventRepo;
            const realFind = replicaRepo.find.bind(replicaRepo);
            let raced = false;
            const findSpy = vi.spyOn(replicaRepo, "find").mockImplementation(async (...args: any[]) => {
                const rows = await realFind(...args);
                if (!raced) {
                    raced = true;
                    await job.run();
                }
                return rows;
            });

            try {
                await replica.run();
            } finally {
                findSpy.mockRestore();
            }

            expect(notifications()).toHaveLength(1);
        });

        it("Fires a recurring master with no reminder at its occurrence start, once.", async () => {
            const occurrenceStart = secondsFromNow(30);
            const seriesStart = new Date(occurrenceStart.getTime() - 10 * 24 * 60 * 60 * 1000);
            const event = await createEvent({
                startDate: seriesStart,
                endDate: new Date(seriesStart.getTime() + 30 * 60 * 1000),
                recurrenceRule: daily,
            });

            await job.run();
            (job as any).watermarkMs = undefined;
            await job.run();

            expect(notifications().map((n) => [n.data.eventUid, n.data.title, n.data.startDate])).toEqual([
                [event.uid, event.title, occurrenceStart.toISOString()],
            ]);
            const stored = await readRow(event.uid);
            expect(new Date(stored.startAlarmSentFor).getTime()).toBe(occurrenceStart.getTime());
        });

        it("Fires a one-off override row with no reminder at its own start, in place of the master's replaced occurrence.", async () => {
            const occurrenceStart = secondsFromNow(30);
            const seriesStart = new Date(occurrenceStart.getTime() - 10 * 24 * 60 * 60 * 1000);
            const icalUid = uuid.v4();
            await createEvent({
                icalUid,
                startDate: seriesStart,
                endDate: new Date(seriesStart.getTime() + 30 * 60 * 1000),
                recurrenceRule: daily,
            });
            const movedStart = secondsFromNow(40);
            const override = await createEvent({
                icalUid,
                recurrenceId: occurrenceStart,
                startDate: movedStart,
                endDate: new Date(movedStart.getTime() + 30 * 60 * 1000),
            });

            await job.run();

            expect(notifications().map((n) => [n.data.eventUid, n.data.startDate])).toEqual([[override.uid, movedStart.toISOString()]]);
        });

        it("Remembers the next due time of a master separately for its reminder and its start alarm.", async () => {
            const now = Date.now();
            // Weekly, last occurred about an hour ago: the next one is a week less an hour from now.
            const seriesStart = new Date(Math.floor((now - 60 * 60 * 1000) / 1000) * 1000 - 14 * 24 * 60 * 60 * 1000);
            const weekly = (extra: any = {}) => ({
                startDate: seriesStart,
                endDate: new Date(seriesStart.getTime() + 30 * 60 * 1000),
                recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, exceptions: [] },
                ...extra,
            });
            const withReminder = await createEvent(weekly({ reminderMinutesBeforeStart: 4.5 }));
            const noReminder = await createEvent(weekly());
            const nextStartMs = seriesStart.getTime() + 21 * 24 * 60 * 60 * 1000;

            await job.run();

            expect(fakeRedis.published).toHaveLength(0);
            const nextDue: Map<string, any> = (job as any).nextDue;
            expect(nextDue.get(`${withReminder.uid}:reminder`).notBeforeMs).toBe(nextStartMs - Number((await readRow(withReminder.uid)).reminderMinutesBeforeStart) * 60 * 1000);
            expect(nextDue.get(`${withReminder.uid}:start`).notBeforeMs).toBe(nextStartMs);
            expect(nextDue.get(`${noReminder.uid}:start`).notBeforeMs).toBe(nextStartMs);
            expect(nextDue.has(`${noReminder.uid}:reminder`)).toBe(false);
            expect(nextDue.has(withReminder.uid)).toBe(false);

            // Not expanded again while either alarm is more than a window away.
            const expandSpy = vi.spyOn(job as any, "expandStarts");
            await job.run();
            expect(expandSpy).not.toHaveBeenCalled();
            expandSpy.mockRestore();
        });

        it("Skips a master only for the alarm kind that was remembered, and forgets entries of masters that are no longer candidates.", async () => {
            const occurrenceStart = secondsFromNow(30);
            const seriesStart = new Date(occurrenceStart.getTime() - 14 * 24 * 60 * 60 * 1000);
            const event = await createEvent({
                startDate: seriesStart,
                endDate: new Date(seriesStart.getTime() + 30 * 60 * 1000),
                recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, exceptions: [] },
            });
            const version = (await readRow(event.uid)).version;
            const nextDue: Map<string, any> = (job as any).nextDue;
            nextDue.set(`${event.uid}:start`, { version, notBeforeMs: Date.now() + 24 * 60 * 60 * 1000 });
            nextDue.set("gone:reminder", { version: 0, notBeforeMs: Date.now() + 1000 });

            await job.run();
            expect(fakeRedis.published).toHaveLength(0);
            expect(nextDue.has("gone:reminder")).toBe(false);
            expect(nextDue.has(`${event.uid}:start`)).toBe(true);

            // A stale version no longer skips it: the start alarm goes out.
            (job as any).watermarkMs = undefined;
            nextDue.set(`${event.uid}:start`, { version: version - 1, notBeforeMs: Date.now() + 24 * 60 * 60 * 1000 });
            await job.run();
            expect(notifications()).toHaveLength(1);
        });
    });
});
