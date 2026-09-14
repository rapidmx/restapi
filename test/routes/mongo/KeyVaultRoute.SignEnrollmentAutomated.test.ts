///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// See test/routes/sql/KeyVaultRoute.SignEnrollmentAutomated.test.ts's identical file header - kept as its
// own file for the same reason.
import "reflect-metadata";
import config from "../../config.js";
import { request } from "@rapidrest/service-core/test";
import { ACLRecord, MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager, ACLAction } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { MongoMemoryServer } from "mongodb-memory-server";
import { EscrowScopeMongo } from "../../../src/models/mongo/EscrowScopeMongo.js";
import { KeyVaultMongo } from "../../../src/models/mongo/KeyVaultMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { generateTestCsr, registerTestDoubles } from "../../testDoubles.js";
import { FakeAutomatedEnrollment, keyVaultRound5Suite } from "../keyVaultRound5Suite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("Route:KeyVaultMongo Tests - automated sign-enrollment", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/mailboxes";
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let keyVaultRepo: MongoRepository<KeyVaultMongo>;
    let escrowScopeRepo: MongoRepository<EscrowScopeMongo>;
    let aclRepo: MongoRepository<any>;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);

    const createMailbox = async function (ownerUid: string = owner.uid): Promise<MailboxMongo> {
        const obj = new MailboxMongo({
            ownerUserUid: ownerUid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Test Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });
        const result: MailboxMongo = await mailboxRepo.save(obj);
        const records: ACLRecord[] = [{ userOrRoleId: ownerUid, actions: [ACLAction.FULL] }];
        await aclRepo.save({
            uid: result.uid,
            dateCreated: new Date(),
            dateModified: new Date(),
            version: 0,
            records,
            parentUid: "Mailbox",
        });
        return result;
    };

    beforeAll(async () => {
        await mongod.start();
        objectFactory.register(FakeAutomatedEnrollment, "SigningCertificateEnrollment");
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
            escrowScopeRepo = conn.getMongoRepository("EscrowScopeMongo");
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
        for (const repo of [mailboxRepo, keyVaultRepo, escrowScopeRepo, aclRepo]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
        FakeAutomatedEnrollment.enrollments.clear();
    });

    it("Starts enrollment, attaches the wrapped key, and reports pending status.", async () => {
        const mailbox = await createMailbox();
        const wrappedKey = { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" };

        const startResult = await request(server.getApplication())
            .post(`${baseUrl}/${mailbox.uid}/keyvault/keys/sign-enrollment`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ csr: await generateTestCsr(mailbox.primarySmtpAddress), wrappedKey });

        expect(startResult.status).toBeGreaterThanOrEqual(200);
        expect(startResult.status).toBeLessThan(300);
        expect(startResult.body.enrollmentId).toBeTruthy();

        const stored = FakeAutomatedEnrollment.enrollments.get(startResult.body.enrollmentId);
        expect(stored?.identity).toBe(mailbox.primarySmtpAddress);
        expect(stored?.wrappedKey).toEqual(wrappedKey);

        const statusResult = await request(server.getApplication())
            .get(`${baseUrl}/${mailbox.uid}/keyvault/keys/sign-enrollment/${startResult.body.enrollmentId}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(statusResult.status).toBe(200);
        expect(statusResult.body.status).toBe("pending");
    });

    keyVaultRound5Suite({
        app: () => server.getApplication(),
        baseUrl,
        tokenFor: (user) => JWTUtils.createTokenSync(config.get("auth"), user),
        createMailbox: (ownerUid) => createMailbox(ownerUid),
        createEscrowScope: async () =>
            await escrowScopeRepo.save(
                new EscrowScopeMongo({
                    name: "legal",
                    publicKey: { publicKey: "cert", type: "x509", fingerprint: "fp1", notBefore: 0, notAfter: 1 },
                    holderUserUids: [uuid.v4()],
                    requiredHolders: 1,
                }),
            ),
        deleteEscrowScope: async (uid) => {
            await escrowScopeRepo.deleteOne({ uid });
        },
        setEscrowScope: async (mailboxUid, escrowScopeId) => {
            await mailboxRepo.updateOne({ uid: mailboxUid } as any, escrowScopeId ? { $set: { escrowScopeId } } : { $unset: { escrowScopeId: "" } });
        },
        findKeyVault: async (mailboxUid) => (await keyVaultRepo.findOne({ mailboxUid } as any)) ?? undefined,
        generateCsr: (identity) => generateTestCsr(identity),
    });
});
