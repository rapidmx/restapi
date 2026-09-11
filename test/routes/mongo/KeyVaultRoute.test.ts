///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import config from "../../config.js";
import { request } from "@rapidrest/service-core/test";
import { ACLRecord, MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager, ACLAction } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as x509 from "@peculiar/x509";
import * as uuid from "uuid";
import { AuditLogEntryMongo } from "../../../src/models/mongo/AuditLogEntryMongo.js";
import { KeyVaultMongo } from "../../../src/models/mongo/KeyVaultMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { AuditAction } from "../../../src/models/types.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { FakeEncryptionCertificateAuthority, generateTestCsr, registerTestDoubles } from "../../testDoubles.js";

x509.cryptoProvider.set(crypto);

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

async function generateSelfSignedCert(identity: string): Promise<string> {
    const keys: CryptoKeyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
    ]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        name: `CN=${identity}`,
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        keys,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    });
    return cert.toString("pem");
}

describe("Route:KeyVaultMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/mailboxes";
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let keyVaultRepo: MongoRepository<KeyVaultMongo>;
    let aclRepo: MongoRepository<any>;
    let auditLogRepo: MongoRepository<AuditLogEntryMongo>;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);
    const otherUser: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const otherUserToken = JWTUtils.createTokenSync(config.get("auth"), otherUser);
    const delegate: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const delegateToken = JWTUtils.createTokenSync(config.get("auth"), delegate);
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

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

        const records: ACLRecord[] = [
            { userOrRoleId: owner.uid, actions: [ACLAction.FULL] },
            { userOrRoleId: delegate.uid, actions: [ACLAction.READ, ACLAction.UPDATE] },
        ];
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
        // Real key issuance is needed for the "encrypt" enrollment path - registered *before*
        // `registerTestDoubles()` since `ObjectFactory.register()` is a no-op once a name is already
        // registered (confirmed in `ObjectFactory.js`), so this must win the race, not the other way around.
        objectFactory.register(FakeEncryptionCertificateAuthority, "EncryptionCertificateAuthority");
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
    });

    beforeEach(async () => {
        for (const r of [mailboxRepo, keyVaultRepo, auditLogRepo]) {
            try {
                await r.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
        try {
            await aclRepo.clear();
        } catch (err: any) {
            if (err.message !== "ns not found") {
                throw err;
            }
        }
    });

    describe("GET /:id/keyvault", () => {
        it("Owner sees an empty vault before anything has been enrolled.", async () => {
            const mailbox = await createMailbox();
            const result = await request(server.getApplication())
                .get(`${baseUrl}/${mailbox.uid}/keyvault`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(200);
            expect(result.body).toEqual({ wrappedKeys: [], masterKeyWraps: [] });
        });

        it("A caller with a delegate READ grant (not owner) can read the vault.", async () => {
            const mailbox = await createMailbox();
            const result = await request(server.getApplication())
                .get(`${baseUrl}/${mailbox.uid}/keyvault`)
                .set("Authorization", "jwt " + delegateToken);

            expect(result.status).toBe(200);
        });

        it("A different, unrelated user cannot read the vault (403).", async () => {
            const mailbox = await createMailbox();
            const result = await request(server.getApplication())
                .get(`${baseUrl}/${mailbox.uid}/keyvault`)
                .set("Authorization", "jwt " + otherUserToken);

            expect(result.status).toBe(403);
        });

        it("A trusted (admin) caller with no owner/delegate grant CANNOT read the vault (403) - deliberately no trusted-role bypass for private key material.", async () => {
            const mailbox = await createMailbox();
            const result = await request(server.getApplication())
                .get(`${baseUrl}/${mailbox.uid}/keyvault`)
                .set("Authorization", "jwt " + adminToken);

            expect(result.status).toBe(403);
        });

        it("Returns 404 for a nonexistent mailbox.", async () => {
            const result = await request(server.getApplication())
                .get(`${baseUrl}/${uuid.v4()}/keyvault`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(404);
        });

        it("A caller cannot read a mailbox with no ACL row at all (no findACL() result to check a record against).", async () => {
            const mailbox = await mailboxRepo.save(
                new MailboxMongo({
                    ownerUserUid: owner.uid,
                    primarySmtpAddress: `${uuid.v4()}@example.com`,
                    aliasAddresses: [],
                    displayName: "No ACL Mailbox",
                    timezone: "UTC",
                    quotaBytes: 1_000_000_000,
                    usedBytes: 0,
                }),
            );

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${mailbox.uid}/keyvault`)
                .set("Authorization", "jwt " + otherUserToken);

            expect(result.status).toBe(403);
        });

        it("Owner sees the vault's actual contents once a key has been enrolled.", async () => {
            const mailbox = await createMailbox();
            await request(server.getApplication())
                .post(`${baseUrl}/${mailbox.uid}/keyvault/keys`)
                .set("Authorization", "jwt " + ownerToken)
                .send({
                    useType: "encrypt",
                    csr: await generateTestCsr(mailbox.primarySmtpAddress),
                    wrappedKey: { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" },
                });

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${mailbox.uid}/keyvault`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(200);
            expect(result.body.wrappedKeys).toHaveLength(1);
        });
    });

    describe("POST /:id/keyvault/keys (enrollment)", () => {
        it("Enrolls an encryption key via a CSR - issues the cert through EncryptionCertificateAuthority, publishes the PublicKey on Mailbox.keys, and stores the wrapped key + initial master key wraps.", async () => {
            const mailbox = await createMailbox();
            const csr = await generateTestCsr(mailbox.primarySmtpAddress);

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${mailbox.uid}/keyvault/keys`)
                .set("Authorization", "jwt " + ownerToken)
                .send({
                    useType: "encrypt",
                    csr,
                    wrappedKey: { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" },
                    masterKeyWraps: [
                        { method: "password", ciphertext: "mkct", nonce: "mkn", salt: "salt", kdf: "argon2id", schemeVersion: 1, createdAt: Date.now() },
                    ],
                });

            expect(result.status).toBe(200);
            expect(result.body.wrappedKeys).toHaveLength(1);
            expect(result.body.wrappedKeys[0].useType).toBe("encrypt");
            expect(result.body.masterKeyWraps).toHaveLength(1);

            const updatedMailbox = await mailboxRepo.findOne({ uid: mailbox.uid } as any);
            expect(updatedMailbox?.keys).toHaveLength(1);
            expect(updatedMailbox?.keys[0].useType).toBe("encrypt");
            expect(updatedMailbox?.keys[0].fingerprint).toBe(result.body.wrappedKeys[0].fingerprint);

            const entries = await auditLogRepo.find({ action: AuditAction.KEY_VAULT_ENROLL }).toArray();
            expect(entries).toHaveLength(1);
        });

        it("Enrolls a signing key via an already-issued certificate, without calling EncryptionCertificateAuthority.", async () => {
            const mailbox = await createMailbox();
            const certificate = await generateSelfSignedCert(mailbox.primarySmtpAddress);

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${mailbox.uid}/keyvault/keys`)
                .set("Authorization", "jwt " + ownerToken)
                .send({
                    useType: "sign",
                    certificate,
                    wrappedKey: { ciphertext: "ct2", nonce: "n2", algorithm: "AES-256-GCM" },
                });

            expect(result.status).toBe(200);
            expect(result.body.wrappedKeys).toHaveLength(1);
            expect(result.body.wrappedKeys[0].useType).toBe("sign");

            const updatedMailbox = await mailboxRepo.findOne({ uid: mailbox.uid } as any);
            expect(updatedMailbox?.keys[0].useType).toBe("sign");
        });

        it("A second enrollment does not overwrite masterKeyWraps established by the first.", async () => {
            const mailbox = await createMailbox();
            await request(server.getApplication())
                .post(`${baseUrl}/${mailbox.uid}/keyvault/keys`)
                .set("Authorization", "jwt " + ownerToken)
                .send({
                    useType: "encrypt",
                    csr: await generateTestCsr(mailbox.primarySmtpAddress),
                    wrappedKey: { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" },
                    masterKeyWraps: [
                        { method: "password", ciphertext: "mkct", nonce: "mkn", salt: "salt", kdf: "argon2id", schemeVersion: 1, createdAt: Date.now() },
                    ],
                });

            const second = await request(server.getApplication())
                .post(`${baseUrl}/${mailbox.uid}/keyvault/keys`)
                .set("Authorization", "jwt " + ownerToken)
                .send({
                    useType: "sign",
                    certificate: await generateSelfSignedCert(`other-${mailbox.primarySmtpAddress}`),
                    wrappedKey: { ciphertext: "ct2", nonce: "n2", algorithm: "AES-256-GCM" },
                    masterKeyWraps: [
                        { method: "recovery", ciphertext: "should-be-ignored", nonce: "n", salt: "s", kdf: "argon2id", schemeVersion: 1, createdAt: Date.now() },
                    ],
                });

            expect(second.status).toBe(200);
            expect(second.body.wrappedKeys).toHaveLength(2);
            expect(second.body.masterKeyWraps).toHaveLength(1);
            expect(second.body.masterKeyWraps[0].method).toBe("password");
        });

        it("Rejects a request with no wrappedKey at all (400).", async () => {
            const mailbox = await createMailbox();
            const result = await request(server.getApplication())
                .post(`${baseUrl}/${mailbox.uid}/keyvault/keys`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ useType: "encrypt", csr: await generateTestCsr(mailbox.primarySmtpAddress) });

            expect(result.status).toBe(400);
        });

        it("Rejects useType 'encrypt' with no csr (400).", async () => {
            const mailbox = await createMailbox();
            const result = await request(server.getApplication())
                .post(`${baseUrl}/${mailbox.uid}/keyvault/keys`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ useType: "encrypt", wrappedKey: { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" } });

            expect(result.status).toBe(400);
        });

        it("Rejects useType 'sign' with no certificate (400).", async () => {
            const mailbox = await createMailbox();
            const result = await request(server.getApplication())
                .post(`${baseUrl}/${mailbox.uid}/keyvault/keys`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ useType: "sign", wrappedKey: { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" } });

            expect(result.status).toBe(400);
        });

        it("Rejects an invalid useType (400).", async () => {
            const mailbox = await createMailbox();
            const result = await request(server.getApplication())
                .post(`${baseUrl}/${mailbox.uid}/keyvault/keys`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ useType: "encipher", wrappedKey: { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" } });

            expect(result.status).toBe(400);
        });

        it("Rejects an unparseable certificate for useType 'sign' (400).", async () => {
            const mailbox = await createMailbox();
            const result = await request(server.getApplication())
                .post(`${baseUrl}/${mailbox.uid}/keyvault/keys`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ useType: "sign", certificate: "not a cert", wrappedKey: { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" } });

            expect(result.status).toBe(400);
        });

        it("Rejects re-enrolling a fingerprint that is already active (400).", async () => {
            const mailbox = await createMailbox();
            const certificate = await generateSelfSignedCert(mailbox.primarySmtpAddress);
            const first = await request(server.getApplication())
                .post(`${baseUrl}/${mailbox.uid}/keyvault/keys`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ useType: "sign", certificate, wrappedKey: { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" } });
            expect(first.status).toBe(200);

            const second = await request(server.getApplication())
                .post(`${baseUrl}/${mailbox.uid}/keyvault/keys`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ useType: "sign", certificate, wrappedKey: { ciphertext: "ct2", nonce: "n2", algorithm: "AES-256-GCM" } });

            expect(second.status).toBe(400);
        });

        it("A different, unrelated user cannot enroll a key (403).", async () => {
            const mailbox = await createMailbox();
            const result = await request(server.getApplication())
                .post(`${baseUrl}/${mailbox.uid}/keyvault/keys`)
                .set("Authorization", "jwt " + otherUserToken)
                .send({ useType: "encrypt", csr: await generateTestCsr("x"), wrappedKey: { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" } });

            expect(result.status).toBe(403);
        });
    });

    describe("POST /:id/keyvault/wraps and DELETE /:id/keyvault/wraps/:method", () => {
        const enrollFirstKey = async function (mailbox: MailboxMongo): Promise<void> {
            await request(server.getApplication())
                .post(`${baseUrl}/${mailbox.uid}/keyvault/keys`)
                .set("Authorization", "jwt " + ownerToken)
                .send({
                    useType: "encrypt",
                    csr: await generateTestCsr(mailbox.primarySmtpAddress),
                    wrappedKey: { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" },
                    masterKeyWraps: [
                        { method: "password", ciphertext: "mkct", nonce: "mkn", salt: "salt", kdf: "argon2id", schemeVersion: 1, createdAt: Date.now() },
                    ],
                });
        };

        it("Adds a new master key wrap to an already-initialized vault.", async () => {
            const mailbox = await createMailbox();
            await enrollFirstKey(mailbox);

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${mailbox.uid}/keyvault/wraps`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ method: "passkey", methodId: "cred-1", ciphertext: "ct", nonce: "n", salt: "s", kdf: "argon2id", schemeVersion: 1, createdAt: Date.now() });

            expect(result.status).toBe(200);
            expect(result.body.masterKeyWraps).toHaveLength(2);

            const entries = await auditLogRepo.find({ action: AuditAction.KEY_VAULT_WRAP_ADD }).toArray();
            expect(entries).toHaveLength(1);
        });

        it("Returns 404 adding a wrap to a mailbox with no vault yet.", async () => {
            const mailbox = await createMailbox();
            const result = await request(server.getApplication())
                .post(`${baseUrl}/${mailbox.uid}/keyvault/wraps`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ method: "passkey", ciphertext: "ct", nonce: "n", salt: "s", kdf: "argon2id", schemeVersion: 1, createdAt: Date.now() });

            expect(result.status).toBe(404);
        });

        it("Removes a master key wrap by method + methodId - does not remove others of the same method.", async () => {
            const mailbox = await createMailbox();
            await enrollFirstKey(mailbox);
            await request(server.getApplication())
                .post(`${baseUrl}/${mailbox.uid}/keyvault/wraps`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ method: "passkey", methodId: "cred-1", ciphertext: "ct", nonce: "n", salt: "s", kdf: "argon2id", schemeVersion: 1, createdAt: Date.now() });
            await request(server.getApplication())
                .post(`${baseUrl}/${mailbox.uid}/keyvault/wraps`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ method: "passkey", methodId: "cred-2", ciphertext: "ct", nonce: "n", salt: "s", kdf: "argon2id", schemeVersion: 1, createdAt: Date.now() });

            const result = await request(server.getApplication())
                .delete(`${baseUrl}/${mailbox.uid}/keyvault/wraps/passkey?methodId=cred-1`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(200);
            expect(result.body.masterKeyWraps.map((w: any) => w.methodId)).toEqual([undefined, "cred-2"]);

            const entries = await auditLogRepo.find({ action: AuditAction.KEY_VAULT_WRAP_REMOVE }).toArray();
            expect(entries).toHaveLength(1);
        });

        it("Returns 404 removing a wrap that doesn't match any stored method/methodId.", async () => {
            const mailbox = await createMailbox();
            await enrollFirstKey(mailbox);

            const result = await request(server.getApplication())
                .delete(`${baseUrl}/${mailbox.uid}/keyvault/wraps/recovery`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(404);
        });

        it("Returns 404 removing a wrap from a mailbox with no vault yet.", async () => {
            const mailbox = await createMailbox();
            const result = await request(server.getApplication())
                .delete(`${baseUrl}/${mailbox.uid}/keyvault/wraps/password`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(404);
        });
    });

    describe("PUT /:id/keyvault/rekey", () => {
        const enrollFirstKey = async function (mailbox: MailboxMongo): Promise<void> {
            await request(server.getApplication())
                .post(`${baseUrl}/${mailbox.uid}/keyvault/keys`)
                .set("Authorization", "jwt " + ownerToken)
                .send({
                    useType: "encrypt",
                    csr: await generateTestCsr(mailbox.primarySmtpAddress),
                    wrappedKey: { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" },
                    masterKeyWraps: [
                        { method: "password", ciphertext: "mkct", nonce: "mkn", salt: "salt", kdf: "argon2id", schemeVersion: 1, createdAt: Date.now() },
                    ],
                });
        };

        it("Atomically replaces wrappedKeys/masterKeyWraps and the mailbox's published keys.", async () => {
            const mailbox = await createMailbox();
            await enrollFirstKey(mailbox);

            const newPublicKey = {
                publicKey: "new-b64",
                type: "x509",
                useType: "encrypt" as const,
                fingerprint: "new-fingerprint",
                notBefore: Date.now(),
                notAfter: Date.now() + 1000,
            };
            const result = await request(server.getApplication())
                .put(`${baseUrl}/${mailbox.uid}/keyvault/rekey`)
                .set("Authorization", "jwt " + ownerToken)
                .send({
                    keys: [newPublicKey],
                    wrappedKeys: [{ ciphertext: "new-ct", nonce: "new-n", algorithm: "AES-256-GCM", fingerprint: "new-fingerprint", useType: "encrypt" }],
                    masterKeyWraps: [
                        { method: "recovery", ciphertext: "rc", nonce: "rn", salt: "rs", kdf: "argon2id", schemeVersion: 1, createdAt: Date.now() },
                    ],
                });

            expect(result.status).toBe(200);
            expect(result.body.wrappedKeys).toHaveLength(1);
            expect(result.body.wrappedKeys[0].fingerprint).toBe("new-fingerprint");
            expect(result.body.masterKeyWraps).toHaveLength(1);
            expect(result.body.masterKeyWraps[0].method).toBe("recovery");

            const updatedMailbox = await mailboxRepo.findOne({ uid: mailbox.uid } as any);
            expect(updatedMailbox?.keys).toEqual([newPublicKey]);

            const entries = await auditLogRepo.find({ action: AuditAction.KEY_VAULT_REKEY }).toArray();
            expect(entries).toHaveLength(1);
        });

        it("Returns 404 re-keying a mailbox with no vault yet.", async () => {
            const mailbox = await createMailbox();
            const result = await request(server.getApplication())
                .put(`${baseUrl}/${mailbox.uid}/keyvault/rekey`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ keys: [], wrappedKeys: [], masterKeyWraps: [] });

            expect(result.status).toBe(404);
        });

        it("A different, unrelated user cannot re-key (403).", async () => {
            const mailbox = await createMailbox();
            await enrollFirstKey(mailbox);

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${mailbox.uid}/keyvault/rekey`)
                .set("Authorization", "jwt " + otherUserToken)
                .send({ keys: [], wrappedKeys: [], masterKeyWraps: [] });

            expect(result.status).toBe(403);
        });
    });
});
