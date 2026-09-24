///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { request } from "@rapidrest/service-core/test";
import {
    ACLRecord,
    Server,
    ObjectFactory,
    ConnectionManager,
    ACLAction,
    AccessControlListSQL,
    isSqlDataSource,
} from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { FolderSQL } from "../../../src/models/sql/FolderSQL.js";
import { CalendarEventSQL } from "../../../src/models/sql/CalendarEventSQL.js";
import { MessageSQL } from "../../../src/models/sql/MessageSQL.js";
import { AttendeeResponseStatus, AttendeeRole, BusyStatus, CalendarEventStatus, FolderType, MessageImportance, RecipientType } from "../../../src/models/types.js";
import { calendarInviteSuite, type CalendarInviteSuiteContext } from "../calendarInviteSuite.js";
import { calendarEventDialogSuite } from "../calendarEventDialogSuite.js";
import { registerTestDoubles, RecordingMailTransport, type InMemoryBlobStore } from "../../testDoubles.js";

describe("Route:CalendarEventSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/calendar-events";
    let mailboxRepo: Repository<MailboxSQL>;
    let folderRepo: Repository<FolderSQL>;
    let calendarEventRepo: Repository<CalendarEventSQL>;
    let messageRepo: Repository<MessageSQL>;
    let aclRepo: Repository<AccessControlListSQL>;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);
    const otherUser: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const otherUserToken = JWTUtils.createTokenSync(config.get("auth"), otherUser);

    const createMailbox = async function (ownerUid: string): Promise<MailboxSQL> {
        const obj: MailboxSQL = new MailboxSQL({
            ownerUserUid: ownerUid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Test Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });
        const result: MailboxSQL = await mailboxRepo.save(obj);
        await aclRepo.save({
            uid: result.uid,
            dateCreated: new Date(),
            dateModified: new Date(),
            version: 0,
            records: [{ userOrRoleId: ownerUid, actions: [ACLAction.FULL] }],
            parentUid: "Mailbox",
        });
        return result;
    };

    const createFolder = async function (mailboxUid: string, data?: any): Promise<FolderSQL> {
        const obj: FolderSQL = new FolderSQL({
            mailboxUid,
            name: "Calendar",
            type: FolderType.CALENDAR,
            unreadCount: 0,
            totalCount: 0,
            syncKeyVersion: 0,
            ...data,
        });
        const result: FolderSQL = await folderRepo.save(obj);
        // No explicit records — inherits from the mailbox's ACL via parentUid, same as
        // `BaseFolderRoute.create()`'s own seeding.
        await aclRepo.save({
            uid: result.uid,
            dateCreated: new Date(),
            dateModified: new Date(),
            version: 0,
            records: [],
            parentUid: mailboxUid,
        });
        return result;
    };

    const createCalendarEvent = async function (
        mailboxUid: string,
        folderUid: string,
        data?: any,
    ): Promise<CalendarEventSQL> {
        const now = new Date();
        const obj: CalendarEventSQL = new CalendarEventSQL({
            mailboxUid,
            folderUid,
            title: "Team Sync",
            startDate: now,
            endDate: new Date(now.getTime() + 60 * 60 * 1000),
            allDay: false,
            timezone: "UTC",
            organizer: { address: "organizer@example.com", type: RecipientType.TO },
            attendees: [],
            status: CalendarEventStatus.CONFIRMED,
            busyStatus: BusyStatus.BUSY,
            icalUid: uuid.v4(),
            sequence: 0,
            ...data,
        });
        return await calendarEventRepo.save(obj);
        // Deliberately no ACL document created — CalendarEvent has `recordACL: false`; permission is checked
        // against the containing folder's ACL instead.
    };

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        let conn: any = connMgr?.connections.get("acl");
        if (isSqlDataSource(conn)) {
            aclRepo = conn.getRepository(AccessControlListSQL);
        } else {
            throw new Error("Could not find sql acl connection");
        }
        conn = connMgr?.connections.get("sql");
        if (isSqlDataSource(conn)) {
            mailboxRepo = conn.getRepository(MailboxSQL);
            folderRepo = conn.getRepository(FolderSQL);
            calendarEventRepo = conn.getRepository(CalendarEventSQL);
            messageRepo = conn.getRepository(MessageSQL);
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await calendarEventRepo.clear();
        await messageRepo.clear();
        await folderRepo.clear();
        await mailboxRepo.clear();
        (objectFactory.getInstance<RecordingMailTransport>("MailTransport")!).sent = [];
    });

    it("Requires an explicit folderUid query parameter to list calendar events.", async () => {
        const result = await request(server.getApplication())
            .get(baseUrl)
            .set("Authorization", "jwt " + ownerToken);
        expect(result.status).toBe(400);
    });

    it("Owner can list calendar events in a folder they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        await createCalendarEvent(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.length).toBe(1);
        expect(result.body[0].title).toBe("Team Sync");
    });

    it("A different user cannot list calendar events in a folder they don't have access to (silently empty).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        await createCalendarEvent(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(200);
        expect(result.body).toEqual([]);
    });

    it("Owner can create a calendar event in a folder they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const now = new Date();

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send({
                mailboxUid: mailbox.uid,
                folderUid: folder.uid,
                title: "New Event",
                startDate: now,
                endDate: new Date(now.getTime() + 60 * 60 * 1000),
                allDay: false,
                timezone: "UTC",
                organizer: { address: "organizer@example.com", type: RecipientType.TO },
                attendees: [],
                status: CalendarEventStatus.CONFIRMED,
                busyStatus: BusyStatus.BUSY,
                icalUid: uuid.v4(),
                sequence: 0,
            });

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.title).toBe("New Event");

        // No per-record ACL should have been created for this calendar event (recordACL: false).
        const acl = await aclRepo.findOne({ where: { uid: result.body.uid } });
        expect(acl).toBeNull();
    });

    it("A different user cannot create a calendar event in a folder they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const now = new Date();

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + otherUserToken)
            .send({
                mailboxUid: mailbox.uid,
                folderUid: folder.uid,
                title: "Intruder Event",
                startDate: now,
                endDate: new Date(now.getTime() + 60 * 60 * 1000),
                allDay: false,
                timezone: "UTC",
                organizer: { address: "organizer@example.com", type: RecipientType.TO },
                attendees: [],
                status: CalendarEventStatus.CONFIRMED,
                busyStatus: BusyStatus.BUSY,
                icalUid: uuid.v4(),
                sequence: 0,
            });

        expect(result.status).toBe(403);
    });

    it("Owner can read a calendar event by id.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const event = await createCalendarEvent(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${event.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.uid).toBe(event.uid);
    });

    it("Stores an over-long icalUid from an update bounded, as the model constructor does on create.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const event = await createCalendarEvent(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${event.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: event.uid, version: event.version, icalUid: "u".repeat(400) });

        expect(result.status).toBe(200);
        expect(result.body.icalUid).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it("A different user cannot read a calendar event by id (404, not 403 — avoids existence leakage).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const event = await createCalendarEvent(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${event.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(404);
    });

    it("A different user gets 404 (not 200/1) checking existence of a calendar event they can't access.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const event = await createCalendarEvent(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .head(`${baseUrl}/${event.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(404);
    });

    it("Owner can update a calendar event they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const event = await createCalendarEvent(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${event.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: event.uid, version: event.version, title: "Renamed" });

        expect(result.status).toBe(200);
        expect(result.body.title).toBe("Renamed");
    });

    it("A different user cannot update a calendar event they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const event = await createCalendarEvent(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${event.uid}`)
            .set("Authorization", "jwt " + otherUserToken)
            .send({ uid: event.uid, version: event.version, title: "Hijacked" });

        expect(result.status).toBe(403);
    });

    // `ErasureExecutionJob` purges `CalendarEvent` by `mailboxUid` directly - see
    // `BaseScopedChildRoute.resolveMailboxUidFor()`'s own doc comment for why an independently
    // client-writable `mailboxUid` would let an event silently escape a GDPR erasure scoped to a mailbox
    // it was never really in.
    it("Silently corrects a client-supplied mailboxUid on update() to the event's real folder's mailbox, rather than trusting it.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const event = await createCalendarEvent(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${event.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: event.uid, version: event.version, mailboxUid: "attacker-supplied-uid" });

        expect(result.status).toBe(200);
        expect(result.body.mailboxUid).toBe(mailbox.uid);
        const persisted = await calendarEventRepo.findOne({ where: { uid: event.uid } });
        expect(persisted!.mailboxUid).toBe(mailbox.uid);
    });

    it("Owner can delete a calendar event they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const event = await createCalendarEvent(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${event.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);

        // See the identical note in test/routes/mongo/CalendarEventRoute.test.ts - `CalendarEvent` is now a
        // `RecoverableBaseEntity` (soft delete), so the raw row stays present with `deleted: true`.
        const existing = await calendarEventRepo.findOne({ where: { uid: event.uid } });
        expect(existing?.deleted).toBe(true);
    });

    it("Owner can permanently purge a calendar event via ?purge=true (real hard delete, no soft-delete row left behind).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const event = await createCalendarEvent(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${event.uid}?purge=true`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);

        const existing = await calendarEventRepo.findOne({ where: { uid: event.uid } });
        expect(existing).toBeNull();
    });

    it("Can make a count request scoped to a folder the caller has access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        await createCalendarEvent(mailbox.uid, folder.uid);
        await createCalendarEvent(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .head(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.headers["content-length"]).toBe("2");
    });

    it("A different user's count request for a folder they can't access returns 0.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        await createCalendarEvent(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .head(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(200);
        expect(result.headers["content-length"]).toBe("0");
    });

    describe("Auto-bumped sequence on scheduling-relevant updates", () => {
        it("Bumps sequence when startDate changes.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            const event = await createCalendarEvent(mailbox.uid, folder.uid);
            const newStart = new Date(event.startDate.getTime() + 60 * 60 * 1000);

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${event.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: event.uid, version: event.version, startDate: newStart });

            expect(result.status).toBe(200);
            expect(result.body.sequence).toBe(1);
        });

        it("Bumps sequence when attendees changes.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            const event = await createCalendarEvent(mailbox.uid, folder.uid);

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${event.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({
                    uid: event.uid,
                    version: event.version,
                    attendees: [{ address: "attendee@example.com", role: "required", responseStatus: "needsAction", isOrganizer: false }],
                });

            expect(result.status).toBe(200);
            expect(result.body.sequence).toBe(1);
        });

        it("Bumps sequence when endDate changes.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            const event = await createCalendarEvent(mailbox.uid, folder.uid);
            const newEnd = new Date(event.endDate.getTime() + 60 * 60 * 1000);

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${event.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: event.uid, version: event.version, endDate: newEnd });

            expect(result.status).toBe(200);
            expect(result.body.sequence).toBe(1);
        });

        it("Does not bump sequence when only an unrelated field (title) changes.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            const event = await createCalendarEvent(mailbox.uid, folder.uid);

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${event.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: event.uid, version: event.version, title: "Renamed" });

            expect(result.status).toBe(200);
            expect(result.body.sequence).toBe(0);
        });

        it("Drops the scheduling/reminder jobs' bookkeeping fields from an owner's update, keeping the stored values (round 4).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            const event = await createCalendarEvent(mailbox.uid, folder.uid);

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${event.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({
                    uid: event.uid,
                    version: event.version,
                    title: "Renamed",
                    inviteSequenceSent: 99,
                    cancelNoticeSentAt: new Date(),
                    reminderSentFor: new Date(),
                });

            expect(result.status).toBe(200);
            expect(result.body.title).toBe("Renamed");
            expect(result.body.inviteSequenceSent ?? null).toBeNull();
            expect(result.body.cancelNoticeSentAt ?? null).toBeNull();
            expect(result.body.reminderSentFor ?? null).toBeNull();
        });
    });

    describe("POST /:id/respond", () => {
        const createInvitedEvent = async (mailboxUid: string, folderUid: string, attendeeAddress: string) =>
            createCalendarEvent(mailboxUid, folderUid, {
                organizer: { address: "organizer@example.com", displayName: "Organizer", type: RecipientType.TO },
                attendees: [
                    {
                        address: attendeeAddress,
                        displayName: "Me",
                        role: AttendeeRole.REQUIRED,
                        responseStatus: AttendeeResponseStatus.NEEDS_ACTION,
                        isOrganizer: false,
                    },
                ],
            });

        it("Accepting updates the mailbox's own attendee entry and sends an iTIP REPLY to the organizer.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            const event = await createInvitedEvent(mailbox.uid, folder.uid, mailbox.primarySmtpAddress);

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${event.uid}/respond`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ responseStatus: "accepted" });

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            expect(result.body.attendees[0].responseStatus).toBe("accepted");

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent.length).toBe(1);
            expect(transport.sent[0].envelopeTo).toEqual(["organizer@example.com"]);
            expect(transport.sent[0].raw.toString()).toContain("METHOD:REPLY");
        });

        it("Declining soft-deletes the mailbox's own copy of the event.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            const event = await createInvitedEvent(mailbox.uid, folder.uid, mailbox.primarySmtpAddress);

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${event.uid}/respond`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ responseStatus: "declined" });

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            expect(result.body.uid).toBe(event.uid);

            const existing = await calendarEventRepo.findOne({ where: { uid: event.uid } });
            expect(existing?.deleted).toBe(true);

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            expect(transport.sent.length).toBe(1);
            // `nodemailer`'s `MailComposer` quoted-printable-encodes the `text/calendar` part (escaping `=` as
            // `=3D`), so "PARTSTAT=DECLINED" isn't a literal substring of the raw MIME - "METHOD:REPLY" and the
            // word "DECLINED" both survive that encoding untouched.
            expect(transport.sent[0].raw.toString()).toContain("METHOD:REPLY");
            expect(transport.sent[0].raw.toString()).toContain("DECLINED");
        });

        it("Tentative response updates the attendee entry without deleting the event.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            const event = await createInvitedEvent(mailbox.uid, folder.uid, mailbox.primarySmtpAddress);

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${event.uid}/respond`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ responseStatus: "tentative" });

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            expect(result.body.attendees[0].responseStatus).toBe("tentative");

            const existing = await calendarEventRepo.findOne({ where: { uid: event.uid } });
            expect(existing?.deleted).toBe(false);
        });

        it("Returns 400 for an invalid responseStatus value.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            const event = await createInvitedEvent(mailbox.uid, folder.uid, mailbox.primarySmtpAddress);

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${event.uid}/respond`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ responseStatus: "maybe-later" });

            expect(result.status).toBe(400);
        });

        it("Returns 400 when the calling mailbox has no matching attendee entry on the event.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            const event = await createCalendarEvent(mailbox.uid, folder.uid, {
                organizer: { address: "organizer@example.com", type: RecipientType.TO },
                attendees: [],
            });

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${event.uid}/respond`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ responseStatus: "accepted" });

            expect(result.status).toBe(400);
        });

        it("A different user cannot respond to a calendar event they don't have access to.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            const event = await createInvitedEvent(mailbox.uid, folder.uid, mailbox.primarySmtpAddress);

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${event.uid}/respond`)
                .set("Authorization", "jwt " + otherUserToken)
                .send({ responseStatus: "accepted" });

            expect(result.status).toBe(403);
        });

        it("Responding to a nonexistent calendar event returns 404.", async () => {
            const result = await request(server.getApplication())
                .post(`${baseUrl}/${uuid.v4()}/respond`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ responseStatus: "accepted" });

            expect(result.status).toBe(404);
        });

        it("Still updates the attendee's status even when sending the iTIP REPLY email fails.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            const event = await createInvitedEvent(mailbox.uid, folder.uid, mailbox.primarySmtpAddress);

            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
            const sendSpy = vi.spyOn(transport, "send").mockRejectedValueOnce(new Error("simulated transport failure"));

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${event.uid}/respond`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ responseStatus: "accepted" });

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            expect(result.body.attendees[0].responseStatus).toBe("accepted");
            sendSpy.mockRestore();
        });

        it("Mails no REPLY to an organizer that isn't one plain address, and leaves an address-like mailbox name out of the From.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await mailboxRepo.update({ uid: mailbox.uid }, { displayName: "ceo@bank.example" });
            const folder = await createFolder(mailbox.uid);
            const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;

            const odd = await createInvitedEvent(mailbox.uid, folder.uid, mailbox.primarySmtpAddress);
            await calendarEventRepo.update({ uid: odd.uid }, { organizer: { address: "a@example.com, b@example.com", type: RecipientType.TO } });
            const oddResult = await request(server.getApplication())
                .post(`${baseUrl}/${odd.uid}/respond`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ responseStatus: "accepted" });
            expect(oddResult.status).toBe(200);
            expect(transport.sent).toHaveLength(0);

            const event = await createInvitedEvent(mailbox.uid, folder.uid, mailbox.primarySmtpAddress);
            const result = await request(server.getApplication())
                .post(`${baseUrl}/${event.uid}/respond`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ responseStatus: "accepted" });
            expect(result.status).toBe(200);
            const raw: string = transport.sent[0].raw.toString();
            expect(raw).toMatch(new RegExp(`^From: <?${mailbox.primarySmtpAddress}>?\\r?$`, "m"));
            expect(raw).not.toContain("bank.example");
        });
    });

    describe("Organizer and attendee validation (round 6)", () => {
        const attendee = (address: unknown): any => ({ address, role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION, isOrganizer: false });
        const body = (folderUid: string, mailboxUid: string, data: any): any => ({
            mailboxUid,
            folderUid,
            title: "New Event",
            startDate: new Date(),
            endDate: new Date(Date.now() + 60 * 60 * 1000),
            allDay: false,
            timezone: "UTC",
            organizer: { address: "organizer@example.com", displayName: "ceo@bank.example", type: RecipientType.TO },
            attendees: [attendee("a@example.com")],
            status: CalendarEventStatus.CONFIRMED,
            busyStatus: BusyStatus.BUSY,
            icalUid: uuid.v4(),
            sequence: 0,
            ...data,
        });

        it("Refuses (400) a created or changed organizer or attendee that isn't one plain address, or more than 500 attendees.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            const create = (data: any) => request(server.getApplication()).post(baseUrl).set("Authorization", "jwt " + ownerToken).send(body(folder.uid, mailbox.uid, data));

            for (const data of [
                { organizer: { address: "Boss <boss@example.com>", type: RecipientType.TO } },
                { organizer: "boss@example.com" },
                { attendees: [attendee("a@example.com, b@example.com")] },
                { attendees: [attendee("c@example.com\r\nBcc: d@evil.example")] },
                { attendees: [attendee(undefined)] },
                { attendees: { address: "a@example.com" } },
                { attendees: Array.from({ length: 501 }, (_, i) => attendee(`a${i}@example.com`)) },
            ]) {
                const result = await create(data);
                expect({ data: JSON.stringify(data).slice(0, 80), status: result.status }).toEqual({ data: JSON.stringify(data).slice(0, 80), status: 400 });
            }
            // Fine: plain addresses (an organizer's display name is kept, the job doesn't mail it), 500 attendees, none.
            expect((await create({})).status).toBe(200);
            expect((await create({ attendees: Array.from({ length: 500 }, (_, i) => attendee(`a${i}@example.com`)) })).status).toBe(200);
            expect((await create({ organizer: { address: "", type: RecipientType.TO }, attendees: [] })).status).toBe(200);

            // An update is only checked when it changes them, so a received event's list still round-trips.
            const received = await createCalendarEvent(mailbox.uid, folder.uid, {
                attendees: [attendee("x@example.com"), attendee("Odd <y@example.com>")],
            });
            const roundTrip = await request(server.getApplication())
                .put(`${baseUrl}/${received.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: received.uid, version: received.version, title: "Renamed", attendees: received.attendees, organizer: received.organizer });
            expect(roundTrip.status).toBe(200);
            const changed = await request(server.getApplication())
                .put(`${baseUrl}/${received.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: received.uid, version: roundTrip.body.version, attendees: [...received.attendees, attendee("z@example.com;w@example.com")] });
            expect(changed.status).toBe(400);
        });
    });

    // See the identical describe block in test/routes/mongo/CalendarEventRoute.test.ts for the full rationale:
    // this exercises the ACL-native anonymous calendar-sharing mechanism (no separate route/token-lookup) on
    // the SQL-backed variant.
    describe("Anonymous access via a CalendarShareLink token", () => {
        const shareLinksUrl = "/sql/calendar-share-links";

        it("An anonymous caller with a valid share token can list calendar events in the shared folder.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            await createCalendarEvent(mailbox.uid, folder.uid);

            // `list` is a distinct `ACLAction` from `read` - a link's `permittedActions` must include it
            // explicitly to permit enumeration, same as any other ACL record would.
            const link = await request(server.getApplication())
                .post(shareLinksUrl)
                .set("Authorization", "jwt " + ownerToken)
                .send({ folderUid: folder.uid, permittedActions: ["list", "read"], createdByUserUid: owner.uid });
            expect(link.status).toBeLessThan(300);

            const result = await request(server.getApplication()).get(
                `${baseUrl}?folderUid=${folder.uid}&shareToken=${link.body.token}`,
            );

            expect(result.status).toBe(200);
            expect(result.body.length).toBe(1);
            expect(result.body[0].title).toBe("Team Sync");
        });

        it("An anonymous caller with a valid share token can read a specific calendar event by id.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            const event = await createCalendarEvent(mailbox.uid, folder.uid);

            const link = await request(server.getApplication())
                .post(shareLinksUrl)
                .set("Authorization", "jwt " + ownerToken)
                .send({ folderUid: folder.uid, permittedActions: ["read"], createdByUserUid: owner.uid });

            const result = await request(server.getApplication()).get(
                `${baseUrl}/${event.uid}?shareToken=${link.body.token}`,
            );

            expect(result.status).toBe(200);
            expect(result.body.uid).toBe(event.uid);
        });

        it("An anonymous caller with no share token gets an empty list, not an error.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            await createCalendarEvent(mailbox.uid, folder.uid);

            const result = await request(server.getApplication()).get(`${baseUrl}?folderUid=${folder.uid}`);

            expect(result.status).toBe(200);
            expect(result.body).toEqual([]);
        });

        it("An anonymous caller with an unknown/bogus share token gets an empty list, not access.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            await createCalendarEvent(mailbox.uid, folder.uid);

            const result = await request(server.getApplication()).get(
                `${baseUrl}?folderUid=${folder.uid}&shareToken=not-a-real-token`,
            );

            expect(result.status).toBe(200);
            expect(result.body).toEqual([]);
        });

        it("Revoking (deleting) a share link immediately cuts off the anonymous access it granted.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            await createCalendarEvent(mailbox.uid, folder.uid);

            const link = await request(server.getApplication())
                .post(shareLinksUrl)
                .set("Authorization", "jwt " + ownerToken)
                .send({ folderUid: folder.uid, permittedActions: ["read"], createdByUserUid: owner.uid });

            await request(server.getApplication())
                .delete(`${shareLinksUrl}/${link.body.uid}`)
                .set("Authorization", "jwt " + ownerToken);

            const result = await request(server.getApplication()).get(
                `${baseUrl}?folderUid=${folder.uid}&shareToken=${link.body.token}`,
            );

            expect(result.status).toBe(200);
            expect(result.body).toEqual([]);
        });
    });

    const suiteContext: CalendarInviteSuiteContext = {
        app: () => server.getApplication(),
        baseUrl,
        ownerToken,
        otherToken: otherUserToken,
        ownerUid: owner.uid,
        blobStore: () => objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!,
        transport: () => objectFactory.getInstance<RecordingMailTransport>("MailTransport")!,
        createMailbox,
        createFolder: (mailboxUid, type) => createFolder(mailboxUid, { type, name: type }),
        createCalendarEvent,
        createMessage: async (mailboxUid, folderUid, data) =>
            await messageRepo.save(
                new MessageSQL({
                    mailboxUid,
                    folderUid,
                    messageId: `${uuid.v4()}@example.com`,
                    subject: "Invitation: Video Test",
                    from: { address: "owner@example.com", type: RecipientType.TO },
                    recipients: [{ address: "recipient@example.com", type: RecipientType.TO }],
                    sentDate: new Date(),
                    receivedDate: new Date(),
                    bodyBlobKey: `bodies/${uuid.v4()}`,
                    bodyPreview: "Hello",
                    flags: { read: false, flagged: false, answered: false, forwarded: false },
                    importance: MessageImportance.NORMAL,
                    references: [],
                    hasAttachments: false,
                    ...data,
                }),
            ),
        findMessage: async (uid) => (await messageRepo.findOne({ where: { uid } }))!,
        findEvents: async (mailboxUid) => (await calendarEventRepo.find({ where: { mailboxUid } })).filter((row: any) => !row.deleted),
    };
    calendarInviteSuite(suiteContext);
    calendarEventDialogSuite({
        ...suiteContext,
        otherUid: otherUser.uid,
        grantFolder: async (folderUid, userUid, actions) => {
            const acl: any = await aclRepo.findOne({ where: { uid: folderUid } });
            acl.records = [...acl.records, { userOrRoleId: userUid, actions }];
            await aclRepo.save(acl);
        },
        findEvent: async (uid) => (await calendarEventRepo.findOne({ where: { uid } }))!,
        shareLinksUrl: "/sql/calendar-share-links",
    });
});
