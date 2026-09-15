///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Runs `keyRotationContinuitySuite` (issuer capture and superseded-key revocation) against the SQL fixture server.
import "reflect-metadata";
import config from "../../config.sql.js";
import { ACLRecord, Server, ObjectFactory, ConnectionManager, ACLAction, AccessControlListSQL, isSqlDataSource } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import { KeyVaultSQL } from "../../../src/models/sql/KeyVaultSQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { computeKeyDiscoveryHash } from "../../../src/util/KeyDiscoveryClient.js";
import { generateTestCsr, registerTestDoubles } from "../../testDoubles.js";
import { ChainingTestCertificateAuthority, keyRotationContinuitySuite } from "../keyRotationContinuitySuite.js";

describe("Route:KeyVaultSQL Tests - key rotation continuity", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    let mailboxRepo: Repository<MailboxSQL>;
    let keyVaultRepo: Repository<KeyVaultSQL>;
    let aclRepo: Repository<AccessControlListSQL>;

    beforeAll(async () => {
        // Registered before `registerTestDoubles()` so it wins over its Null authority.
        objectFactory.register(ChainingTestCertificateAuthority, "EncryptionCertificateAuthority");
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
            keyVaultRepo = conn.getRepository(KeyVaultSQL);
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await mailboxRepo.clear();
        await keyVaultRepo.clear();
        await aclRepo.clear();
    });

    keyRotationContinuitySuite({
        app: () => server.getApplication(),
        baseUrl: "/sql/mailboxes",
        discoveryUrl: "/sql/.well-known/rapidmx/keys",
        tokenFor: (user) => JWTUtils.createTokenSync(config.get("auth"), user),
        createMailbox: async (ownerUid) => {
            const localPart = uuid.v4();
            const mailbox: MailboxSQL = await mailboxRepo.save(
                new MailboxSQL({
                    ownerUserUid: ownerUid,
                    primarySmtpAddress: `${localPart}@example.com`,
                    aliasAddresses: [],
                    displayName: "Test Mailbox",
                    timezone: "UTC",
                    quotaBytes: 1_000_000_000,
                    usedBytes: 0,
                    keyDiscoveryHash: computeKeyDiscoveryHash(localPart),
                }),
            );
            const records: ACLRecord[] = [{ userOrRoleId: ownerUid, actions: [ACLAction.FULL] }];
            await aclRepo.save({ uid: mailbox.uid, dateCreated: new Date(), dateModified: new Date(), version: 0, records, parentUid: "Mailbox" } as any);
            return mailbox;
        },
        findMailbox: async (uid) => await mailboxRepo.findOne({ where: { uid } }),
        setMailboxKeys: async (uid, keys) => {
            await mailboxRepo.update({ uid }, { keys });
        },
        findKeyVault: async (mailboxUid) => (await keyVaultRepo.findOne({ where: { mailboxUid } })) ?? undefined,
        generateCsr: (identity) => generateTestCsr(identity),
    });
});
