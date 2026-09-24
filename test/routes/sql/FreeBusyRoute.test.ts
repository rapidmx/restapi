///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { Server, ObjectFactory, ConnectionManager, ACLAction, AccessControlListSQL, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { FolderSQL } from "../../../src/models/sql/FolderSQL.js";
import { CalendarEventSQL } from "../../../src/models/sql/CalendarEventSQL.js";
import { BusyStatus, CalendarEventStatus, FolderType, RecipientType } from "../../../src/models/types.js";
import { freeBusySuite } from "../freeBusySuite.js";
import { registerTestDoubles } from "../../testDoubles.js";

describe("Route:FreeBusySQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    let mailboxRepo: Repository<MailboxSQL>;
    let folderRepo: Repository<FolderSQL>;
    let calendarEventRepo: Repository<CalendarEventSQL>;
    let aclRepo: Repository<AccessControlListSQL>;

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

    freeBusySuite({
        config,
        app: () => server.getApplication(),
        calendarUrl: "/sql/calendar-events",
        mailboxUrl: "/sql/mailboxes",
        saveMailbox: async (fields, records = []) => {
            const result: MailboxSQL = await mailboxRepo.save(
                new MailboxSQL({
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
            const result: FolderSQL = await folderRepo.save(
                new FolderSQL({ mailboxUid, name: "Calendar", type: FolderType.CALENDAR, unreadCount: 0, totalCount: 0, syncKeyVersion: 0, ...fields }),
            );
            await aclRepo.save({ uid: result.uid, dateCreated: new Date(), dateModified: new Date(), version: 0, records, parentUid: mailboxUid });
            return result;
        },
        saveEvent: async (mailboxUid, folderUid, fields = {}) => {
            const now = new Date();
            return await calendarEventRepo.save(
                new CalendarEventSQL({
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
            await mailboxRepo.update({ uid: mailboxUid }, { freeBusyVisibility: null } as any);
        },
        findMailbox: async (uid) => (await mailboxRepo.findOneBy({ uid }))!,
    });
});
