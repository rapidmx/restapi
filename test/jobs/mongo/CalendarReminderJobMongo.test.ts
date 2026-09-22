///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for CalendarReminderJobMongo: a real in-memory MongoDB connection and a
// real `ObjectFactory` construct the job exactly as production wiring would - its own `@Init` builds a real
// `RepoUtils` against the live connection, and `@Inject(NotificationUtils)` resolves to a genuine
// `NotificationUtils` instance. `NotificationUtils` itself is real (real fire-and-forget publish logic); only
// the actual external-service boundary it talks to - a Redis client - is faked here with a minimal recording
// stub, the same "double the real external boundary, keep everything else real" approach `registerTestDoubles()`
// takes for BlobStore/Scan providers/SearchProvider/MailTransport. See ScanQueueJobMongo.test.ts's file header
// for the full rationale behind bypassing `Server`/`ClassLoader`.
import { MongoMemoryServer } from "mongodb-memory-server";
import { ACLUtils, ApiErrors, ConnectionManager, MongoConnection, MongoRepository, NotificationUtils, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../../config.js";
import { CalendarReminderJobMongo } from "../../../src/jobs/mongo/CalendarReminderJobMongo.js";
import { CalendarEventMongo } from "../../../src/models/mongo/CalendarEventMongo.js";
import { BusyStatus, CalendarEventStatus, RecipientType, RecurrenceFrequency } from "../../../src/models/types.js";

const JobClass = CalendarReminderJobMongo;

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

/**
 * A minimal fake standing in for the real `redis` client `NotificationUtils` publishes through - the actual
 * external-service boundary being doubled here (see the file header). Records every publish so tests can assert
 * on what was broadcast, and throws synchronously for a specifically-marked channel so the job's own per-event
 * catch/continue behavior can be exercised via a genuine failure of that boundary, rather than a hand-mocked
 * `CalendarReminderJob` dependency.
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

describe("CalendarReminderJobMongo Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: CalendarReminderJobMongo;
    let calendarEventRepo: MongoRepository<CalendarEventMongo>;
    let fakeRedis: FakeRedisClient;

    const mailboxUid = uuid.v4();
    const folderUid = uuid.v4();

    const createEvent = async (data?: Partial<CalendarEventMongo>): Promise<CalendarEventMongo> => {
        const obj = new CalendarEventMongo({
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
        await mongod.start();
        objectFactory = new ObjectFactory(config, logger);
        // Normally registered by `Server`'s own bootstrap - registered explicitly here since this file
        // deliberately bypasses `Server` (see ScanQueueJobMongo.test.ts's header comment).
        objectFactory.register(ACLUtils);

        // Pre-create the real `NotificationUtils` singleton (under its `@Inject`-default name) wired to our fake
        // Redis boundary, so both this job's own `@Inject(NotificationUtils)` field and its internal
        // `RepoUtils`' identical injection resolve to this exact instance rather than each independently
        // constructing a real `NotificationUtils` with no redis client at all (which would silently no-op).
        fakeRedis = new FakeRedisClient();
        await objectFactory.newInstance(NotificationUtils, { name: "default", args: [fakeRedis] });

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("CalendarEventMongo", CalendarEventMongo);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        calendarEventRepo = conn.getMongoRepository("CalendarEventMongo");

        // Constructed once via real ObjectFactory DI: `@Init` builds its real `RepoUtils` against the live
        // connection above, and `@Inject(NotificationUtils)` resolves to the pre-created singleton above.
        job = await objectFactory.newInstance(CalendarReminderJobMongo, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
        await mongod.stop();
    });

    beforeEach(async () => {
        fakeRedis.published = [];
        // The job keeps a per-process fire-window watermark; each test starts as a fresh process would.
        (job as any).watermarkMs = undefined;
        try {
            await calendarEventRepo.clear();
        } catch (err: any) {
            if (err.message !== "ns not found") {
                throw err;
            }
        }
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
                data: { eventUid: event.uid, title: event.title, startDate: event.startDate.toISOString() },
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

    it("Skips an event with no reminderMinutesBeforeStart configured.", async () => {
        const now = Date.now();
        await createEvent({ startDate: new Date(now + 5 * 60 * 1000), reminderMinutesBeforeStart: undefined });

        await job.run();

        expect(fakeRedis.published).toHaveLength(0);
    });

    it("Skips an event with a null reminderMinutesBeforeStart.", async () => {
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

    it("Skips an event whose reminder fire time has already passed.", async () => {
        const now = Date.now();
        // startDate=now+1min, reminderMinutesBeforeStart=10 -> fireAt=now-9min, before `now`.
        await createEvent({ startDate: new Date(now + 60 * 1000), reminderMinutesBeforeStart: 10 });

        await job.run();

        expect(fakeRedis.published).toHaveLength(0);
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

    it("Skips a cancelled event, and one with a negative reminderMinutesBeforeStart.", async () => {
        const now = Date.now();
        await createEvent({ startDate: new Date(now + 5 * 60 * 1000), reminderMinutesBeforeStart: 4.5, status: CalendarEventStatus.CANCELLED });
        await createEvent({ startDate: new Date(now + 5 * 60 * 1000), reminderMinutesBeforeStart: -1 });

        await job.run();

        expect(fakeRedis.published).toHaveLength(0);
    });

    it("Stops reading non-recurring candidates at the first page past the longest covered lead time.", async () => {
        const now = Date.now();
        const savedBatchSize = (job as any).batchSize;
        (job as any).batchSize = 1;
        const findSpy = vi.spyOn((job as any).calendarEventRepo, "find");
        try {
            await createEvent({ startDate: new Date(now + 5 * 60 * 1000), reminderMinutesBeforeStart: 4.5 });
            // Beyond max_lead_minutes (14 days) - reading stops here rather than paging through the rest.
            await createEvent({ startDate: new Date(now + 30 * 24 * 60 * 60 * 1000), reminderMinutesBeforeStart: 4.5 });
            await createEvent({ startDate: new Date(now + 31 * 24 * 60 * 60 * 1000), reminderMinutesBeforeStart: 4.5 });

            await job.run();

            expect(fakeRedis.published).toHaveLength(2);
            const nonRecurringPages = findSpy.mock.calls.filter((call: any[]) => call[0].recurrenceRule === undefined);
            expect(nonRecurringPages).toHaveLength(2);
        } finally {
            findSpy.mockRestore();
            (job as any).batchSize = savedBatchSize;
        }
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

    it("Logs (no send) when claiming a reminder fails with an error other than a version conflict.", async () => {
        const now = Date.now();
        await createEvent({ startDate: new Date(now + 5 * 60 * 1000), reminderMinutesBeforeStart: 4.5 });
        const updateSpy = vi.spyOn((job as any).calendarEventRepo, "update").mockRejectedValue(new Error("simulated claim failure"));
        const warnSpy = vi.spyOn((job as any).logger, "warn");
        try {
            await expect(job.run()).resolves.toBeUndefined();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("simulated claim failure"));
        } finally {
            updateSpy.mockRestore();
            warnSpy.mockRestore();
        }

        expect(fakeRedis.published).toHaveLength(0);
    });

    it("Gives up (no send) when both claim attempts hit a version conflict on a still-unclaimed row.", async () => {
        const now = Date.now();
        await createEvent({ startDate: new Date(now + 5 * 60 * 1000), reminderMinutesBeforeStart: 4.5 });
        const conflict = Object.assign(new Error("version conflict"), { code: ApiErrors.INVALID_OBJECT_VERSION });
        const updateSpy = vi.spyOn((job as any).calendarEventRepo, "update").mockRejectedValue(conflict);
        try {
            await expect(job.run()).resolves.toBeUndefined();
            expect(updateSpy).toHaveBeenCalledTimes(2);
        } finally {
            updateSpy.mockRestore();
        }

        expect(fakeRedis.published).toHaveLength(0);
    });

    it("Never sends the same occurrence's reminder twice across runs, and persists reminderSentFor.", async () => {
        const now = Date.now();
        const event = await createEvent({ startDate: new Date(now + 5 * 60 * 1000), reminderMinutesBeforeStart: 4.5 });

        await job.run();
        (job as any).watermarkMs = undefined;
        await job.run();

        expect(fakeRedis.published).toHaveLength(2);
        const stored: any = await calendarEventRepo.findOne({ uid: event.uid } as any);
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
        // fireAt = now - 5 min: older than the 120s first-run lookback...
        await createEvent({ startDate: new Date(now + 60 * 1000), reminderMinutesBeforeStart: 6 });

        await job.run();
        expect(fakeRedis.published).toHaveLength(0);

        // ...but inside the window since the previous run when that run was 10 minutes ago.
        await calendarEventRepo.clear();
        await createEvent({ startDate: new Date(now + 60 * 1000), reminderMinutesBeforeStart: 6 });
        (job as any).watermarkMs = now - 10 * 60 * 1000;
        await job.run();
        expect(fakeRedis.published).toHaveLength(2);
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
});
