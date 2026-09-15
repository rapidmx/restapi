///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Runs `keyRotationContinuitySuite` (issuer capture and superseded-key revocation) against the Mongo fixture server.
import "reflect-metadata";
import config from "../../config.js";
import { ACLRecord, MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager, ACLAction } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { MongoMemoryServer } from "mongodb-memory-server";
import { KeyVaultMongo } from "../../../src/models/mongo/KeyVaultMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { computeKeyDiscoveryHash } from "../../../src/util/KeyDiscoveryClient.js";
import { generateTestCsr, registerTestDoubles } from "../../testDoubles.js";
import { ChainingTestCertificateAuthority, keyRotationContinuitySuite } from "../keyRotationContinuitySuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("Route:KeyVaultMongo Tests - key rotation continuity", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let keyVaultRepo: MongoRepository<KeyVaultMongo>;
    let aclRepo: MongoRepository<any>;

    beforeAll(async () => {
        await mongod.start();
        // Registered before `registerTestDoubles()` so it wins over its Null authority.
        objectFactory.register(ChainingTestCertificateAuthority, "EncryptionCertificateAuthority");
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
    });

    beforeEach(async () => {
        for (const repo of [mailboxRepo, keyVaultRepo, aclRepo]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
    });

    keyRotationContinuitySuite({
        app: () => server.getApplication(),
        baseUrl: "/mongo/mailboxes",
        discoveryUrl: "/mongo/.well-known/rapidmx/keys",
        tokenFor: (user) => JWTUtils.createTokenSync(config.get("auth"), user),
        createMailbox: async (ownerUid) => {
            const localPart = uuid.v4();
            const mailbox: MailboxMongo = await mailboxRepo.save(
                new MailboxMongo({
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
            await aclRepo.save({ uid: mailbox.uid, dateCreated: new Date(), dateModified: new Date(), version: 0, records, parentUid: "Mailbox" });
            return mailbox;
        },
        findMailbox: async (uid) => await mailboxRepo.findOne({ uid } as any),
        setMailboxKeys: async (uid, keys) => {
            await mailboxRepo.updateOne({ uid } as any, { $set: { keys } });
        },
        findKeyVault: async (mailboxUid) => (await keyVaultRepo.findOne({ mailboxUid } as any)) ?? undefined,
        generateCsr: (identity) => generateTestCsr(identity),
    });
});
