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
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { EnrollmentResult, SigningCertificateEnrollment } from "../../../src/pki/SigningCertificateEnrollment.js";
import { generateTestCsr, registerTestDoubles } from "../../testDoubles.js";

/** A minimal, real (in-memory) `SigningCertificateEnrollment` supporting `attachWrappedKey()` - enough to
 * exercise `startSignEnrollment()`'s feature-detection call and prove the wrapped key actually reaches
 * the enrollment service, without needing a real ACME CA or the full `Rfc8823AcmeSigningCertificateEnrollment`
 * machinery (already covered on its own in test/pki/Rfc8823AcmeSigningCertificateEnrollment.test.ts). */
class FakeAutomatedEnrollment implements SigningCertificateEnrollment {
    public readonly name = "fake-automated";
    public static enrollments = new Map<string, { identity: string; csr: string; wrappedKey?: any; status: string }>();

    public async startEnrollment(identity: string, csr: string): Promise<{ enrollmentId: string }> {
        const enrollmentId = uuid.v4();
        FakeAutomatedEnrollment.enrollments.set(enrollmentId, { identity, csr, status: "pending" });
        return { enrollmentId };
    }

    public async checkStatus(enrollmentId: string): Promise<EnrollmentResult> {
        const enrollment = FakeAutomatedEnrollment.enrollments.get(enrollmentId);
        if (!enrollment) {
            throw new Error("not found");
        }
        return { status: enrollment.status as any, certificate: undefined, error: undefined };
    }

    public async attachWrappedKey(enrollmentId: string, wrappedKey: any): Promise<void> {
        const enrollment = FakeAutomatedEnrollment.enrollments.get(enrollmentId);
        if (enrollment) {
            enrollment.wrappedKey = wrappedKey;
        }
    }
}

describe("Route:KeyVaultSQL Tests - automated sign-enrollment", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/mailboxes";
    let mailboxRepo: Repository<MailboxSQL>;
    let aclRepo: Repository<AccessControlListSQL>;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);

    const createMailbox = async function (): Promise<MailboxSQL> {
        const obj = new MailboxSQL({
            ownerUserUid: owner.uid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Test Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });
        const result: MailboxSQL = await mailboxRepo.save(obj);
        const records: ACLRecord[] = [{ userOrRoleId: owner.uid, actions: [ACLAction.FULL] }];
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
});
