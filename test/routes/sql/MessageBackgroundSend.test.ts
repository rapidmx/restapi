///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// SQL counterpart of test/routes/mongo/MessageSendFailure.test.ts - see that file and `messageSendFailureSuite.ts`.
import config from "../../config.sql.js";
import { Server, ObjectFactory, ConnectionManager, AccessControlListSQL, isSqlDataSource } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { FolderSQL } from "../../../src/models/sql/FolderSQL.js";
import { MessageSQL } from "../../../src/models/sql/MessageSQL.js";
import { FolderType, MessageImportance, RecipientType } from "../../../src/models/types.js";
import { ScheduledSendJobSQL } from "../../../src/jobs/sql/ScheduledSendJobSQL.js";
import { registerTestDoubles, InMemoryBlobStore, RecordingMailTransport } from "../../testDoubles.js";
import { backgroundSendRouteSuite } from "../backgroundSendRouteSuite.js";

describe("Route:MessageSQL background send Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/messages";
    let mailboxRepo: Repository<MailboxSQL>;
    let folderRepo: Repository<FolderSQL>;
    let messageRepo: Repository<MessageSQL>;
    let aclRepo: Repository<AccessControlListSQL>;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);

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
        await messageRepo.clear();
        await folderRepo.clear();
        await mailboxRepo.clear();
        objectFactory.getInstance<RecordingMailTransport>("MailTransport")!.sent = [];
    });

    backgroundSendRouteSuite({
        app: () => server.getApplication(),
        baseUrl,
        foldersUrl: "/sql/folders",
        job: () => objectFactory.getInstance<any>(ScheduledSendJobSQL),
        concurrentRequests: false,
        ownerToken,
        ownerUid: owner.uid,
        blobStore: () => objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!,
        transport: () => objectFactory.getInstance<RecordingMailTransport>("MailTransport")!,
        createMailbox: async (ownerUid) => {
            const result = await mailboxRepo.save(
                new MailboxSQL({
                    ownerUserUid: ownerUid,
                    primarySmtpAddress: `${uuid.v4()}@example.com`,
                    aliasAddresses: ["owner@example.com"],
                    displayName: "Test Mailbox",
                    timezone: "UTC",
                    quotaBytes: 1_000_000_000,
                    usedBytes: 0,
                }),
            );
            await aclRepo.save({
                uid: result.uid,
                dateCreated: new Date(),
                dateModified: new Date(),
                version: 0,
                records: [{ userOrRoleId: ownerUid, actions: ["*"] }],
                parentUid: "Mailbox",
            });
            return result;
        },
        createFolder: async (mailboxUid, type) => {
            const result = await folderRepo.save(new FolderSQL({ mailboxUid, name: type, type, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }));
            await aclRepo.save({
                uid: result.uid,
                dateCreated: new Date(),
                dateModified: new Date(),
                version: 0,
                records: [],
                parentUid: mailboxUid,
            });
            return result;
        },
        createMessage: async (mailboxUid, folderUid, data) =>
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
                    ...data,
                }),
            ),
        messagesIn: async (mailboxUid, type) => {
            const folder = await folderRepo.findOne({ where: { mailboxUid, type } });
            return folder ? await messageRepo.find({ where: { folderUid: folder.uid } }) : [];
        },
        updateMessage: async (uid, fields) => {
            await messageRepo.update({ uid }, fields);
        },
        findMessage: async (uid) => (await messageRepo.findOne({ where: { uid } }))!,
        findFolder: async (mailboxUid, type) => (await folderRepo.findOne({ where: { mailboxUid, type } })) ?? undefined,
    });
});
