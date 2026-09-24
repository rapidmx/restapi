///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager, ACLAction } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { FolderMongo } from "../../../src/models/mongo/FolderMongo.js";
import { CalendarEventMongo } from "../../../src/models/mongo/CalendarEventMongo.js";
import { BusyStatus, CalendarEventStatus, FolderType, RecipientType } from "../../../src/models/types.js";
import { freeBusySuite } from "../freeBusySuite.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:FreeBusyMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let folderRepo: MongoRepository<FolderMongo>;
    let calendarEventRepo: MongoRepository<CalendarEventMongo>;
    let aclRepo: MongoRepository<any>;

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

    freeBusySuite({
        config,
        app: () => server.getApplication(),
        calendarUrl: "/mongo/calendar-events",
        mailboxUrl: "/mongo/mailboxes",
        saveMailbox: async (fields, records = []) => {
            const result: MailboxMongo = await mailboxRepo.save(
                new MailboxMongo({
                    aliasAddresses: [],
                    displayName: "Test Mailbox",
                    timezone: "UTC",
                    quotaBytes: 1_000_000_000,
                    usedBytes: 0,
                    ...fields,
                }),
            );
            await aclRepo.save({
                uid: result.uid,
                dateCreated: new Date(),
                dateModified: new Date(),
                version: 0,
                records: [...(result.ownerUserUid ? [{ userOrRoleId: result.ownerUserUid, actions: [ACLAction.FULL] }] : []), ...records],
                parentUid: "Mailbox",
            });
            return result;
        },
        saveFolder: async (mailboxUid, fields = {}, records = []) => {
            const result: FolderMongo = await folderRepo.save(
                new FolderMongo({ mailboxUid, name: "Calendar", type: FolderType.CALENDAR, unreadCount: 0, totalCount: 0, syncKeyVersion: 0, ...fields }),
            );
            await aclRepo.save({ uid: result.uid, dateCreated: new Date(), dateModified: new Date(), version: 0, records, parentUid: mailboxUid });
            return result;
        },
        saveEvent: async (mailboxUid, folderUid, fields = {}) => {
            const now = new Date();
            return await calendarEventRepo.save(
                new CalendarEventMongo({
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
                    ...fields,
                }),
            );
        },
        clearVisibility: async (mailboxUid) => {
            await mailboxRepo.updateOne({ uid: mailboxUid } as any, { $unset: { freeBusyVisibility: "" } } as any);
        },
        findMailbox: async (uid) => (await mailboxRepo.findOne({ uid } as any))!,
    });
});
