///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { Server, ObjectFactory, ConnectionManager, AccessControlListSQL, isSqlDataSource } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import { Repository } from "typeorm";
import { AuditLogEntrySQL } from "../../../src/models/sql/AuditLogEntrySQL.js";
import { FolderSQL } from "../../../src/models/sql/FolderSQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { MessageSQL } from "../../../src/models/sql/MessageSQL.js";
import { FolderType } from "../../../src/models/types.js";
import { registerTestDoubles, AlwaysCleanSpamScanProvider, InMemoryBlobStore } from "../../testDoubles.js";
import { messageReportSuite } from "../messageReportSuite.js";

describe("Route:MessageReportSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    let mailboxRepo: Repository<MailboxSQL>;
    let folderRepo: Repository<FolderSQL>;
    let messageRepo: Repository<MessageSQL>;
    let auditLogRepo: Repository<AuditLogEntrySQL>;
    let aclRepo: Repository<AccessControlListSQL>;

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
        messageRepo = conn.getRepository(MessageSQL);
        auditLogRepo = conn.getRepository(AuditLogEntrySQL);
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        for (const repo of [mailboxRepo, folderRepo, messageRepo, auditLogRepo] as Repository<any>[]) {
            await repo.clear();
        }
    });

    messageReportSuite({
        app: () => server.getApplication(),
        baseUrl: "/sql/messages",
        tokenFor: (user: any) => JWTUtils.createTokenSync(config.get("auth"), user),
        saveMailbox: async (ownerUid: string, fields = {}, records = []) => {
            const mailbox = await mailboxRepo.save(
                new MailboxSQL({
                    ownerUserUid: ownerUid,
                    primarySmtpAddress: `${crypto.randomUUID()}@example.com`,
                    aliasAddresses: ["owner@example.com"],
                    displayName: "Test Mailbox",
                    timezone: "UTC",
                    quotaBytes: 1_000_000_000,
                    usedBytes: 0,
                    ...fields,
                }),
            );
            await saveAcl(mailbox.uid, "Mailbox", [{ userOrRoleId: ownerUid, actions: ["*"] }, ...records]);
            return mailbox;
        },
        saveFolder: async (mailboxUid: string, type: FolderType, records: any[] = []) => {
            const folder = await folderRepo.save(new FolderSQL({ mailboxUid, name: type, type, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }));
            await saveAcl(folder.uid, mailboxUid, records);
            return folder;
        },
        saveMessage: async (fields) => await messageRepo.save(new MessageSQL(fields as any)),
        findMessage: async (uid: string) => await messageRepo.findOne({ where: { uid } }),
        findMailbox: async (uid: string) => await mailboxRepo.findOne({ where: { uid } }),
        countFolders: async (mailboxUid: string, type: FolderType) => await folderRepo.count({ where: { mailboxUid, type } }),
        rawUpdateMessage: async (uid: string, fields) => {
            const current = (await messageRepo.findOne({ where: { uid } }))!;
            await messageRepo.update({ uid }, { ...fields, version: current.version + 1 });
        },
        auditEntries: async (targetUid: string) => await auditLogRepo.find({ where: { targetUid } }),
        blobStore: () => objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!,
        spam: () => objectFactory.getInstance<AlwaysCleanSpamScanProvider>("SpamScanProvider")!,
        setLearnEnabled: (enabled: boolean) => {
            (objectFactory.getInstance<any>("routes.MessageRoute")).spamLearnEnabled = enabled;
        },
    });
});
