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
import { ACLUtils, ConnectionManager, MongoConnection, MongoRepository, NotificationUtils, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../../config.js";
import { CalendarReminderJobMongo } from "../../../src/jobs/mongo/CalendarReminderJobMongo.js";
import { CalendarEventMongo } from "../../../src/models/mongo/CalendarEventMongo.js";
import { BusyStatus, CalendarEventStatus, RecipientType } from "../../../src/models/types.js";

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

    it("Skips an event whose startDate falls beyond the 24-hour lookahead bound.", async () => {
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
});
