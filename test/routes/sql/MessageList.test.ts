///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { ACLAction, AccessControlListSQL, ConnectionManager, isSqlDataSource, ObjectFactory, Server } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { Repository } from "typeorm";
import * as uuid from "uuid";
import { FolderSQL } from "../../../src/models/sql/FolderSQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { MessageSQL } from "../../../src/models/sql/MessageSQL.js";
import { MessageImportance, RecipientType } from "../../../src/models/types.js";
import { registerTestDoubles } from "../../testDoubles.js";
import { messageListSuite } from "../messageListSuite.js";

describe("Route:MessageListSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    let aclRepo: Repository<AccessControlListSQL>;
    let mailboxRepo: Repository<MailboxSQL>;
    let folderRepo: Repository<FolderSQL>;
    let messageRepo: Repository<MessageSQL>;

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
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        for (const repo of [messageRepo, folderRepo, mailboxRepo] as Repository<any>[]) {
            await repo.clear();
        }
    });

    messageListSuite({
        config,
        app: () => server.getApplication(),
        baseUrl: "/sql/messages",
        saveMailbox: async (ownerUserUid) => {
            const mailbox = await mailboxRepo.save(
                new MailboxSQL({
                    ownerUserUid,
                    primarySmtpAddress: `${uuid.v4()}@example.com`,
                    aliasAddresses: [],
                    displayName: "Test Mailbox",
                    timezone: "UTC",
                    quotaBytes: 1_000_000_000,
                    usedBytes: 0,
                } as any),
            );
            await saveAcl(mailbox.uid, "Mailbox", [{ userOrRoleId: ownerUserUid, actions: [ACLAction.FULL] }]);
            return mailbox;
        },
        saveFolder: async (mailboxUid, type, records = []) => {
            const folder = await folderRepo.save(
                new FolderSQL({ mailboxUid, name: type, type, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 } as any),
            );
            await saveAcl(folder.uid, mailboxUid, records);
            return folder;
        },
        saveMessage: async (mailboxUid, folderUid, fields = {}) =>
            await messageRepo.save(
                new MessageSQL({
                    mailboxUid,
                    folderUid,
                    messageId: `${uuid.v4()}@example.com`,
                    subject: "Test Subject",
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
                    ...fields,
                } as any),
            ),
        readMessage: async (uid) => await messageRepo.findOne({ where: { uid } }),
    });
});
