///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for MeetingSchedulingJobSQL - see MeetingSchedulingJobMongo.test.ts's file
// header for the full rationale (also applies here verbatim). Uses `config.sql.ts`, whose `acl` datastore is
// ALSO SQL-backed (`AccessControlListSQL`, auto-selected by `ACLUtils` from the connection's runtime type) - so
// this file has no MongoDB dependency at all.
import { ACLUtils, AccessControlListSQL, ConnectionManager, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import config from "../../config.sql.js";
import { registerTestDoubles, RecordingMailTransport } from "../../testDoubles.js";
import { MeetingSchedulingJobSQL } from "../../../src/jobs/sql/MeetingSchedulingJobSQL.js";
import { CalendarEventSQL } from "../../../src/models/sql/CalendarEventSQL.js";
import {
    AttendeeResponseStatus,
    AttendeeRole,
    BusyStatus,
    CalendarEventStatus,
    RecipientType,
} from "../../../src/models/types.js";

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
            organizer: { address: "organizer@example.com", displayName: "Organizer", type: RecipientType.TO },
            attendees: [
                {
                    address: "attendee@example.com",
                    displayName: "Attendee",
                    role: AttendeeRole.REQUIRED,
                    responseStatus: AttendeeResponseStatus.NEEDS_ACTION,
                    isOrganizer: false,
                },
            ],
            status: CalendarEventStatus.CONFIRMED,
            busyStatus: BusyStatus.BUSY,
            icalUid: uuid.v4(),
            startDate: new Date(Date.now() + 60 * 60 * 1000),
            endDate: new Date(Date.now() + 2 * 60 * 60 * 1000),
            ...data,
        });
        return await calendarEventRepo.save(obj);
    };

    beforeAll(async () => {
        objectFactory = new ObjectFactory(config, logger);
        registerTestDoubles(objectFactory);
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
        // connection above, and `@Inject("MailTransport")` resolves to the registered test double.
        job = await objectFactory.newInstance(MeetingSchedulingJobSQL, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await calendarEventRepo.clear();
        (objectFactory.getInstance<RecordingMailTransport>("MailTransport")!).sent = [];
    });

    it("Exposes the configured cron schedule.", () => {
        expect(job.schedule).toBe(config.get("mail:jobs:meeting_scheduling:schedule"));
    });

    it("start() and stop() are no-ops beyond init().", async () => {
        await expect(job.start()).resolves.toBeUndefined();
        expect(job.stop()).toBeUndefined();
    });

    it("Does nothing when there are no candidate events.", async () => {
        await expect(job.run()).resolves.toBeUndefined();
        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(0);
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

    it("Sends an iTIP REQUEST to each attendee (not the organizer) and marks inviteSequenceSent.", async () => {
        const event = await createEvent();

        await job.run();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(1);
        expect(transport.sent[0].envelopeTo).toEqual(["attendee@example.com"]);
        expect(transport.sent[0].envelopeFrom).toBe("organizer@example.com");
        expect(transport.sent[0].raw.toString()).toContain("METHOD:REQUEST");
        expect(transport.sent[0].raw.toString()).toContain(`UID:${event.icalUid}`);

        const updated = await calendarEventRepo.findOne({ where: { uid: event.uid } });
        expect(updated!.inviteSequenceSent).toBe(0);
    });

    it("Does not resend an invite once inviteSequenceSent already matches the current sequence.", async () => {
        await createEvent({ inviteSequenceSent: 0, sequence: 0 });

        await job.run();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(0);
    });

    it("Resends the invite once sequence is bumped past inviteSequenceSent.", async () => {
        const event = await createEvent({ inviteSequenceSent: 0, sequence: 1 });

        await job.run();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(1);

        const updated = await calendarEventRepo.findOne({ where: { uid: event.uid } });
        expect(updated!.inviteSequenceSent).toBe(1);
    });

    it("Skips an event with no attendees.", async () => {
        await createEvent({ attendees: [] });

        await job.run();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(0);
    });

    it("Skips an event whose status is already CANCELLED in the invite pass (handled by the cancellation pass instead).", async () => {
        await createEvent({ status: CalendarEventStatus.CANCELLED });

        await job.run();

        // The invite pass never sends a REQUEST for it - only the cancellation pass's own CANCEL goes out.
        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(1);
        expect(transport.sent[0].raw.toString()).toContain("METHOD:CANCEL");
    });

    it("Never sends an invite to an attendee whose address matches the organizer's own.", async () => {
        await createEvent({
            attendees: [
                {
                    address: "organizer@example.com",
                    role: AttendeeRole.REQUIRED,
                    responseStatus: AttendeeResponseStatus.NEEDS_ACTION,
                    isOrganizer: true,
                },
            ],
        });

        await job.run();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(0);
    });

    it("Sends an iTIP CANCEL to attendees for a status: CANCELLED event, and marks cancelNoticeSentAt.", async () => {
        const event = await createEvent({ status: CalendarEventStatus.CANCELLED, inviteSequenceSent: 0 });

        await job.run();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(1);
        expect(transport.sent[0].raw.toString()).toContain("METHOD:CANCEL");

        const updated = await calendarEventRepo.findOne({ where: { uid: event.uid } });
        expect(updated!.cancelNoticeSentAt).toBeTruthy();
    });

    it("Sends an iTIP CANCEL for a soft-deleted event too, without needing status: CANCELLED.", async () => {
        const event = await createEvent({ inviteSequenceSent: 0 });
        await calendarEventRepo.update({ uid: event.uid }, { deleted: true });

        await job.run();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(1);
        expect(transport.sent[0].raw.toString()).toContain("METHOD:CANCEL");
    });

    it("Does not resend a cancellation once cancelNoticeSentAt is already set.", async () => {
        await createEvent({ status: CalendarEventStatus.CANCELLED, cancelNoticeSentAt: new Date() });

        await job.run();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(0);
    });

    it("Recurring meetings: sends a single-occurrence override's own invite independently of its master.", async () => {
        const icalUid = uuid.v4();
        await createEvent({ icalUid, title: "Weekly Sync" });
        const override = await createEvent({
            icalUid,
            title: "Weekly Sync (moved)",
            recurrenceId: new Date(Date.now() + 60 * 60 * 1000),
        });

        await job.run();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(2);
        const overrideMail = transport.sent.find((m) => m.raw.toString().includes("RECURRENCE-ID"));
        expect(overrideMail).toBeDefined();

        const updatedOverride = await calendarEventRepo.findOne({ where: { uid: override.uid } });
        expect(updatedOverride!.inviteSequenceSent).toBe(0);
    });

    it("Recurring meetings: cancelling the master suppresses a redundant CANCEL for its override, but marks both sent.", async () => {
        const icalUid = uuid.v4();
        const master = await createEvent({ icalUid, status: CalendarEventStatus.CANCELLED, inviteSequenceSent: 0 });
        const override = await createEvent({
            icalUid,
            recurrenceId: new Date(Date.now() + 60 * 60 * 1000),
            status: CalendarEventStatus.CANCELLED,
            inviteSequenceSent: 0,
        });

        await job.run();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        // Only the whole-series (master) CANCEL is actually sent - the override's own would be redundant.
        expect(transport.sent.length).toBe(1);

        const updatedMaster = await calendarEventRepo.findOne({ where: { uid: master.uid } });
        const updatedOverride = await calendarEventRepo.findOne({ where: { uid: override.uid } });
        expect(updatedMaster!.cancelNoticeSentAt).toBeTruthy();
        expect(updatedOverride!.cancelNoticeSentAt).toBeTruthy();
    });

    it("Logs a warning and continues when sending to one attendee throws, still marking the event invited.", async () => {
        const event = await createEvent({
            attendees: [
                {
                    address: "bad@example.com",
                    role: AttendeeRole.REQUIRED,
                    responseStatus: AttendeeResponseStatus.NEEDS_ACTION,
                    isOrganizer: false,
                },
                {
                    address: "good@example.com",
                    role: AttendeeRole.REQUIRED,
                    responseStatus: AttendeeResponseStatus.NEEDS_ACTION,
                    isOrganizer: false,
                },
            ],
        });

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        const sendSpy = vi.spyOn(transport, "send").mockImplementationOnce(() => {
            throw new Error("simulated transport failure");
        });

        await expect(job.run()).resolves.toBeUndefined();

        expect(transport.sent.length).toBe(1);
        expect(transport.sent[0].envelopeTo).toEqual(["good@example.com"]);

        const updated = await calendarEventRepo.findOne({ where: { uid: event.uid } });
        expect(updated!.inviteSequenceSent).toBe(0);
        sendSpy.mockRestore();
    });
});
