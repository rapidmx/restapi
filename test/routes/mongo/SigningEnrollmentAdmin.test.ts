///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real HTTP+DB tests of the signing certificate administrator routes, the info route and the key-vault status routes' unknown-id handling - see
// `signingEnrollmentAdminSuite.ts`.
import "reflect-metadata";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import config from "../../config.js";
import { ACLAction, ConnectionManager, MongoConnection, MongoRepository, ObjectFactory, Server } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { MongoMemoryServer } from "mongodb-memory-server";
import { AuditLogEntryMongo } from "../../../src/models/mongo/AuditLogEntryMongo.js";
import { KeyVaultMongo } from "../../../src/models/mongo/KeyVaultMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { ManualSigningCertificateEnrollment } from "../../../src/pki/ManualSigningCertificateEnrollment.js";
import { TestEnrollment } from "../../pki/acmeTestDoubles.js";
import { registerTestDoubles } from "../../testDoubles.js";
import { signingEnrollmentAdminSuite, SwitchableEnrollment } from "../signingEnrollmentAdminSuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("Route:SigningEnrollment Mongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let keyVaultRepo: MongoRepository<KeyVaultMongo>;
    let auditLogRepo: MongoRepository<AuditLogEntryMongo>;
    let aclRepo: MongoRepository<any>;
    let tmpDir: string;

    beforeAll(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "signadmin-mongo-"));
        await mongod.start();
        objectFactory.register(SwitchableEnrollment, "SigningCertificateEnrollment");
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        let conn: any = connMgr?.connections.get("acl");
        if (conn instanceof MongoConnection) {
            aclRepo = conn.getMongoRepository("AccessControlListMongo");
        }
        conn = connMgr?.connections.get("mongo");
        if (conn instanceof MongoConnection) {
            mailboxRepo = conn.getMongoRepository("MailboxMongo");
            keyVaultRepo = conn.getMongoRepository("KeyVaultMongo");
            auditLogRepo = conn.getMongoRepository("AuditLogEntryMongo");
        } else {
            throw new Error("Could not find mongo connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
        for (const repo of [mailboxRepo, keyVaultRepo, auditLogRepo]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
    });

    signingEnrollmentAdminSuite({
        app: () => server.getApplication(),
        adminUrl: "/mongo/signing-enrollments-admin",
        infoUrl: "/mongo/signing-enrollment-info",
        mailboxesUrl: "/mongo/mailboxes",
        tokenFor: (user) => JWTUtils.createTokenSync(config.get("auth"), user),
        createMailbox: async (ownerUid) => {
            const result: MailboxMongo = await mailboxRepo.save(
                new MailboxMongo({
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
        auditEntries: async (action) => (await auditLogRepo.find({}).toArray()).filter((entry) => entry.action === action),
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
