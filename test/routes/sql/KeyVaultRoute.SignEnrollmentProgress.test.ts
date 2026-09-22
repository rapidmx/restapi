///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// SQL counterpart of test/routes/mongo/KeyVaultRoute.SignEnrollmentProgress.test.ts - see that file and
// `signEnrollmentProgressSuite.ts`.
import "reflect-metadata";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import config from "../../config.sql.js";
import { ACLAction, AccessControlListSQL, ConnectionManager, ObjectFactory, Server, isSqlDataSource } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import { KeyVaultSQL } from "../../../src/models/sql/KeyVaultSQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { TestEnrollment } from "../../pki/acmeTestDoubles.js";
import { registerTestDoubles, type RecordingMailTransport } from "../../testDoubles.js";
import { signEnrollmentProgressSuite } from "../signEnrollmentProgressSuite.js";

describe("Route:KeyVaultSQL Tests - sign-enrollment progress", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    let mailboxRepo: Repository<MailboxSQL>;
    let keyVaultRepo: Repository<KeyVaultSQL>;
    let aclRepo: Repository<AccessControlListSQL>;
    let storeDir: string;

    beforeAll(async () => {
        storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "signenroll-sql-"));
        config.set("mail:pki:rfc8823:store_dir", storeDir);
        config.set("mail:pki:rfc8823:contact_email", "pki@example.com");
        objectFactory.register(TestEnrollment, "SigningCertificateEnrollment");
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
        await fs.rm(storeDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
        await keyVaultRepo.clear();
        await mailboxRepo.clear();
    });

    signEnrollmentProgressSuite({
        app: () => server.getApplication(),
        baseUrl: "/sql/mailboxes",
        tokenFor: (user) => JWTUtils.createTokenSync(config.get("auth"), user),
        createMailbox: async (ownerUid, grants = []) => {
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
                records: [
                    ...(ownerUid ? [{ userOrRoleId: ownerUid, actions: [ACLAction.FULL] }] : []),
                    ...grants.map((grant) => ({ userOrRoleId: grant.userUid, actions: grant.actions })),
                ],
                parentUid: "Mailbox",
            });
            return result;
        },
        enrollment: () => objectFactory.getInstance<TestEnrollment>("SigningCertificateEnrollment")!,
        transport: () => objectFactory.getInstance<RecordingMailTransport>("MailTransport")!,
    });
});
