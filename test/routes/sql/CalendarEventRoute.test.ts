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
import { BusyStatus, CalendarEventStatus, FolderType, RecipientType } from "../../../src/models/types.js";
import { registerTestDoubles } from "../../testDoubles.js";

describe("Route:CalendarEventSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/calendar-events";
    let mailboxRepo: Repository<MailboxSQL>;
    let folderRepo: Repository<FolderSQL>;
    let calendarEventRepo: Repository<CalendarEventSQL>;
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
        await folderRepo.clear();
        await mailboxRepo.clear();
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
});
