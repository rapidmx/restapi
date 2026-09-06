///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { request } from "@rapidrest/service-core/test";
import {
    ACLRecord,
    MongoConnection,
    MongoRepository,
    Server,
    ObjectFactory,
    ConnectionManager,
    ACLAction,
} from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { FolderMongo } from "../../../src/models/mongo/FolderMongo.js";
import { CalendarEventMongo } from "../../../src/models/mongo/CalendarEventMongo.js";
import { BusyStatus, CalendarEventStatus, FolderType, RecipientType } from "../../../src/models/types.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:CalendarEventMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/calendar-events";
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let folderRepo: MongoRepository<FolderMongo>;
    let calendarEventRepo: MongoRepository<CalendarEventMongo>;
    let aclRepo: MongoRepository<any>;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);
    const otherUser: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const otherUserToken = JWTUtils.createTokenSync(config.get("auth"), otherUser);

    const createMailbox = async function (ownerUid: string): Promise<MailboxMongo> {
        const obj: MailboxMongo = new MailboxMongo({
            ownerUserUid: ownerUid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Test Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });
        const result: MailboxMongo = await mailboxRepo.save(obj);
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

    const createFolder = async function (mailboxUid: string, data?: any): Promise<FolderMongo> {
        const obj: FolderMongo = new FolderMongo({
            mailboxUid,
            name: "Calendar",
            type: FolderType.CALENDAR,
            unreadCount: 0,
            totalCount: 0,
            syncKeyVersion: 0,
            ...data,
        });
        const result: FolderMongo = await folderRepo.save(obj);
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
    ): Promise<CalendarEventMongo> {
        const now = new Date();
        const obj: CalendarEventMongo = new CalendarEventMongo({
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
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        let conn: any = connMgr?.connections.get("acl");
        if (conn instanceof MongoConnection) {
            aclRepo = conn.getMongoRepository("AccessControlListMongo");
        }
        conn = connMgr?.connections.get("mongo");
        if (conn instanceof MongoConnection) {
            mailboxRepo = conn.getMongoRepository("MailboxMongo");
            folderRepo = conn.getMongoRepository("FolderMongo");
            calendarEventRepo = conn.getMongoRepository("CalendarEventMongo");
        } else {
            throw new Error("Could not find mongo connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        for (const repo of [mailboxRepo, folderRepo, calendarEventRepo]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
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
        const acl = await aclRepo.findOne({ uid: result.body.uid } as any);
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

        // `CalendarEvent` extends `RecoverableBaseEntity` (soft delete) so EAS `Sync` can later report the
        // deletion to an already-synced device - the row itself stays present with `deleted: true` rather
        // than being physically removed. Querying the raw driver directly (bypassing `RepoUtils`'s own
        // default `deleted`-exclusion filtering) surfaces that row, so this checks its `deleted` flag instead
        // of expecting the document to be gone.
        const existing = await calendarEventRepo.findOne({ uid: event.uid } as any);
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

        const existing = await calendarEventRepo.findOne({ uid: event.uid } as any);
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

    // These tests exercise the ACL-native anonymous calendar-sharing mechanism end-to-end: a
    // `CalendarShareLink`'s token is granted as a real `ACLRecord` on the shared folder (see
    // `BaseCalendarShareLinkRoute`), and an unauthenticated caller presenting that token as `?shareToken=` is
    // resolved into a synthetic identity checked by the exact same `ACLUtils.hasPermission()` call every other
    // caller goes through (see `BaseScopedChildRoute`'s `resolveEffectiveUser()`) — there is no separate route.
    describe("Anonymous access via a CalendarShareLink token", () => {
        const shareLinksUrl = "/mongo/calendar-share-links";

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
