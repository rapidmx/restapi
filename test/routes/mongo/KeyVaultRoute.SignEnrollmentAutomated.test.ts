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
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { EnrollmentResult, SigningCertificateEnrollment } from "../../../src/pki/SigningCertificateEnrollment.js";
import { generateTestCsr, registerTestDoubles } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

/** See test/routes/sql/KeyVaultRoute.SignEnrollmentAutomated.test.ts's identical fake. */
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

describe("Route:KeyVaultMongo Tests - automated sign-enrollment", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/mailboxes";
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let aclRepo: MongoRepository<any>;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);

    const createMailbox = async function (): Promise<MailboxMongo> {
        const obj = new MailboxMongo({
            ownerUserUid: owner.uid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Test Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });
        const result: MailboxMongo = await mailboxRepo.save(obj);
        const records: ACLRecord[] = [{ userOrRoleId: owner.uid, actions: [ACLAction.FULL] }];
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
        for (const repo of [mailboxRepo, aclRepo]) {
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
});
