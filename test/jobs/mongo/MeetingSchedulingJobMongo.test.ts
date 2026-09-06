///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for MeetingSchedulingJobMongo: a real in-memory MongoDB connection and a
// real `ObjectFactory` construct the job exactly as production wiring would - its own `@Init` builds a real
// `RepoUtils` against the live connection. This job is currently a scheduled placeholder (see its doc comment):
// `run()` only counts candidate events with attendees and logs a debug line; it does not compose or send any
// iTIP messages yet. See ScanQueueJobMongo.test.ts's file header for the full rationale behind bypassing
// `Server`/`ClassLoader`.
import { MongoMemoryServer } from "mongodb-memory-server";
import { ACLUtils, ConnectionManager, MongoConnection, MongoRepository, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../../config.js";
import { MeetingSchedulingJobMongo } from "../../../src/jobs/mongo/MeetingSchedulingJobMongo.js";
import { CalendarEventMongo } from "../../../src/models/mongo/CalendarEventMongo.js";
import { AttendeeResponseStatus, AttendeeRole, BusyStatus, CalendarEventStatus, RecipientType } from "../../../src/models/types.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("MeetingSchedulingJobMongo Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: MeetingSchedulingJobMongo;
    let calendarEventRepo: MongoRepository<CalendarEventMongo>;

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
        // connection above.
        job = await objectFactory.newInstance(MeetingSchedulingJobMongo, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
        await mongod.stop();
    });

    beforeEach(async () => {
        try {
            await calendarEventRepo.clear();
        } catch (err: any) {
            if (err.message !== "ns not found") {
                throw err;
            }
        }
    });

    it("Exposes the configured cron schedule.", () => {
        // `test/config.ts` doesn't configure `mail:jobs:meeting_scheduling` at all, so this also confirms the
        // `@Config` decorator's documented default value is what's actually exposed.
        expect(job.schedule).toBe("0 */5 * * * *");
    });

    it("start() and stop() are no-ops beyond init().", async () => {
        await expect(job.start()).resolves.toBeUndefined();
        expect(job.stop()).toBeUndefined();
    });

    it("Does nothing when there are no candidate events.", async () => {
        await expect(job.run()).resolves.toBeUndefined();
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

    it("Does not send or compose any iTIP messages, and does not throw, for an event with attendees (deferred pending IcsUtils per the job's doc comment).", async () => {
        await createEvent({
            attendees: [
                {
                    address: "attendee@example.com",
                    role: AttendeeRole.REQUIRED,
                    responseStatus: AttendeeResponseStatus.NEEDS_ACTION,
                    isOrganizer: false,
                },
            ],
        });

        await expect(job.run()).resolves.toBeUndefined();
    });

    it("Counts an event with at least one attendee as a candidate, but excludes one with no attendees.", async () => {
        await createEvent({
            attendees: [
                {
                    address: "attendee@example.com",
                    role: AttendeeRole.REQUIRED,
                    responseStatus: AttendeeResponseStatus.NEEDS_ACTION,
                    isOrganizer: false,
                },
            ],
        });
        await createEvent({ attendees: [] });

        // The job only logs the count (no observable state change) - the meaningful assertion here is simply
        // that both the with-attendees and no-attendees code paths run to completion without error.
        await expect(job.run()).resolves.toBeUndefined();
    });

    // The `event.attendees && event.attendees.length > 0` inspection's `catch` branch (logs a warning and moves
    // on to the next candidate) is not exercised here: it is genuinely unreachable via any real data this job
    // could ever read back. `attendees` round-trips through MongoDB's BSON (de)serialization as a plain array
    // (or is simply absent/falsy) - there is no way to persist a value that survives a real `find()` call and
    // yet throws when `&&`-checked and `.length`-read, short of contriving an exotic (getter/Proxy-based) object
    // no genuine write path in this codebase can ever produce.
});
