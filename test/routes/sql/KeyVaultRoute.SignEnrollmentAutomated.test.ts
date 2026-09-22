///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Dedicated file (mirroring BaseMailIngestRoute.DistributionLists.test.ts's own naming convention) for
// startSignEnrollment()/checkSignEnrollmentStatus() against a REAL (fake, in-memory) automated
// SigningCertificateEnrollment - kept separate from the large, shared KeyVaultRoute.test.ts, which
// deliberately keeps the default NullSigningCertificateEnrollment registered for its own tests.
import "reflect-metadata";
import config from "../../config.sql.js";
import { request } from "@rapidrest/service-core/test";
import { ACLRecord, Server, ObjectFactory, ConnectionManager, ACLAction, AccessControlListSQL, isSqlDataSource } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import { EscrowScopeSQL } from "../../../src/models/sql/EscrowScopeSQL.js";
import { KeyVaultSQL } from "../../../src/models/sql/KeyVaultSQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { generateTestCsr, registerTestDoubles } from "../../testDoubles.js";
import { FakeAutomatedEnrollment, keyVaultRound5Suite } from "../keyVaultRound5Suite.js";

describe("Route:KeyVaultSQL Tests - automated sign-enrollment", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/mailboxes";
    let mailboxRepo: Repository<MailboxSQL>;
    let keyVaultRepo: Repository<KeyVaultSQL>;
    let escrowScopeRepo: Repository<EscrowScopeSQL>;
    let aclRepo: Repository<AccessControlListSQL>;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);

    const createMailbox = async function (ownerUid: string = owner.uid): Promise<MailboxSQL> {
        const obj = new MailboxSQL({
            ownerUserUid: ownerUid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Test Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });
        const result: MailboxSQL = await mailboxRepo.save(obj);
        const records: ACLRecord[] = [{ userOrRoleId: ownerUid, actions: [ACLAction.FULL] }];
        await aclRepo.save({
            uid: result.uid,
            dateCreated: new Date(),
            dateModified: new Date(),
            version: 0,
            records,
            parentUid: "Mailbox",
        } as any);
        return result;
    };

    beforeAll(async () => {
        // `ObjectFactory.register()` is a no-op once a name is already registered - this must win the race
        // against `registerTestDoubles()`'s own `NullSigningCertificateEnrollment` registration, same
        // precedent as `FakeEncryptionCertificateAuthority` in the main KeyVaultRoute.test.ts file.
        objectFactory.register(FakeAutomatedEnrollment, "SigningCertificateEnrollment");
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
            escrowScopeRepo = conn.getRepository(EscrowScopeSQL);
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
        await escrowScopeRepo.clear();
        await aclRepo.clear();
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

    it("Answers a check-now, for an enrollment with nothing to poll, with its current status - and 404 for a mailbox's current enrollment when the implementation keeps no list.", async () => {
        const mailbox = await createMailbox();
        const startResult = await request(server.getApplication())
            .post(`${baseUrl}/${mailbox.uid}/keyvault/keys/sign-enrollment`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ csr: await generateTestCsr(mailbox.primarySmtpAddress), wrappedKey: { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" } });

        const checked = await request(server.getApplication())
            .post(`${baseUrl}/${mailbox.uid}/keyvault/keys/sign-enrollment/${startResult.body.enrollmentId}/check`)
            .set("Authorization", "jwt " + ownerToken);
        const current = await request(server.getApplication())
            .get(`${baseUrl}/${mailbox.uid}/keyvault/keys/sign-enrollment`)
            .set("Authorization", "jwt " + ownerToken);

        expect(checked.status).toBe(200);
        expect(checked.body.status).toBe("pending");
        expect(current.status).toBe(404);
    });

    keyVaultRound5Suite({
        app: () => server.getApplication(),
        baseUrl,
        tokenFor: (user) => JWTUtils.createTokenSync(config.get("auth"), user),
        createMailbox: (ownerUid) => createMailbox(ownerUid),
        createEscrowScope: async () =>
            await escrowScopeRepo.save(
                new EscrowScopeSQL({
                    name: "legal",
                    publicKey: { publicKey: "cert", type: "x509", fingerprint: "fp1", notBefore: 0, notAfter: 1 },
                    holderUserUids: [uuid.v4()],
                    requiredHolders: 1,
                }),
            ),
        deleteEscrowScope: async (uid) => {
            await escrowScopeRepo.delete({ uid });
        },
        setEscrowScope: async (mailboxUid, escrowScopeId) => {
            await mailboxRepo.update({ uid: mailboxUid }, { escrowScopeId: escrowScopeId as any });
        },
        findKeyVault: async (mailboxUid) => (await keyVaultRepo.findOne({ where: { mailboxUid } })) ?? undefined,
        generateCsr: (identity) => generateTestCsr(identity),
    });
});
