///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// SQL counterpart of test/routes/mongo/SigningEnrollmentAdmin.test.ts - see that file and `signingEnrollmentAdminSuite.ts`.
import "reflect-metadata";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import config from "../../config.sql.js";
import { ACLAction, AccessControlListSQL, ConnectionManager, ObjectFactory, Server, isSqlDataSource } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import { AuditLogEntrySQL } from "../../../src/models/sql/AuditLogEntrySQL.js";
import { KeyVaultSQL } from "../../../src/models/sql/KeyVaultSQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { ManualSigningCertificateEnrollment } from "../../../src/pki/ManualSigningCertificateEnrollment.js";
import { TestEnrollment } from "../../pki/acmeTestDoubles.js";
import { registerTestDoubles } from "../../testDoubles.js";
import { signingEnrollmentAdminSuite, SwitchableEnrollment } from "../signingEnrollmentAdminSuite.js";

describe("Route:SigningEnrollment SQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    let mailboxRepo: Repository<MailboxSQL>;
    let keyVaultRepo: Repository<KeyVaultSQL>;
    let auditLogRepo: Repository<AuditLogEntrySQL>;
    let aclRepo: Repository<AccessControlListSQL>;
    let tmpDir: string;

    beforeAll(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "signadmin-sql-"));
        objectFactory.register(SwitchableEnrollment, "SigningCertificateEnrollment");
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
            auditLogRepo = conn.getRepository(AuditLogEntrySQL);
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
        await keyVaultRepo.clear();
        await mailboxRepo.clear();
        await auditLogRepo.clear();
    });

    signingEnrollmentAdminSuite({
        app: () => server.getApplication(),
        adminUrl: "/sql/signing-enrollments-admin",
        infoUrl: "/sql/signing-enrollment-info",
        mailboxesUrl: "/sql/mailboxes",
        tokenFor: (user) => JWTUtils.createTokenSync(config.get("auth"), user),
        createMailbox: async (ownerUid) => {
            const result: MailboxSQL = await mailboxRepo.save(
                new MailboxSQL({
                    ownerUserUid: ownerUid,
                    primarySmtpAddress: `${uuid.v4()}@example.com`,
                    aliasAddresses: [],
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
                records: ownerUid ? [{ userOrRoleId: ownerUid, actions: [ACLAction.FULL] }] : [],
                parentUid: "Mailbox",
            });
            return result;
        },
        auditEntries: async (action) => (await auditLogRepo.find({})).filter((entry) => entry.action === action),
        newManual: () => {
            const manual = new ManualSigningCertificateEnrollment();
            (manual as any).storePath = path.join(tmpDir, `manual-${Math.random()}.json`);
            return manual;
        },
        newAutomatic: () => {
            const automatic = new TestEnrollment();
            (automatic as any).storeDir = path.join(tmpDir, `rfc8823-${Math.random()}`);
            return automatic;
        },
    });
});
