///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { Server, ObjectFactory, ConnectionManager, AccessControlListSQL, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { Repository } from "typeorm";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { senderListsRouteSuite } from "../senderListsRouteSuite.js";
import { registerTestDoubles } from "../../testDoubles.js";

describe("Route:SenderListsSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    let mailboxRepo: Repository<MailboxSQL>;
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
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    senderListsRouteSuite({
        config,
        app: () => server.getApplication(),
        mailboxUrl: "/sql/mailboxes",
        filterRuleUrl: "/sql/mail-filter-rules",
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
                records: [...(result.ownerUserUid ? [{ userOrRoleId: result.ownerUserUid, actions: ["*"] }] : []), ...records],
                parentUid: "Mailbox",
            } as any);
            return result;
        },
        findMailbox: async (uid) => (await mailboxRepo.findOneBy({ uid }))!,
        rawUpdateMailbox: async (uid, fields) => {
            const current = (await mailboxRepo.findOneBy({ uid }))!;
            await mailboxRepo.update({ uid }, { ...fields, version: current.version + 1 });
        },
        clearLists: async (uid) => {
            await mailboxRepo.update({ uid }, { blockedSenders: null, safeSenders: null } as any);
        },
    });
});
