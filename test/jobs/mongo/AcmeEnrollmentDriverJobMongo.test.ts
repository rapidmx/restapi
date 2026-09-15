///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// See test/jobs/sql/AcmeEnrollmentDriverJobSQL.test.ts's identical file header - kept as its own file for
// the same reason.
import { MongoMemoryServer } from "mongodb-memory-server";
import { ACLUtils, ConnectionManager, MongoConnection, MongoRepository, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../../config.js";
import { registerTestDoubles } from "../../testDoubles.js";
import { AcmeEnrollmentDriverJobMongo } from "../../../src/jobs/mongo/AcmeEnrollmentDriverJobMongo.js";
import { AuditLogEntryMongo } from "../../../src/models/mongo/AuditLogEntryMongo.js";
import { KeyVaultMongo } from "../../../src/models/mongo/KeyVaultMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { AuditAction } from "../../../src/models/types.js";
import { EnrollmentResult, SigningCertificateEnrollment } from "../../../src/pki/SigningCertificateEnrollment.js";
import { publicKeyFromCertificatePem } from "../../../src/util/CertificateInstallUtils.js";
import { issueTestLeaf, makeTestCa } from "../../routes/keyRotationContinuitySuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

interface FakeEntry {
    identity: string;
    status: "pending" | "issued" | "failed";
    material?: { certificate: string; wrappedKey: any; mailboxUid?: string; masterKeyGeneration?: number };
    installed?: boolean;
    cancelledReason?: string;
    advanceCallCount: number;
}

/** See test/jobs/sql/AcmeEnrollmentDriverJobSQL.test.ts's identical fake. */
class FakeDrivenEnrollment implements SigningCertificateEnrollment {
    public readonly name = "fake-driven";
    public static entries = new Map<string, FakeEntry>();

    public async startEnrollment(_identity: string, _csr: string): Promise<{ enrollmentId: string }> {
        throw new Error("not used by this test");
    }

    public async checkStatus(enrollmentId: string): Promise<EnrollmentResult> {
        const entry = FakeDrivenEnrollment.entries.get(enrollmentId);
        return { status: entry?.status ?? "failed", certificate: entry?.material?.certificate, error: undefined };
    }

    public async listPendingEnrollments(): Promise<Array<{ enrollmentId: string; identity: string; status: "pending" | "issued" | "failed" }>> {
        return Array.from(FakeDrivenEnrollment.entries.entries())
            .filter(([, e]) => e.status === "pending" || (e.status === "issued" && !e.installed))
            .map(([enrollmentId, e]) => ({ enrollmentId, identity: e.identity, status: e.status }));
    }

    public async advanceEnrollment(enrollmentId: string): Promise<void> {
        const entry = FakeDrivenEnrollment.entries.get(enrollmentId);
        if (entry) {
            entry.advanceCallCount++;
        }
    }

    public async getIssuedMaterial(enrollmentId: string): Promise<{ certificate: string; wrappedKey: any } | undefined> {
        const entry = FakeDrivenEnrollment.entries.get(enrollmentId);
        return entry?.status === "issued" ? entry.material : undefined;
    }

    public async markInstalled(enrollmentId: string): Promise<void> {
        const entry = FakeDrivenEnrollment.entries.get(enrollmentId);
        if (entry) {
            entry.installed = true;
        }
    }

    public async cancelEnrollment(enrollmentId: string, reason: string): Promise<void> {
        const entry = FakeDrivenEnrollment.entries.get(enrollmentId);
        if (entry) {
            entry.status = "failed";
            entry.cancelledReason = reason;
        }
    }
}

async function generateSelfSignedCertPem(identity: string): Promise<string> {
    const x509 = await import("@peculiar/x509");
    x509.cryptoProvider.set(crypto);
    const keys: CryptoKeyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        name: `CN=${identity}`,
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        keys,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        extensions: [new x509.SubjectAlternativeNameExtension([{ type: "email", value: identity }])],
    });
    return cert.toString("pem");
}

describe("AcmeEnrollmentDriverJobMongo Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: AcmeEnrollmentDriverJobMongo;
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let keyVaultRepo: MongoRepository<KeyVaultMongo>;
    let auditLogRepo: MongoRepository<AuditLogEntryMongo>;

    const createMailbox = async (data?: Partial<MailboxMongo>): Promise<MailboxMongo> => {
        const obj = new MailboxMongo({
            ownerUserUid: uuid.v4(),
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Test Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
            ...data,
        });
        return await mailboxRepo.save(obj);
    };

    beforeAll(async () => {
        await mongod.start();
        objectFactory = new ObjectFactory(config, logger);
        objectFactory.register(FakeDrivenEnrollment, "SigningCertificateEnrollment");
        registerTestDoubles(objectFactory);
        objectFactory.register(ACLUtils);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("MailboxMongo", MailboxMongo);
        models.set("KeyVaultMongo", KeyVaultMongo);
        models.set("AuditLogEntryMongo", AuditLogEntryMongo);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        mailboxRepo = conn.getMongoRepository("MailboxMongo");
        keyVaultRepo = conn.getMongoRepository("KeyVaultMongo");
        auditLogRepo = conn.getMongoRepository("AuditLogEntryMongo");

        job = await objectFactory.newInstance(AcmeEnrollmentDriverJobMongo, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
        await mongod.stop();
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
        FakeDrivenEnrollment.entries.clear();
    });

    it("Exposes the configured cron schedule.", () => {
        expect(job.schedule).toBe("0 */5 * * * *");
    });

    it("start()/stop() are no-ops beyond init().", async () => {
        await expect(job.start()).resolves.toBeUndefined();
        expect(job.stop()).toBeUndefined();
    });

    it("Does nothing when there are no pending enrollments and no mailboxes at all.", async () => {
        await expect(job.run()).resolves.toBeUndefined();
    });

    it("Advances a pending enrollment (calls advanceEnrollment()) but does not install anything while it stays pending.", async () => {
        const mailbox = await createMailbox();
        FakeDrivenEnrollment.entries.set("e1", { identity: mailbox.primarySmtpAddress, status: "pending", advanceCallCount: 0 });

        await job.run();

        expect(FakeDrivenEnrollment.entries.get("e1")!.advanceCallCount).toBe(1);
        const updatedMailbox = await mailboxRepo.findOne({ uid: mailbox.uid } as any);
        expect(updatedMailbox?.keys).toHaveLength(0);
    });

    it("Installs the issued certificate + wrapped key once material is available, creating a new KeyVault.", async () => {
        const mailbox = await createMailbox();
        const certificate = await generateSelfSignedCertPem(mailbox.primarySmtpAddress);
        FakeDrivenEnrollment.entries.set("e2", {
            identity: mailbox.primarySmtpAddress,
            status: "issued",
            material: { certificate, wrappedKey: { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" } },
            advanceCallCount: 0,
        });

        await job.run();

        expect(FakeDrivenEnrollment.entries.get("e2")!.installed).toBe(true);
        const updatedMailbox = await mailboxRepo.findOne({ uid: mailbox.uid } as any);
        expect(updatedMailbox?.keys).toHaveLength(1);
        expect(updatedMailbox?.keys[0].useType).toBe("sign");

        const keyVault = await keyVaultRepo.findOne({ mailboxUid: mailbox.uid } as any);
        expect(keyVault?.wrappedKeys).toHaveLength(1);
        expect(keyVault?.wrappedKeys[0].useType).toBe("sign");
        expect(keyVault?.wrappedKeys[0].fingerprint).toBe(updatedMailbox?.keys[0].fingerprint);

        const auditEntries = await auditLogRepo.find({ targetUid: keyVault!.uid }).toArray();
        expect(auditEntries.some((e) => e.action === AuditAction.KEY_VAULT_ENROLL)).toBe(true);
    });

    it("Never installs a wrapped key sealed under a master key the vault has since rotated away from - it cancels the enrollment instead (round 5).", async () => {
        const mailbox = await createMailbox();
        await keyVaultRepo.save(new KeyVaultMongo({ mailboxUid: mailbox.uid, wrappedKeys: [], masterKeyWraps: [], masterKeyGeneration: 2 }));
        const certificate = await generateSelfSignedCertPem(mailbox.primarySmtpAddress);
        const wrappedKey = { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" };
        FakeDrivenEnrollment.entries.set("stale", {
            identity: mailbox.primarySmtpAddress,
            status: "issued",
            material: { certificate, wrappedKey, mailboxUid: mailbox.uid, masterKeyGeneration: 1 },
            advanceCallCount: 0,
        });
        // Started before generations were recorded, onto a vault that has rotated since.
        FakeDrivenEnrollment.entries.set("legacy", {
            identity: mailbox.primarySmtpAddress,
            status: "issued",
            material: { certificate, wrappedKey },
            advanceCallCount: 0,
        });

        await job.run();

        for (const id of ["stale", "legacy"]) {
            expect(FakeDrivenEnrollment.entries.get(id)!.installed).toBeFalsy();
            expect(FakeDrivenEnrollment.entries.get(id)!.cancelledReason).toMatch(/keys were rotated/);
        }
        expect((await keyVaultRepo.findOne({ mailboxUid: mailbox.uid } as any))?.wrappedKeys).toHaveLength(0);
        expect((await mailboxRepo.findOne({ uid: mailbox.uid } as any))?.keys ?? []).toHaveLength(0);

        // The current generation installs.
        FakeDrivenEnrollment.entries.set("current", {
            identity: mailbox.primarySmtpAddress,
            status: "issued",
            material: { certificate, wrappedKey, mailboxUid: mailbox.uid, masterKeyGeneration: 2 },
            advanceCallCount: 0,
        });
        await job.run();
        expect(FakeDrivenEnrollment.entries.get("current")!.installed).toBe(true);
        expect((await keyVaultRepo.findOne({ mailboxUid: mailbox.uid } as any))?.wrappedKeys).toHaveLength(1);
    });

    it("Never installs into a different mailbox than the one that started the enrollment, even at the same address (round 5).", async () => {
        const mailbox = await createMailbox();
        const certificate = await generateSelfSignedCertPem(mailbox.primarySmtpAddress);
        FakeDrivenEnrollment.entries.set("moved", {
            identity: mailbox.primarySmtpAddress,
            status: "issued",
            material: { certificate, wrappedKey: { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" }, mailboxUid: "some-other-mailbox" },
            advanceCallCount: 0,
        });

        await job.run();

        expect(FakeDrivenEnrollment.entries.get("moved")!.installed).toBeFalsy();
        expect(FakeDrivenEnrollment.entries.get("moved")!.cancelledReason).toMatch(/different mailbox/);
        expect((await keyVaultRepo.findOne({ mailboxUid: mailbox.uid } as any))).toBeFalsy();
    });

    it("Appends to an existing KeyVault's wrappedKeys rather than creating a second one.", async () => {
        const mailbox = await createMailbox();
        await keyVaultRepo.save(new KeyVaultMongo({ mailboxUid: mailbox.uid, wrappedKeys: [], masterKeyWraps: [] }));
        const certificate = await generateSelfSignedCertPem(mailbox.primarySmtpAddress);
        FakeDrivenEnrollment.entries.set("e3", {
            identity: mailbox.primarySmtpAddress,
            status: "issued",
            material: { certificate, wrappedKey: { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" } },
            advanceCallCount: 0,
        });

        await job.run();

        const keyVaults = await keyVaultRepo.find({ mailboxUid: mailbox.uid }).toArray();
        expect(keyVaults).toHaveLength(1);
        expect(keyVaults[0].wrappedKeys).toHaveLength(1);
    });

    it("Installs only the missing KeyVault half (no duplicate Mailbox.keys entry) when the fingerprint is already on Mailbox.keys but not in the KeyVault.", async () => {
        const mailbox = await createMailbox();
        const certificate = await generateSelfSignedCertPem(mailbox.primarySmtpAddress);
        const { fingerprint } = publicKeyFromCertificatePem(certificate, "sign", mailbox.primarySmtpAddress);
        await mailboxRepo.updateOne(
            { uid: mailbox.uid } as any,
            {
                $set: {
                    keys: [
                        { publicKey: "x", type: "x509", useType: "sign", fingerprint, notBefore: Date.now(), notAfter: Date.now() + 1000000 },
                    ],
                },
            },
        );

        FakeDrivenEnrollment.entries.set("e4", {
            identity: mailbox.primarySmtpAddress,
            status: "issued",
            material: { certificate, wrappedKey: { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" } },
            advanceCallCount: 0,
        });

        await job.run();

        const updatedMailbox = await mailboxRepo.findOne({ uid: mailbox.uid } as any);
        expect(updatedMailbox?.keys).toHaveLength(1);
        const keyVault = await keyVaultRepo.findOne({ mailboxUid: mailbox.uid } as any);
        expect(keyVault?.wrappedKeys).toHaveLength(1);
        expect(keyVault?.wrappedKeys[0].fingerprint).toBe(fingerprint);
        expect(FakeDrivenEnrollment.entries.get("e4")!.installed).toBe(true);
    });

    it("Skips entirely and marks installed when BOTH the KeyVault and Mailbox.keys already hold the certificate.", async () => {
        const mailbox = await createMailbox();
        const certificate = await generateSelfSignedCertPem(mailbox.primarySmtpAddress);
        const { publicKey, fingerprint } = publicKeyFromCertificatePem(certificate, "sign", mailbox.primarySmtpAddress);
        const mb = await mailboxRepo.findOne({ uid: mailbox.uid } as any);
        mb!.keys = [publicKey];
        await mailboxRepo.save(mb!);
        await keyVaultRepo.save(
            new KeyVaultMongo({
                mailboxUid: mailbox.uid,
                wrappedKeys: [{ ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM", fingerprint, useType: "sign" } as any],
                masterKeyWraps: [],
            }),
        );
        FakeDrivenEnrollment.entries.set("e-both", {
            identity: mailbox.primarySmtpAddress,
            status: "issued",
            material: { certificate, wrappedKey: { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" } },
            advanceCallCount: 0,
        });

        await job.run();

        expect(FakeDrivenEnrollment.entries.get("e-both")!.installed).toBe(true);
        expect((await keyVaultRepo.findOne({ mailboxUid: mailbox.uid } as any))?.wrappedKeys).toHaveLength(1);
        expect((await mailboxRepo.findOne({ uid: mailbox.uid } as any))?.keys).toHaveLength(1);
    });

    it("Writes the KeyVault before Mailbox.keys - a failure publishing the certificate leaves the private key stored and the enrollment un-installed, and the next run completes it.", async () => {
        const mailbox = await createMailbox();
        const certificate = await generateSelfSignedCertPem(mailbox.primarySmtpAddress);
        FakeDrivenEnrollment.entries.set("e-order", {
            identity: mailbox.primarySmtpAddress,
            status: "issued",
            material: { certificate, wrappedKey: { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" } },
            advanceCallCount: 0,
        });
        const mailboxRepoUtils: any = (job as any).mailboxRepo;
        const originalUpdate = mailboxRepoUtils.update;
        mailboxRepoUtils.update = async () => {
            throw new Error("simulated mailbox write failure");
        };
        try {
            await job.run();
        } finally {
            mailboxRepoUtils.update = originalUpdate;
        }

        expect(FakeDrivenEnrollment.entries.get("e-order")!.installed).toBeFalsy();
        expect((await keyVaultRepo.findOne({ mailboxUid: mailbox.uid } as any))?.wrappedKeys).toHaveLength(1);
        expect((await mailboxRepo.findOne({ uid: mailbox.uid } as any))?.keys ?? []).toHaveLength(0);

        await job.run();

        expect(FakeDrivenEnrollment.entries.get("e-order")!.installed).toBe(true);
        expect((await keyVaultRepo.findOne({ mailboxUid: mailbox.uid } as any))?.wrappedKeys).toHaveLength(1);
        expect((await mailboxRepo.findOne({ uid: mailbox.uid } as any))?.keys).toHaveLength(1);
    });

    describe("key rotation continuity", () => {
        const wrappedKey = { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" };
        const existingKeys = (address: string) => [
            { publicKey: "b2xk", type: "x509", useType: "sign" as const, fingerprint: `old-sign-${address}`, notBefore: 1, notAfter: Date.now() + 10_000_000 },
            { publicKey: "ZW5j", type: "x509", useType: "encrypt" as const, fingerprint: `enc-${address}`, notBefore: 1, notAfter: Date.now() + 10_000_000 },
        ];

        it("installs an ACME PEM chain's leaf with its verified issuer and revokes the previous signing key as superseded (encryption key untouched).", async () => {
            const address = `${uuid.v4()}@example.com`;
            const mailbox = await createMailbox({ primarySmtpAddress: address, keys: existingKeys(address) });
            const ca = await makeTestCa("CN=ACME Intermediate");
            const leafPem = await issueTestLeaf(ca, address);
            FakeDrivenEnrollment.entries.set("chain", {
                identity: address,
                status: "issued",
                material: { certificate: `${leafPem}\n${ca.pem}\n${(await makeTestCa("CN=Root")).pem}`, wrappedKey },
                advanceCallCount: 0,
            });

            const before = Date.now();
            await job.run();

            expect(FakeDrivenEnrollment.entries.get("chain")!.installed).toBe(true);
            const keys: any[] = (await (async (uid: string) => await mailboxRepo.findOne({ uid } as any))(mailbox.uid))?.keys ?? [];
            expect(keys.map((k) => k.fingerprint)).toEqual([`old-sign-${address}`, `enc-${address}`, publicKeyFromCertificatePem(leafPem, "sign", address).fingerprint]);
            expect(keys[0].revokedAt).toBeGreaterThanOrEqual(before);
            expect(keys[0].revocationReason).toBe("superseded");
            expect(keys[1].revokedAt ?? undefined).toBeUndefined();
            expect(keys[2].issuerCertificate).toBe(ca.der);
            expect(keys[2].revokedAt ?? undefined).toBeUndefined();
        });

        it("drops an ACME chain issuer that didn't sign the leaf.", async () => {
            const address = `${uuid.v4()}@example.com`;
            const mailbox = await createMailbox({ primarySmtpAddress: address });
            const ca = await makeTestCa("CN=ACME Intermediate");
            const impostor = await makeTestCa("CN=ACME Intermediate");
            FakeDrivenEnrollment.entries.set("impostor", {
                identity: address,
                status: "issued",
                material: { certificate: `${await issueTestLeaf(ca, address)}${impostor.pem}`, wrappedKey },
                advanceCallCount: 0,
            });

            await job.run();

            const keys: any[] = (await (async (uid: string) => await mailboxRepo.findOne({ uid } as any))(mailbox.uid))?.keys ?? [];
            expect(keys).toHaveLength(1);
            expect(keys[0].issuerCertificate ?? undefined).toBeUndefined();
        });

        it("revokes nothing when publishing the certificate fails, and revokes on the run that publishes it.", async () => {
            const address = `${uuid.v4()}@example.com`;
            const mailbox = await createMailbox({ primarySmtpAddress: address, keys: existingKeys(address) });
            const ca = await makeTestCa("CN=ACME Intermediate");
            FakeDrivenEnrollment.entries.set("fails", {
                identity: address,
                status: "issued",
                material: { certificate: `${await issueTestLeaf(ca, address)}${ca.pem}`, wrappedKey },
                advanceCallCount: 0,
            });
            const mailboxRepoUtils: any = (job as any).mailboxRepo;
            const originalUpdate = mailboxRepoUtils.update;
            mailboxRepoUtils.update = async () => {
                throw new Error("simulated mailbox write failure");
            };
            try {
                await job.run();
            } finally {
                mailboxRepoUtils.update = originalUpdate;
            }

            let keys: any[] = (await (async (uid: string) => await mailboxRepo.findOne({ uid } as any))(mailbox.uid))?.keys ?? [];
            expect(keys).toHaveLength(2);
            expect(keys.every((k) => !k.revokedAt)).toBe(true);

            await job.run();
            keys = (await (async (uid: string) => await mailboxRepo.findOne({ uid } as any))(mailbox.uid))?.keys ?? [];
            expect(keys).toHaveLength(3);
            expect(keys[0].revocationReason).toBe("superseded");
            expect(keys[1].revokedAt ?? undefined).toBeUndefined();
        });
    });

    it("Installs onto a legacy mailbox row where keys reads back as null instead of an empty array.", async () => {
        const mailbox = await createMailbox();
        await mailboxRepo.updateOne({ uid: mailbox.uid } as any, { $set: { keys: null } } as any);
        const certificate = await generateSelfSignedCertPem(mailbox.primarySmtpAddress);
        FakeDrivenEnrollment.entries.set("e-null-keys", {
            identity: mailbox.primarySmtpAddress,
            status: "issued",
            material: { certificate, wrappedKey: { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" } },
            advanceCallCount: 0,
        });

        await expect(job.run()).resolves.toBeUndefined();

        const updatedMailbox = await mailboxRepo.findOne({ uid: mailbox.uid } as any);
        expect(updatedMailbox?.keys).toHaveLength(1);
    });

    it("Logs a warning (no throw) and leaves the enrollment un-installed when no mailbox matches the identity.", async () => {
        const certificate = await generateSelfSignedCertPem("ghost@example.com");
        FakeDrivenEnrollment.entries.set("e5", {
            identity: "ghost@example.com",
            status: "issued",
            material: { certificate, wrappedKey: { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" } },
            advanceCallCount: 0,
        });

        await expect(job.run()).resolves.toBeUndefined();

        expect(FakeDrivenEnrollment.entries.get("e5")!.installed).toBeFalsy();
    });

    it("Continues processing other enrollments when one throws.", async () => {
        const mailboxA = await createMailbox();
        const mailboxB = await createMailbox();
        FakeDrivenEnrollment.entries.set("bad", { identity: mailboxA.primarySmtpAddress, status: "pending", advanceCallCount: 0 });
        FakeDrivenEnrollment.entries.set("good", { identity: mailboxB.primarySmtpAddress, status: "pending", advanceCallCount: 0 });
        const originalAdvance = FakeDrivenEnrollment.prototype.advanceEnrollment;
        FakeDrivenEnrollment.prototype.advanceEnrollment = async function (enrollmentId: string): Promise<void> {
            if (enrollmentId === "bad") {
                throw new Error("simulated failure");
            }
            return originalAdvance.call(this, enrollmentId);
        };

        try {
            await expect(job.run()).resolves.toBeUndefined();
        } finally {
            FakeDrivenEnrollment.prototype.advanceEnrollment = originalAdvance;
        }

        expect(FakeDrivenEnrollment.entries.get("good")!.advanceCallCount).toBe(1);
    });

    it("Does nothing (no throw) when the registered SigningCertificateEnrollment doesn't support this feature (e.g. NullSigningCertificateEnrollment).", async () => {
        const original = FakeDrivenEnrollment.prototype.listPendingEnrollments;
        delete (FakeDrivenEnrollment.prototype as any).listPendingEnrollments;

        try {
            await expect(job.run()).resolves.toBeUndefined();
        } finally {
            FakeDrivenEnrollment.prototype.listPendingEnrollments = original;
        }
    });

    describe("flagExpiringSigningCerts()", () => {
        it("Records the expiry audit entry only once per certificate across repeated runs, persisting the fingerprint on the KeyVault, and again for a new certificate.", async () => {
            const soon = (fp: string) => ({ publicKey: "x", type: "x509", useType: "sign" as const, fingerprint: fp, notBefore: Date.now() - 1000, notAfter: Date.now() + 24 * 60 * 60 * 1000 });
            const mailbox = await createMailbox({ keys: [soon("fp-1")] });
            await keyVaultRepo.save(new KeyVaultMongo({ mailboxUid: mailbox.uid, wrappedKeys: [], masterKeyWraps: [] }));

            await job.run();
            await job.run();
            await job.run();

            let entries = (await auditLogRepo.find({ targetUid: mailbox.uid }).toArray()).filter((e) => e.action === AuditAction.SIGNING_CERT_EXPIRING);
            expect(entries).toHaveLength(1);
            expect((await keyVaultRepo.findOne({ mailboxUid: mailbox.uid } as any))?.expiryAuditedFingerprint).toBe("fp-1");

            const mb = await mailboxRepo.findOne({ uid: mailbox.uid } as any);
            mb!.keys = [soon("fp-2")];
            await mailboxRepo.save(mb!);
            await job.run();
            await job.run();

            entries = (await auditLogRepo.find({ targetUid: mailbox.uid }).toArray()).filter((e) => e.action === AuditAction.SIGNING_CERT_EXPIRING);
            expect(entries).toHaveLength(2);
            expect((await keyVaultRepo.findOne({ mailboxUid: mailbox.uid } as any))?.expiryAuditedFingerprint).toBe("fp-2");
        });

        it("Logs (no audit, no throw) when persisting the expiry marker on the KeyVault fails.", async () => {
            const mailbox = await createMailbox({
                keys: [{ publicKey: "x", type: "x509", useType: "sign", fingerprint: "marker-fails", notBefore: Date.now() - 1000, notAfter: Date.now() + 24 * 60 * 60 * 1000 }],
            });
            await keyVaultRepo.save(new KeyVaultMongo({ mailboxUid: mailbox.uid, wrappedKeys: [], masterKeyWraps: [] }));
            const updateSpy = vi.spyOn((job as any).keyVaultRepo, "update").mockRejectedValueOnce(new Error("simulated marker write failure"));
            const errorSpy = vi.spyOn((job as any).logger, "error");

            try {
                await expect(job.run()).resolves.toBeUndefined();
            } finally {
                updateSpy.mockRestore();
            }

            expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("simulated marker write failure"));
            errorSpy.mockRestore();
            expect((await auditLogRepo.find({ targetUid: mailbox.uid }).toArray()).filter((e) => e.action === AuditAction.SIGNING_CERT_EXPIRING)).toHaveLength(0);
        });

        it("Skips (no audit, no throw) an expiring signing key on a mailbox with no KeyVault to persist the marker on.", async () => {
            const mailbox = await createMailbox({
                keys: [{ publicKey: "x", type: "x509", useType: "sign", fingerprint: "abc", notBefore: Date.now() - 1000, notAfter: Date.now() + 24 * 60 * 60 * 1000 }],
            });

            await expect(job.run()).resolves.toBeUndefined();

            expect((await auditLogRepo.find({ targetUid: mailbox.uid }).toArray()).filter((e) => e.action === AuditAction.SIGNING_CERT_EXPIRING)).toHaveLength(0);
        });

        it("Pages through every mailbox, not just the first 100.", async () => {
            for (let i = 0; i < 105; i++) {
                await createMailbox();
            }
            // Highest possible uid, so it sorts onto the last page.
            const mailbox = await createMailbox({
                uid: "ffffffff-ffff-4fff-bfff-ffffffffffff",
                keys: [{ publicKey: "x", type: "x509", useType: "sign", fingerprint: "last", notBefore: Date.now() - 1000, notAfter: Date.now() + 24 * 60 * 60 * 1000 }],
            } as any);
            await keyVaultRepo.save(new KeyVaultMongo({ mailboxUid: mailbox.uid, wrappedKeys: [], masterKeyWraps: [] }));

            await job.run();

            expect((await auditLogRepo.find({ targetUid: mailbox.uid }).toArray()).some((e) => e.action === AuditAction.SIGNING_CERT_EXPIRING)).toBe(true);
        });

        it("Flags a mailbox whose newest non-revoked signing key is within the expiry warning window.", async () => {
            const mailbox = await createMailbox({
                keys: [
                    { publicKey: "x", type: "x509", useType: "sign", fingerprint: "abc", notBefore: Date.now() - 1000, notAfter: Date.now() + 24 * 60 * 60 * 1000 },
                ],
            });

            await keyVaultRepo.save(new KeyVaultMongo({ mailboxUid: mailbox.uid, wrappedKeys: [], masterKeyWraps: [] }));

            await job.run();

            const auditEntries = await auditLogRepo.find({ targetUid: mailbox.uid }).toArray();
            expect(auditEntries.some((e) => e.action === AuditAction.SIGNING_CERT_EXPIRING)).toBe(true);
        });

        it("Does not flag a mailbox whose signing key is nowhere near expiry.", async () => {
            const mailbox = await createMailbox({
                keys: [
                    { publicKey: "x", type: "x509", useType: "sign", fingerprint: "abc", notBefore: Date.now() - 1000, notAfter: Date.now() + 365 * 24 * 60 * 60 * 1000 },
                ],
            });

            await job.run();

            const auditEntries = await auditLogRepo.find({ targetUid: mailbox.uid }).toArray();
            expect(auditEntries.some((e) => e.action === AuditAction.SIGNING_CERT_EXPIRING)).toBe(false);
        });

        it("Ignores a revoked signing key even if it's within the expiry window.", async () => {
            const mailbox = await createMailbox({
                keys: [
                    {
                        publicKey: "x",
                        type: "x509",
                        useType: "sign",
                        fingerprint: "abc",
                        notBefore: Date.now() - 1000,
                        notAfter: Date.now() + 24 * 60 * 60 * 1000,
                        revokedAt: Date.now(),
                    },
                ],
            });

            await job.run();

            const auditEntries = await auditLogRepo.find({ targetUid: mailbox.uid }).toArray();
            expect(auditEntries.some((e) => e.action === AuditAction.SIGNING_CERT_EXPIRING)).toBe(false);
        });

        it("Ignores a mailbox with no signing keys at all.", async () => {
            const mailbox = await createMailbox({
                keys: [
                    { publicKey: "x", type: "x509", useType: "encrypt", fingerprint: "abc", notBefore: Date.now() - 1000, notAfter: Date.now() + 24 * 60 * 60 * 1000 },
                ],
            });

            await job.run();

            const auditEntries = await auditLogRepo.find({ targetUid: mailbox.uid }).toArray();
            expect(auditEntries).toHaveLength(0);
        });

        it("Tolerates a legacy row where keys reads back as null instead of an empty array.", async () => {
            const mailbox = await createMailbox();
            await mailboxRepo.updateOne({ uid: mailbox.uid } as any, { $set: { keys: null } } as any);

            await expect(job.run()).resolves.toBeUndefined();

            const auditEntries = await auditLogRepo.find({ targetUid: mailbox.uid }).toArray();
            expect(auditEntries).toHaveLength(0);
        });

        it("Flags based on the newest non-revoked signing key when a mailbox has more than one (newest listed first).", async () => {
            const mailbox = await createMailbox({
                keys: [
                    { publicKey: "y", type: "x509", useType: "sign", fingerprint: "new", notBefore: Date.now() - 1000, notAfter: Date.now() + 365 * 24 * 60 * 60 * 1000 },
                    { publicKey: "x", type: "x509", useType: "sign", fingerprint: "old", notBefore: Date.now() - 1000, notAfter: Date.now() + 24 * 60 * 60 * 1000 },
                ],
            });

            await job.run();

            const auditEntries = await auditLogRepo.find({ targetUid: mailbox.uid }).toArray();
            expect(auditEntries.some((e) => e.action === AuditAction.SIGNING_CERT_EXPIRING)).toBe(false);
        });

        it("Flags based on the newest non-revoked signing key when a mailbox has more than one (oldest listed first).", async () => {
            const mailbox = await createMailbox({
                keys: [
                    { publicKey: "x", type: "x509", useType: "sign", fingerprint: "old", notBefore: Date.now() - 1000, notAfter: Date.now() + 24 * 60 * 60 * 1000 },
                    { publicKey: "y", type: "x509", useType: "sign", fingerprint: "new", notBefore: Date.now() - 1000, notAfter: Date.now() + 365 * 24 * 60 * 60 * 1000 },
                ],
            });

            await job.run();

            const auditEntries = await auditLogRepo.find({ targetUid: mailbox.uid }).toArray();
            expect(auditEntries.some((e) => e.action === AuditAction.SIGNING_CERT_EXPIRING)).toBe(false);
        });
    });
});
