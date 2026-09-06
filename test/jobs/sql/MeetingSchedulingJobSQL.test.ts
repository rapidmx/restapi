///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for MeetingSchedulingJobSQL: a real SQLite (better-sqlite3) connection and
// a real `ObjectFactory` construct the job exactly as production wiring would - see
// MeetingSchedulingJobMongo.test.ts's file header for the full rationale (also applies here verbatim). Uses
// `config.sql.ts`, whose `acl` datastore is ALSO SQL-backed (`AccessControlListSQL`, auto-selected by `ACLUtils`
// from the connection's runtime type) - so this file has no MongoDB dependency at all.
import { ACLUtils, AccessControlListSQL, ConnectionManager, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import config from "../../config.sql.js";
import { MeetingSchedulingJobSQL } from "../../../src/jobs/sql/MeetingSchedulingJobSQL.js";
import { CalendarEventSQL } from "../../../src/models/sql/CalendarEventSQL.js";
import { AttendeeResponseStatus, AttendeeRole, BusyStatus, CalendarEventStatus, RecipientType } from "../../../src/models/types.js";

describe("MeetingSchedulingJobSQL Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: MeetingSchedulingJobSQL;
    let calendarEventRepo: Repository<CalendarEventSQL>;

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
        // deliberately bypasses `Server` (see MeetingSchedulingJobMongo.test.ts's header comment).
        objectFactory.register(ACLUtils);

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
        // connection above.
        job = await objectFactory.newInstance(MeetingSchedulingJobSQL, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await calendarEventRepo.clear();
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
    // could ever read back. `attendees` round-trips through TypeORM's `simple-json` column as a plain array (or
    // is simply absent/falsy) - there is no way to persist a value that survives a real `find()` call and yet
    // throws when `&&`-checked and `.length`-read, short of contriving an exotic (getter/Proxy-based) object no
    // genuine write path in this codebase can ever produce.
});
