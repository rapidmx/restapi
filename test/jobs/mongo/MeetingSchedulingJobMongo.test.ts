///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for MeetingSchedulingJobMongo: a real in-memory MongoDB connection and a
// real `ObjectFactory` construct the job exactly as production wiring would - its own `@Init` builds a real
// `RepoUtils` against the live connection, and `@Inject("MailTransport")` resolves to the registered
// `RecordingMailTransport` test double (real MIME composition via `nodemailer`'s `MailComposer`, only the
// actual network relay is faked). See ScanQueueJobMongo.test.ts's file header for the full rationale behind
// bypassing `Server`/`ClassLoader`.
import { MongoMemoryServer } from "mongodb-memory-server";
import { ACLUtils, ConnectionManager, MongoConnection, MongoRepository, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../../config.js";
import { registerTestDoubles, RecordingMailTransport } from "../../testDoubles.js";
import { MeetingSchedulingJobMongo } from "../../../src/jobs/mongo/MeetingSchedulingJobMongo.js";
import { CalendarEventMongo } from "../../../src/models/mongo/CalendarEventMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import {
    AttendeeResponseStatus,
    AttendeeRole,
    BusyStatus,
    CalendarEventStatus,
    RecipientType,
} from "../../../src/models/types.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("MeetingSchedulingJobMongo Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: MeetingSchedulingJobMongo;
    let calendarEventRepo: MongoRepository<CalendarEventMongo>;
    let mailboxRepo: MongoRepository<MailboxMongo>;

    const mailboxUid = uuid.v4();
    /** A second mailbox whose organizer identity is one of its alias addresses, not its primary one. */
    const aliasMailboxUid = uuid.v4();
    const folderUid = uuid.v4();

    const createEvent = async (data?: Partial<CalendarEventMongo>): Promise<CalendarEventMongo> => {
        const obj = new CalendarEventMongo({
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

    const reload = async (uid: string): Promise<CalendarEventMongo | null> => await calendarEventRepo.findOne({ uid } as any);
    const bumpVersion = async (uid: string): Promise<void> => {
        await calendarEventRepo.updateOne({ uid } as any, { $inc: { version: 1 } } as any);
    };

    beforeAll(async () => {
        await mongod.start();
        objectFactory = new ObjectFactory(config, logger);
        registerTestDoubles(objectFactory);
        // Normally registered by `Server`'s own bootstrap - registered explicitly here since this file
        // deliberately bypasses `Server` (see ScanQueueJobMongo.test.ts's header comment).
        objectFactory.register(ACLUtils);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("CalendarEventMongo", CalendarEventMongo);
        models.set("MailboxMongo", MailboxMongo);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        calendarEventRepo = conn.getMongoRepository("CalendarEventMongo");
        mailboxRepo = conn.getMongoRepository("MailboxMongo");
        await mailboxRepo.clear().catch(() => undefined);

        // The organizer's own mailbox (primary address = the default test organizer), and one whose organizer
        // identity is an alias. Rows in any other mailbox are attendee copies this job must never send for.
        await mailboxRepo.save(
            new MailboxMongo({
                uid: mailboxUid,
                primarySmtpAddress: "organizer@example.com",
                aliasAddresses: [],
                displayName: "Organizer",
                timezone: "UTC",
                quotaBytes: 1_000_000_000,
                usedBytes: 0,
            }),
        );
        await mailboxRepo.save(
            new MailboxMongo({
                uid: aliasMailboxUid,
                primarySmtpAddress: "other@example.com",
                aliasAddresses: ["boss@example.com"],
                displayName: "Boss",
                timezone: "UTC",
                quotaBytes: 1_000_000_000,
                usedBytes: 0,
            }),
        );

        // Constructed once via real ObjectFactory DI: `@Init` builds its real `RepoUtils` against the live
        // connection above, and `@Inject("MailTransport")` resolves to the registered test double.
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

        const updated = await calendarEventRepo.findOne({ uid: event.uid } as any);
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

        const updated = await calendarEventRepo.findOne({ uid: event.uid } as any);
        expect(updated!.inviteSequenceSent).toBe(1);
    });

    it("Still sends an invite for a genuinely new event even when the table already holds batch_size other, already-invited events - proves the query is no longer an unfiltered/unsorted top-N that a large table could permanently starve.", async () => {
        const batchSize: number = config.get("mail:jobs:meeting_scheduling:batch_size");
        const old = new Date(2020, 0, 1);
        for (let i = 0; i < batchSize; i++) {
            await createEvent({ inviteSequenceSent: 0, sequence: 0, dateCreated: old, dateModified: old });
        }
        // The one genuinely pending event - created last, so on the old unsorted/unfiltered query it would
        // sort after all `batchSize` already-processed rows and never be fetched at all.
        const pending = await createEvent({ inviteSequenceSent: undefined, sequence: 0 });

        await job.run();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(1);

        const updated = await calendarEventRepo.findOne({ uid: pending.uid } as any);
        expect(updated!.inviteSequenceSent).toBe(0);
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

        const updated = await calendarEventRepo.findOne({ uid: event.uid } as any);
        expect(updated!.cancelNoticeSentAt).toBeTruthy();
    });

    it("Never composes/sends a plaintext iTIP REQUEST for an event the organizer chose to encrypt (encryptionOrigin: 'originated') - that's the client's own responsibility - but still marks inviteSequenceSent so this job stops re-visiting it.", async () => {
        const event = await createEvent({ encryptionOrigin: "originated" });

        await job.run();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(0);

        const updated = await calendarEventRepo.findOne({ uid: event.uid } as any);
        expect(updated!.inviteSequenceSent).toBe(event.sequence);
    });

    it("Never composes/sends a plaintext iTIP CANCEL for an encryptionOrigin: 'originated' event either, but still marks cancelNoticeSentAt.", async () => {
        const event = await createEvent({ status: CalendarEventStatus.CANCELLED, encryptionOrigin: "originated" });

        await job.run();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(0);

        const updated = await calendarEventRepo.findOne({ uid: event.uid } as any);
        expect(updated!.cancelNoticeSentAt).toBeTruthy();
    });

    it("Still sends a plaintext invite normally for encryptionOrigin: 'derived' (an inbound-received provenance flag, not an outbound-encrypt instruction).", async () => {
        await createEvent({ encryptionOrigin: "derived" });

        await job.run();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(1);
    });

    it("Sends an iTIP CANCEL for a soft-deleted event too, without needing status: CANCELLED.", async () => {
        const event = await createEvent({ inviteSequenceSent: 0 });
        await calendarEventRepo.updateOne({ uid: event.uid } as any, { $set: { deleted: true } } as any);

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

    it("Never sends a cancellation to an attendee whose address matches the organizer's own.", async () => {
        await createEvent({
            status: CalendarEventStatus.CANCELLED,
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

    it("Logs a warning and continues when a cancellation send to one attendee throws, still marking it sent.", async () => {
        const event = await createEvent({
            status: CalendarEventStatus.CANCELLED,
            attendees: [
                { address: "bad@example.com", role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION, isOrganizer: false },
                { address: "good@example.com", role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION, isOrganizer: false },
            ],
        });

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        const sendSpy = vi.spyOn(transport, "send").mockImplementationOnce(() => {
            throw new Error("simulated transport failure");
        });

        await expect(job.run()).resolves.toBeUndefined();

        expect(transport.sent.length).toBe(1);
        expect(transport.sent[0].envelopeTo).toEqual(["good@example.com"]);

        const updated = await calendarEventRepo.findOne({ uid: event.uid } as any);
        expect(updated!.cancelNoticeSentAt).toBeTruthy();
        sendSpy.mockRestore();
    });

    it("Logs a warning and continues when processing invites for one event throws.", async () => {
        const updateSpy = vi.spyOn((job as any).calendarEventRepo, "update").mockRejectedValueOnce(new Error("simulated database failure"));

        await createEvent();

        await expect(job.run()).resolves.toBeUndefined();

        updateSpy.mockRestore();
    });

    it("Logs a warning and continues when processing a cancellation for one event throws.", async () => {
        await createEvent({ status: CalendarEventStatus.CANCELLED });
        const updateSpy = vi.spyOn((job as any).calendarEventRepo, "update").mockRejectedValueOnce(new Error("simulated database failure"));

        await expect(job.run()).resolves.toBeUndefined();

        updateSpy.mockRestore();
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

        const updatedOverride = await calendarEventRepo.findOne({ uid: override.uid } as any);
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

        const updatedMaster = await calendarEventRepo.findOne({ uid: master.uid } as any);
        const updatedOverride = await calendarEventRepo.findOne({ uid: override.uid } as any);
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

        const updated = await calendarEventRepo.findOne({ uid: event.uid } as any);
        expect(updated!.inviteSequenceSent).toBe(0);
        sendSpy.mockRestore();
    });

    describe("Organizer ownership and claim-then-send", () => {
        const remoteOrganizer = { address: "someone@remote.example", displayName: "Remote", type: RecipientType.TO };

        it("Never sends an invite for an attendee's copy of someone else's meeting, but stamps inviteSequenceSent so it drops out.", async () => {
            const event = await createEvent({ organizer: remoteOrganizer, sequence: 2 });

            await job.run();

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent.length).toBe(0);
            const updated: any = await reload(event.uid);
            expect(updated.inviteSequenceSent).toBe(2);
        });

        it("Never sends a CANCEL for an attendee's copy of someone else's meeting, but stamps cancelNoticeSentAt.", async () => {
            const event = await createEvent({ organizer: remoteOrganizer, status: CalendarEventStatus.CANCELLED });

            await job.run();

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent.length).toBe(0);
            const updated: any = await reload(event.uid);
            expect(updated.cancelNoticeSentAt).toBeTruthy();
        });

        it("Treats an organizer matching one of the mailbox's alias addresses (case-insensitively) as the organizer's own copy.", async () => {
            await createEvent({
                mailboxUid: aliasMailboxUid,
                organizer: { address: "Boss@EXAMPLE.com", displayName: "Boss", type: RecipientType.TO },
            });

            await job.run();

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent.length).toBe(1);
            expect(transport.sent[0].envelopeFrom).toBe("Boss@EXAMPLE.com");
        });

        it("Sends nothing when the owning mailbox no longer exists, but still stamps the row.", async () => {
            const event = await createEvent({ mailboxUid: uuid.v4() });

            await job.run();

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent.length).toBe(0);
            const updated: any = await reload(event.uid);
            expect(updated.inviteSequenceSent).toBe(0);
        });

        it("Sends nothing when another replica claims the row between this replica's read and its claim (version conflict).", async () => {
            const event = await createEvent();
            const repo: any = (job as any).calendarEventRepo;
            const realFind = repo.find.bind(repo);
            let bumped = false;
            const findSpy = vi.spyOn(repo, "find").mockImplementation(async (...args: any[]) => {
                const rows = await realFind(...args);
                if (!bumped) {
                    bumped = true;
                    // Another replica's claim lands after this replica read the row.
                    await bumpVersion(event.uid);
                }
                return rows;
            });

            try {
                await job.run();
            } finally {
                findSpy.mockRestore();
            }

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent.length).toBe(0);
        });

        it("Sends nothing for an event with no organizer address (never the organizer's own copy), but still stamps the row.", async () => {
            const event = await createEvent({ organizer: { address: "", displayName: "Nobody", type: RecipientType.TO }, sequence: 1 });

            await job.run();

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent.length).toBe(0);
            const updated: any = await reload(event.uid);
            expect(updated.inviteSequenceSent).toBe(1);
        });

        it("Sends no CANCEL when another replica claims the cancelled row between this replica's read and its claim (version conflict).", async () => {
            const event = await createEvent({ status: CalendarEventStatus.CANCELLED });
            const repo: any = (job as any).calendarEventRepo;
            const realFind = repo.find.bind(repo);
            let bumped = false;
            const findSpy = vi.spyOn(repo, "find").mockImplementation(async (...args: any[]) => {
                const rows = await realFind(...args);
                if (!bumped && args[0]?.status === CalendarEventStatus.CANCELLED) {
                    bumped = true;
                    await bumpVersion(event.uid);
                }
                return rows;
            });

            try {
                await job.run();
            } finally {
                findSpy.mockRestore();
            }

            expect(bumped).toBe(true);
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent.length).toBe(0);
            const updated: any = await reload(event.uid);
            expect(updated.cancelNoticeSentAt ?? null).toBeNull();
        });

        it("Treats a transport-reported recipient rejection as a failed send (logged), still sending to the other attendees and keeping the row claimed.", async () => {
            const event = await createEvent({
                attendees: [
                    { address: "reject@example.com", role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION, isOrganizer: false },
                    { address: "good@example.com", role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION, isOrganizer: false },
                ],
            });
            const warnSpy = vi.spyOn((job as any).logger, "warn");

            await job.run();

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent.map((m) => m.envelopeTo)).toEqual([["good@example.com"]]);
            expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("reject@example.com"))).toBe(true);
            warnSpy.mockRestore();
            const updated: any = await reload(event.uid);
            expect(updated.inviteSequenceSent).toBe(0);
        });
    });
});
