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
import { CalendarEventAttendeeLinkSQL } from "../../../src/models/sql/CalendarEventAttendeeLinkSQL.js";
import { CalendarEventSQL } from "../../../src/models/sql/CalendarEventSQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { meetingSchedulingLinkSuite } from "../meetingSchedulingLinkSuite.js";
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
    let mailboxRepo: Repository<MailboxSQL>;
    let attendeeLinkRepo: Repository<CalendarEventAttendeeLinkSQL>;

    const mailboxUid = uuid.v4();
    /** A second mailbox whose organizer identity is one of its alias addresses, not its primary one. */
    const aliasMailboxUid = uuid.v4();
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

    const reload = async (uid: string): Promise<CalendarEventSQL | null> => await calendarEventRepo.findOne({ where: { uid } });
    const bumpVersion = async (uid: string): Promise<void> => {
        await calendarEventRepo.increment({ uid }, "version", 1);
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
        models.set("CalendarEventAttendeeLinkSQL", CalendarEventAttendeeLinkSQL);
        models.set("MailboxSQL", MailboxSQL);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        calendarEventRepo = conn.getRepository(CalendarEventSQL);
        mailboxRepo = conn.getRepository(MailboxSQL);
        attendeeLinkRepo = conn.getRepository(CalendarEventAttendeeLinkSQL);
        await mailboxRepo.clear();

        // The organizer's own mailbox (primary address = the default test organizer), and one whose organizer
        // identity is an alias. Rows in any other mailbox are attendee copies this job must never send for.
        await mailboxRepo.save(
            new MailboxSQL({
                uid: mailboxUid,
                primarySmtpAddress: "organizer@example.com",
                aliasAddresses: [],
                displayName: "Organizer",
                timezone: "UTC",
                quotaBytes: 1_000_000_000,
                usedBytes: 0,
            } as any),
        );
        await mailboxRepo.save(
            new MailboxSQL({
                uid: aliasMailboxUid,
                primarySmtpAddress: "other@example.com",
                aliasAddresses: ["boss@example.com"],
                displayName: "Boss",
                timezone: "UTC",
                quotaBytes: 1_000_000_000,
                usedBytes: 0,
            } as any),
        );

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

        const updated = await calendarEventRepo.findOne({ where: { uid: pending.uid } });
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

        const updated = await calendarEventRepo.findOne({ where: { uid: event.uid } });
        expect(updated!.cancelNoticeSentAt).toBeTruthy();
    });

    it("Never composes/sends a plaintext iTIP REQUEST for an event the organizer chose to encrypt (encryptionOrigin: 'originated') - that's the client's own responsibility - but still marks inviteSequenceSent so this job stops re-visiting it.", async () => {
        const event = await createEvent({ encryptionOrigin: "originated" });

        await job.run();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(0);

        const updated = await calendarEventRepo.findOne({ where: { uid: event.uid } });
        expect(updated!.inviteSequenceSent).toBe(event.sequence);
    });

    it("Never composes/sends a plaintext iTIP CANCEL for an encryptionOrigin: 'originated' event either, but still marks cancelNoticeSentAt.", async () => {
        const event = await createEvent({ status: CalendarEventStatus.CANCELLED, encryptionOrigin: "originated" });

        await job.run();

        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        expect(transport.sent.length).toBe(0);

        const updated = await calendarEventRepo.findOne({ where: { uid: event.uid } });
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

    describe("Attendee copies edited/deleted by a client, and batch starvation", () => {
        const transport = (): RecordingMailTransport => objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        const remoteOrganizer = { address: "someone@remote.example", displayName: "Remote", type: RecipientType.TO };
        // What an ActiveSync/MAPI client's delete/edit of a synced row amounts to at the storage level.
        const clientEdit = async (uid: string, changes: Record<string, any>): Promise<void> => {
            await calendarEventRepo.update({ uid }, { ...changes, dateModified: new Date() });
            await calendarEventRepo.increment({ uid }, "version", 1);
        };
        const softDelete = async (uid: string): Promise<void> => await clientEdit(uid, { deleted: true });
        const withBatching = async (batchSize: number, maxPages: number, fn: () => Promise<void>): Promise<void> => {
            const original = { batchSize: (job as any).batchSize, maxPages: (job as any).maxPages };
            (job as any).batchSize = batchSize;
            (job as any).maxPages = maxPages;
            try {
                await fn();
            } finally {
                Object.assign(job as any, original);
            }
        };

        it("Sends no CANCEL when a client deletes an attendee copy of someone else's meeting, but stamps cancelNoticeSentAt.", async () => {
            // As ScanQueueJob creates it on receipt of the invite: already marked as invited.
            const event = await createEvent({ organizer: remoteOrganizer, inviteSequenceSent: 0, sequence: 0 });
            await softDelete(event.uid);

            await job.run();

            expect(transport().sent.length).toBe(0);
            const updated: any = await reload(event.uid);
            expect(updated.cancelNoticeSentAt).toBeTruthy();
        });

        it("Sends no REQUEST when a client edits an attendee copy (bumping sequence), but stamps inviteSequenceSent.", async () => {
            const event = await createEvent({ organizer: remoteOrganizer, inviteSequenceSent: 0, sequence: 0 });
            await job.run();
            await clientEdit(event.uid, { sequence: 1, title: "Edited locally" });

            await job.run();

            expect(transport().sent.length).toBe(0);
            expect((await reload(event.uid))!.inviteSequenceSent).toBe(1);
        });

        it("Sends only from the organizer's own copy when both it and a local attendee's copy of the same meeting are edited and deleted.", async () => {
            const icalUid = uuid.v4();
            // A local attendee's copy lives in a mailbox that doesn't own organizer@example.com.
            const attendeeCopy = await createEvent({ icalUid, mailboxUid: aliasMailboxUid, inviteSequenceSent: 0, sequence: 0 });
            const organizerCopy = await createEvent({ icalUid, inviteSequenceSent: 0, sequence: 0 });
            await clientEdit(attendeeCopy.uid, { sequence: 1 });
            await clientEdit(organizerCopy.uid, { sequence: 1 });

            await job.run();
            expect(transport().sent.length).toBe(1);
            expect(transport().sent[0].raw.toString()).toContain("METHOD:REQUEST");

            transport().sent = [];
            await softDelete(attendeeCopy.uid);
            await job.run();
            expect(transport().sent.length).toBe(0);
        });

        it("Stamps attendee-less cancelled rows so they can't starve a real cancellation behind them.", async () => {
            await withBatching(3, 10, async () => {
                const old = new Date(Date.now() - 60 * 60 * 1000);
                const empties: any[] = [];
                for (let i = 0; i < 5; i++) {
                    empties.push(await createEvent({ attendees: [], status: CalendarEventStatus.CANCELLED, dateModified: old }));
                }
                await createEvent({ status: CalendarEventStatus.CANCELLED });

                await job.run();
                await job.run();

                expect(transport().sent.length).toBe(1);
                expect(transport().sent[0].raw.toString()).toContain("METHOD:CANCEL");
                for (const empty of empties) {
                    expect((await reload(empty.uid))!.cancelNoticeSentAt).toBeTruthy();
                }
            });
        });

        it("A process's first run also catches up on invites for rows last modified before it started, without delaying new ones.", async () => {
            await withBatching(2, 1, async () => {
                (job as any).liveInviteCursor = undefined;
                const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
                const stale: any[] = [];
                for (let i = 0; i < 3; i++) {
                    stale.push(await createEvent({ dateModified: old, attendees: [{ address: `old${i}@example.com`, role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION, isOrganizer: false }] }));
                }
                expect(new Date((await reload(stale[0].uid))!.dateModified).getTime()).toBe(old.getTime());
                await createEvent({ attendees: [{ address: "new@example.com", role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION, isOrganizer: false }] });

                await job.run();
                expect(transport().sent.map((m) => m.envelopeTo[0])).toContain("new@example.com");
                expect(transport().sent.length).toBe(3);
                expect((job as any).catchUpInviteCursor).toBeDefined();

                await job.run();
                expect(transport().sent.map((m) => m.envelopeTo[0]).sort()).toEqual(["new@example.com", "old0@example.com", "old1@example.com", "old2@example.com"]);
                expect((job as any).catchUpInviteCursor).toBeUndefined();
            });
        });

        it("Sends every pending invite when more than batch_size need one - rows the job itself just stamped never block the rest.", async () => {
            await withBatching(3, 1, async () => {
                const pending: any[] = [];
                for (let i = 0; i < 7; i++) {
                    pending.push(await createEvent({ attendees: [{ address: `a${i}@example.com`, role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION, isOrganizer: false }] }));
                }

                for (let i = 0; i < 4; i++) {
                    await job.run();
                }

                expect(transport().sent.map((m) => m.envelopeTo[0]).sort()).toEqual(pending.map((_, i) => `a${i}@example.com`).sort());
                for (const event of pending) {
                    expect((await reload(event.uid))!.inviteSequenceSent).toBe(0);
                }

                // And a brand-new event after all that still goes out on the next run.
                transport().sent = [];
                await createEvent();
                await job.run();
                await job.run();
                expect(transport().sent.length).toBe(1);
            });
        });
    });

    describe("Round 6 (part A): organizer display name, attendee cap and validation, scanning", () => {
        const mail = (): RecordingMailTransport => objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        const attendee = (address: string, displayName?: string): any => ({
            address,
            displayName,
            role: AttendeeRole.REQUIRED,
            responseStatus: AttendeeResponseStatus.NEEDS_ACTION,
            isOrganizer: false,
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it("Sends as the mailbox's own display name, never the stored organizer display name, and omits an address-like one.", async () => {
            await createEvent({
                organizer: { address: "organizer@example.com", displayName: "ceo@bank.example", type: RecipientType.TO },
                attendees: [attendee("attendee@example.com", "boss＠bank.example")],
            });
            await job.run();
            const raw: string = mail().sent[0].raw.toString();
            expect(raw).toMatch(/^From: "?Organizer"? <organizer@example\.com>/m);
            // (Every calendar line is folded to 75 octets now, so the file is 7bit rather than quoted-printable - `=3D` for `=`.)
            expect(raw).toMatch(/ORGANIZER;CN=(?:3D)?"Organizer":mailto:organizer@example\.com/);
            expect(raw).not.toContain("bank.example");

            const spoofyUid = uuid.v4();
            await mailboxRepo.save(
                new MailboxSQL({
                    uid: spoofyUid,
                    primarySmtpAddress: "spoofy@example.com",
                    aliasAddresses: [],
                    displayName: "ceo@bank.example",
                    timezone: "UTC",
                    quotaBytes: 1_000_000_000,
                    usedBytes: 0,
                }),
            );
            mail().sent = [];
            await createEvent({ mailboxUid: spoofyUid, organizer: { address: "spoofy@example.com", displayName: "Spoofy", type: RecipientType.TO } });
            await job.run();
            const spoofy: string = mail().sent[0].raw.toString();
            expect(spoofy).toMatch(/^From: <?spoofy@example\.com>?\r?$/m);
            expect(spoofy).toContain("ORGANIZER:mailto:spoofy@example.com");
            expect(spoofy).not.toContain("bank.example");
        });

        it("Skips attendees that aren't plain addresses, and mails each remaining attendee once.", async () => {
            const warnSpy = vi.spyOn((job as any).logger, "warn");
            await createEvent({
                attendees: [
                    attendee("a@example.com, b@example.com"),
                    attendee("Name <carol@example.com>"),
                    attendee("d@example.com\r\nBcc: e@evil.example"),
                    attendee("good@example.com"),
                    attendee("GOOD@example.com"),
                    attendee(""),
                ],
            });
            await job.run();
            expect(mail().sent.map((m) => m.envelopeTo)).toEqual([["good@example.com"]]);
            const raw: string = mail().sent[0].raw.toString();
            expect(raw).not.toContain("carol@");
            expect(raw).not.toContain("evil.example");
            expect(warnSpy.mock.calls.filter((call) => String(call[0]).includes("isn't a plain address"))).toHaveLength(3);
        });

        it("Mails no invite or cancellation for an event with more attendees than max_attendees, logging an error.", async () => {
            const original = (job as any).maxAttendees;
            (job as any).maxAttendees = 2;
            const errorSpy = vi.spyOn((job as any).logger, "error");
            try {
                const tooMany = [attendee("x1@example.com"), attendee("x2@example.com"), attendee("x3@example.com")];
                const invite = await createEvent({ attendees: tooMany });
                await createEvent({ attendees: tooMany, status: CalendarEventStatus.CANCELLED, inviteSequenceSent: 0 });
                await job.run();
                expect(mail().sent).toHaveLength(0);
                expect(errorSpy.mock.calls.filter((call) => String(call[0]).includes("more than the 2 allowed"))).toHaveLength(2);
                expect((await reload(invite.uid))!.inviteSequenceSent).toBe(0);

                await createEvent({ attendees: tooMany.slice(0, 2) });
                await job.run();
                expect(mail().sent.map((m) => m.envelopeTo[0]).sort()).toEqual(["x1@example.com", "x2@example.com"]);
            } finally {
                (job as any).maxAttendees = original;
            }
        });

        it("Scans the invite first, and relays nothing the scan refuses.", async () => {
            const warnSpy = vi.spyOn((job as any).logger, "warn");
            await createEvent({ title: "X-Test-Force-Spam: true" });
            await job.run();
            expect(mail().sent).toHaveLength(0);
            expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("failed to process invites"))).toBe(true);
        });
    });

    meetingSchedulingLinkSuite({
        job: () => job as any,
        transport: () => objectFactory.getInstance<RecordingMailTransport>("MailTransport")!,
        mailboxUid: () => mailboxUid,
        createEvent: async (data?: any) => await createEvent(data),
        createLink: async (link) => {
            await attendeeLinkRepo.save(new CalendarEventAttendeeLinkSQL(link));
        },
        clearLinks: async () => {
            await attendeeLinkRepo.clear();
        },
        reload: async (uid: string) => await reload(uid),
    });
});
