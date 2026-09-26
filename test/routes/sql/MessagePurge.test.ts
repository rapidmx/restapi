///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { Server, ObjectFactory, ConnectionManager, AccessControlListSQL, isSqlDataSource } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import { Repository } from "typeorm";
import { AttachmentSQL } from "../../../src/models/sql/AttachmentSQL.js";
import { AuditLogEntrySQL } from "../../../src/models/sql/AuditLogEntrySQL.js";
import { FolderSQL } from "../../../src/models/sql/FolderSQL.js";
import { IngestQueueEntrySQL } from "../../../src/models/sql/IngestQueueEntrySQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { MatterSQL } from "../../../src/models/sql/MatterSQL.js";
import { MessageSQL } from "../../../src/models/sql/MessageSQL.js";
import { QuarantineEntrySQL } from "../../../src/models/sql/QuarantineEntrySQL.js";
import { FolderType } from "../../../src/models/types.js";
import { registerTestDoubles, InMemoryBlobStore } from "../../testDoubles.js";
import { messagePurgeSuite } from "../messagePurgeSuite.js";

describe("Route:MessagePurgeSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    let mailboxRepo: Repository<MailboxSQL>;
    let folderRepo: Repository<FolderSQL>;
    let messageRepo: Repository<MessageSQL>;
    let attachmentRepo: Repository<AttachmentSQL>;
    let quarantineRepo: Repository<QuarantineEntrySQL>;
    let ingestRepo: Repository<IngestQueueEntrySQL>;
    let matterRepo: Repository<MatterSQL>;
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
        attachmentRepo = conn.getRepository(AttachmentSQL);
        quarantineRepo = conn.getRepository(QuarantineEntrySQL);
        ingestRepo = conn.getRepository(IngestQueueEntrySQL);
        matterRepo = conn.getRepository(MatterSQL);
        auditLogRepo = conn.getRepository(AuditLogEntrySQL);
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        for (const repo of [mailboxRepo, folderRepo, messageRepo, attachmentRepo, quarantineRepo, ingestRepo, matterRepo, auditLogRepo] as Repository<any>[]) {
            await repo.clear();
        }
    });

    messagePurgeSuite({
        app: () => server.getApplication(),
        baseUrl: "/sql/messages",
        tokenFor: (user: any) => JWTUtils.createTokenSync(config.get("auth"), user),
        saveMailbox: async (ownerUid: string, records = []) => {
            const mailbox = await mailboxRepo.save(
                new MailboxSQL({
                    ownerUserUid: ownerUid,
                    primarySmtpAddress: `${crypto.randomUUID()}@example.com`,
                    aliasAddresses: ["owner@example.com"],
                    displayName: "Test Mailbox",
                    timezone: "UTC",
                    quotaBytes: 1_000_000_000,
                    usedBytes: 0,
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
        saveAttachment: async (fields) => await attachmentRepo.save(new AttachmentSQL(fields as any)),
        findAttachments: async (messageUid: string) => await attachmentRepo.find({ where: { messageUid } }),
        saveQuarantine: async (fields) => await quarantineRepo.save(new QuarantineEntrySQL(fields as any)),
        saveIngest: async (fields) => await ingestRepo.save(new IngestQueueEntrySQL(fields as any)),
        saveMatter: async (fields) => await matterRepo.save(new MatterSQL(fields as any)),
        auditEntries: async (action: string) => await auditLogRepo.find({ where: { action } as any }),
        blobStore: () => objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!,
    });
});
