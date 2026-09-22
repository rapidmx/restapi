///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real HTTP+DB tests of the signing-certificate enrollment's status/progress endpoints, with the real RFC 8823 enrollment on a
// temporary store and a fake ACME client - see `signEnrollmentProgressSuite.ts`.
import "reflect-metadata";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import config from "../../config.js";
import { ACLAction, ConnectionManager, MongoConnection, MongoRepository, ObjectFactory, Server } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { MongoMemoryServer } from "mongodb-memory-server";
import { KeyVaultMongo } from "../../../src/models/mongo/KeyVaultMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { TestEnrollment } from "../../pki/acmeTestDoubles.js";
import { registerTestDoubles, type RecordingMailTransport } from "../../testDoubles.js";
import { signEnrollmentProgressSuite } from "../signEnrollmentProgressSuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("Route:KeyVaultMongo Tests - sign-enrollment progress", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let keyVaultRepo: MongoRepository<KeyVaultMongo>;
    let aclRepo: MongoRepository<any>;
    let storeDir: string;

    beforeAll(async () => {
        storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "signenroll-mongo-"));
        config.set("mail:pki:rfc8823:store_dir", storeDir);
        config.set("mail:pki:rfc8823:contact_email", "pki@example.com");
        await mongod.start();
        objectFactory.register(TestEnrollment, "SigningCertificateEnrollment");
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
        } else {
            throw new Error("Could not find mongo connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
        await fs.rm(storeDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
        for (const repo of [mailboxRepo, keyVaultRepo]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
    });

    signEnrollmentProgressSuite({
        app: () => server.getApplication(),
        baseUrl: "/mongo/mailboxes",
        tokenFor: (user) => JWTUtils.createTokenSync(config.get("auth"), user),
        createMailbox: async (ownerUid, grants = []) => {
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
