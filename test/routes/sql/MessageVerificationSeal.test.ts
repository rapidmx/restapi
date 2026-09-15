///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { Server, ObjectFactory, ConnectionManager, AccessControlListSQL, isSqlDataSource } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import { Repository } from "typeorm";
import { FolderSQL } from "../../../src/models/sql/FolderSQL.js";
import { KeyVaultSQL } from "../../../src/models/sql/KeyVaultSQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { MatterSQL } from "../../../src/models/sql/MatterSQL.js";
import { MessageSQL } from "../../../src/models/sql/MessageSQL.js";
import { FolderType } from "../../../src/models/types.js";
import { registerTestDoubles, InMemoryBlobStore, RecordingMailTransport } from "../../testDoubles.js";
import { verificationSealSuite } from "../verificationSealSuite.js";

describe("Route:MessageVerificationSealSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    let mailboxRepo: Repository<MailboxSQL>;
    let folderRepo: Repository<FolderSQL>;
    let messageRepo: Repository<MessageSQL>;
    let matterRepo: Repository<MatterSQL>;
    let keyVaultRepo: Repository<KeyVaultSQL>;
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
        matterRepo = conn.getRepository(MatterSQL);
        keyVaultRepo = conn.getRepository(KeyVaultSQL);
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        for (const repo of [mailboxRepo, folderRepo, messageRepo, matterRepo, keyVaultRepo] as Repository<any>[]) {
            await repo.clear();
        }
    });

    verificationSealSuite({
        app: () => server.getApplication(),
        baseUrl: "/sql/messages",
        tokenFor: (user: any) => JWTUtils.createTokenSync(config.get("auth"), user),
        saveMailbox: async (ownerUid: string) => {
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
            await saveAcl(mailbox.uid, "Mailbox", [{ userOrRoleId: ownerUid, actions: ["*"] }]);
            return mailbox;
        },
        saveFolder: async (mailboxUid: string, type: FolderType, records: any[] = []) => {
            const folder = await folderRepo.save(new FolderSQL({ mailboxUid, name: type, type, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }));
            await saveAcl(folder.uid, mailboxUid, records);
            return folder;
        },
        saveMessage: async (fields) => await messageRepo.save(new MessageSQL(fields as any)),
        saveKeyVault: async (mailboxUid: string, masterKeyGeneration?: number) => {
            await keyVaultRepo.save(
                new KeyVaultSQL({ mailboxUid, wrappedKeys: [], masterKeyWraps: [], ...(masterKeyGeneration === undefined ? {} : { masterKeyGeneration }) }),
            );
        },
        setVaultGeneration: async (mailboxUid: string, masterKeyGeneration: number) => {
            const vault = (await keyVaultRepo.findOne({ where: { mailboxUid } }))!;
            await keyVaultRepo.update({ uid: vault.uid }, { masterKeyGeneration, version: vault.version + 1 });
        },
        findMessage: async (uid: string) => await messageRepo.findOne({ where: { uid } }),
        findMessages: async (mailboxUid: string) => await messageRepo.find({ where: { mailboxUid } }),
        rawUpdateMessage: async (uid: string, fields) => {
            const current = (await messageRepo.findOne({ where: { uid } }))!;
            await messageRepo.update({ uid }, { ...fields, version: current.version + 1 });
        },
        saveMatter: async (fields) => await matterRepo.save(new MatterSQL(fields as any)),
        blobStore: () => objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!,
        transport: () => objectFactory.getInstance<RecordingMailTransport>("MailTransport")!,
    });
});
