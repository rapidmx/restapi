///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { ACLAction, AccessControlListSQL, ConnectionManager, isSqlDataSource, ObjectFactory, Server } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { Repository } from "typeorm";
import { ContactSQL } from "../../../src/models/sql/ContactSQL.js";
import { DataSubjectErasureRequestSQL } from "../../../src/models/sql/DataSubjectErasureRequestSQL.js";
import { DistributionListSQL } from "../../../src/models/sql/DistributionListSQL.js";
import { FolderSQL } from "../../../src/models/sql/FolderSQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { registerTestDoubles } from "../../testDoubles.js";
import { directorySuite } from "../directorySuite.js";

describe("Route:DirectorySQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    let aclRepo: Repository<AccessControlListSQL>;
    let mailboxRepo: Repository<MailboxSQL>;
    let folderRepo: Repository<FolderSQL>;
    let contactRepo: Repository<ContactSQL>;
    let listRepo: Repository<DistributionListSQL>;
    let erasureRepo: Repository<DataSubjectErasureRequestSQL>;

    const saveAcl = async (uid: string, parentUid: string, records: any[]): Promise<void> => {
        await aclRepo.save({ uid, dateCreated: new Date(), dateModified: new Date(), version: 0, records, parentUid } as any);
    };

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const aclConn: any = connMgr?.connections.get("acl");
        const conn: any = connMgr?.connections.get("sql");
        if (!isSqlDataSource(aclConn) || !isSqlDataSource(conn)) {
            throw new Error("Could not find sql connections");
        }
        aclRepo = aclConn.getRepository(AccessControlListSQL);
        mailboxRepo = conn.getRepository(MailboxSQL);
        folderRepo = conn.getRepository(FolderSQL);
        contactRepo = conn.getRepository(ContactSQL);
        listRepo = conn.getRepository(DistributionListSQL);
        erasureRepo = conn.getRepository(DataSubjectErasureRequestSQL);
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        for (const repo of [mailboxRepo, folderRepo, contactRepo, listRepo, erasureRepo] as Repository<any>[]) {
            await repo.clear();
        }
    });

    directorySuite({
        config,
        app: () => server.getApplication(),
        baseUrl: "/sql/directory",
        saveMailbox: async (fields, records = []) => {
            const mailbox = await mailboxRepo.save(
                new MailboxSQL({ aliasAddresses: [], displayName: "", timezone: "UTC", quotaBytes: 1_000_000_000, usedBytes: 0, ...fields } as any),
            );
            const ownerRecords = mailbox.ownerUserUid ? [{ userOrRoleId: mailbox.ownerUserUid, actions: [ACLAction.FULL] }] : [];
            await saveAcl(mailbox.uid, "Mailbox", [...ownerRecords, ...records]);
            return mailbox;
        },
        saveList: async (fields) => await listRepo.save(new DistributionListSQL({ memberAddresses: [], ...fields } as any)),
        saveFolder: async (fields, records = []) => {
            const folder = await folderRepo.save(new FolderSQL({ unreadCount: 0, totalCount: 0, syncKeyVersion: 0, ...fields } as any));
            await saveAcl(folder.uid, folder.mailboxUid, records);
            return folder;
        },
        saveContact: async (fields) => await contactRepo.save(new ContactSQL(fields as any)),
        saveErasureRequest: async (mailboxUid, status) => {
            await erasureRepo.save(new DataSubjectErasureRequestSQL({ mailboxUid, requestedByUserUid: "someone", status } as any));
        },
    });
});
