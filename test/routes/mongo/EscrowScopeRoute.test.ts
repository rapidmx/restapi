///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { request } from "@rapidrest/service-core/test";
import { MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { AuditLogEntryMongo } from "../../../src/models/mongo/AuditLogEntryMongo.js";
import { EscrowScopeMongo } from "../../../src/models/mongo/EscrowScopeMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { MatterMongo } from "../../../src/models/mongo/MatterMongo.js";
import { AuditAction } from "../../../src/models/types.js";
import { LOOKUP_MAX_ATTEMPTS } from "../../../src/util/PrincipalResolutionUtils.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles } from "../../testDoubles.js";
import { principalResolveEndpointSuite } from "../principalResolveEndpointSuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:EscrowScopeMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/escrow-scopes";
    let repo: MongoRepository<EscrowScopeMongo>;
    let auditLogRepo: MongoRepository<AuditLogEntryMongo>;
    let matterRepo: MongoRepository<MatterMongo>;
    let mailboxRepo: MongoRepository<MailboxMongo>;

    const user: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const userToken = JWTUtils.createTokenSync(config.get("auth"), user);
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

    const validPublicKey = { publicKey: "base64cert", type: "x509", fingerprint: "abc123", notBefore: 1000, notAfter: 2000 };

    const createEscrowScope = async function (data?: any): Promise<EscrowScopeMongo> {
        const obj: EscrowScopeMongo = new EscrowScopeMongo({
            name: "legal",
            publicKey: validPublicKey,
            holderUserUids: [uuid.v4()],
            requiredHolders: 1,
            notifySubjectOnAccess: false,
            ...data,
        });
        return await repo.save(obj);
    };

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("mongo");
        if (conn instanceof MongoConnection) {
            repo = conn.getMongoRepository("EscrowScopeMongo");
            auditLogRepo = conn.getMongoRepository("AuditLogEntryMongo");
            matterRepo = conn.getMongoRepository("MatterMongo");
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
        for (const r of [repo, auditLogRepo, matterRepo, mailboxRepo]) {
            try {
                await r.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
    });

    it("A non-trusted caller cannot create/list/count/read/update/delete escrow scopes (403).", async () => {
        const scope = await createEscrowScope();

        const createResult = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + userToken)
            .send({ name: "legal", publicKey: validPublicKey, holderUserUids: [uuid.v4()], requiredHolders: 1 });
        expect(createResult.status).toBe(403);

        const listResult = await request(server.getApplication()).get(baseUrl).set("Authorization", "jwt " + userToken);
        expect(listResult.status).toBe(403);

        const countResult = await request(server.getApplication()).head(baseUrl).set("Authorization", "jwt " + userToken);
        expect(countResult.status).toBe(403);

        const readResult = await request(server.getApplication())
            .get(`${baseUrl}/${scope.uid}`)
            .set("Authorization", "jwt " + userToken);
        expect(readResult.status).toBe(403);

        const updateResult = await request(server.getApplication())
            .put(`${baseUrl}/${scope.uid}`)
            .set("Authorization", "jwt " + userToken)
            .send({ uid: scope.uid, version: scope.version, name: "renamed" });
        expect(updateResult.status).toBe(403);

        const deleteResult = await request(server.getApplication())
            .delete(`${baseUrl}/${scope.uid}`)
            .set("Authorization", "jwt " + userToken);
        expect(deleteResult.status).toBe(403);
    });

    it("A trusted (admin) caller can create, list, count, read, update, and delete escrow scopes.", async () => {
        const holderUid = uuid.v4();
        const createResult = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ name: "legal", publicKey: validPublicKey, holderUserUids: [holderUid], requiredHolders: 1 });
        expect(createResult.status).toBeGreaterThanOrEqual(200);
        expect(createResult.status).toBeLessThan(300);
        expect(createResult.body.name).toBe("legal");

        const entries = await auditLogRepo.find({ targetUid: createResult.body.uid }).toArray();
        expect(entries.length).toBe(1);
        expect(entries[0].action).toBe(AuditAction.ESCROW_SCOPE_CREATE);

        const listResult = await request(server.getApplication()).get(baseUrl).set("Authorization", "jwt " + adminToken);
        expect(listResult.status).toBe(200);
        expect(listResult.body.length).toBe(1);

        const countResult = await request(server.getApplication()).head(baseUrl).set("Authorization", "jwt " + adminToken);
        expect(countResult.status).toBeGreaterThanOrEqual(200);
        expect(countResult.status).toBeLessThan(300);
        expect(countResult.headers["content-length"]).toBe("1");

        const readResult = await request(server.getApplication())
            .get(`${baseUrl}/${createResult.body.uid}`)
            .set("Authorization", "jwt " + adminToken);
        expect(readResult.status).toBe(200);

        const updateResult = await request(server.getApplication())
            .put(`${baseUrl}/${createResult.body.uid}`)
            .set("Authorization", "jwt " + adminToken)
            .send({ uid: createResult.body.uid, version: createResult.body.version, name: "renamed-legal" });
        expect(updateResult.status).toBe(200);
        expect(updateResult.body.name).toBe("renamed-legal");

        const deleteResult = await request(server.getApplication())
            .delete(`${baseUrl}/${createResult.body.uid}`)
            .set("Authorization", "jwt " + adminToken);
        expect(deleteResult.status).toBeGreaterThanOrEqual(200);
        expect(deleteResult.status).toBeLessThan(300);

        const findByIdAfterDelete = await request(server.getApplication())
            .get(`${baseUrl}/${createResult.body.uid}`)
            .set("Authorization", "jwt " + adminToken);
        expect(findByIdAfterDelete.status).toBe(404);
    });

    it("Rejects requiredHolders of 0 (400).", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ name: "legal", publicKey: validPublicKey, holderUserUids: [uuid.v4()], requiredHolders: 0 });
        expect(result.status).toBe(400);
    });

    it("Rejects requiredHolders greater than holderUserUids.length (400).", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ name: "legal", publicKey: validPublicKey, holderUserUids: [uuid.v4()], requiredHolders: 2 });
        expect(result.status).toBe(400);
    });

    it("Accepts requiredHolders exactly equal to holderUserUids.length.", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ name: "legal", publicKey: validPublicKey, holderUserUids: [uuid.v4(), uuid.v4()], requiredHolders: 2 });
        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
    });

    it("Accepts requiredHolders of 1 with multiple holders (no dual control required).", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ name: "legal", publicKey: validPublicKey, holderUserUids: [uuid.v4(), uuid.v4()], requiredHolders: 1 });
        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
    });

    it("Rejects an empty holderUserUids array (400).", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ name: "legal", publicKey: validPublicKey, holderUserUids: [], requiredHolders: 1 });
        expect(result.status).toBe(400);
    });

    it("Rejects duplicate holderUserUids (400).", async () => {
        const dup = uuid.v4();
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ name: "legal", publicKey: validPublicKey, holderUserUids: [dup, dup], requiredHolders: 1 });
        expect(result.status).toBe(400);
    });

    it("Rejects publicKey.notBefore >= publicKey.notAfter (400).", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({
                name: "legal",
                publicKey: { ...validPublicKey, notBefore: 2000, notAfter: 1000 },
                holderUserUids: [uuid.v4()],
                requiredHolders: 1,
            });
        expect(result.status).toBe(400);
    });

    it("Rejects a missing name (400).", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ name: "", publicKey: validPublicKey, holderUserUids: [uuid.v4()], requiredHolders: 1 });
        expect(result.status).toBe(400);
    });

    it("Rejects an incomplete publicKey (400).", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({
                name: "legal",
                publicKey: { ...validPublicKey, fingerprint: "" },
                holderUserUids: [uuid.v4()],
                requiredHolders: 1,
            });
        expect(result.status).toBe(400);
    });

    it("Re-validates on update, rejecting an update that would push requiredHolders out of bounds (400).", async () => {
        const scope = await createEscrowScope({ holderUserUids: [uuid.v4(), uuid.v4()], requiredHolders: 2 });

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${scope.uid}`)
            .set("Authorization", "jwt " + adminToken)
            .send({ uid: scope.uid, version: scope.version, holderUserUids: [uuid.v4()] });

        expect(result.status).toBe(400);
    });

    it("Writes an AuditLogEntry on update and delete.", async () => {
        const scope = await createEscrowScope();

        const updateResult = await request(server.getApplication())
            .put(`${baseUrl}/${scope.uid}`)
            .set("Authorization", "jwt " + adminToken)
            .send({ uid: scope.uid, version: scope.version, name: "renamed" });
        expect(updateResult.status).toBe(200);

        const deleteResult = await request(server.getApplication())
            .delete(`${baseUrl}/${scope.uid}`)
            .set("Authorization", "jwt " + adminToken);
        expect(deleteResult.status).toBeGreaterThanOrEqual(200);
        expect(deleteResult.status).toBeLessThan(300);

        const entries = await auditLogRepo.find({ targetUid: scope.uid }).toArray();
        expect(entries.map((e) => e.action).sort()).toEqual([AuditAction.ESCROW_SCOPE_DELETE, AuditAction.ESCROW_SCOPE_UPDATE].sort());
    });

    it("Blocks deleting a scope that a Matter still references (409).", async () => {
        const scope = await createEscrowScope();
        await matterRepo.save(
            new MatterMongo({
                name: "Investigation A",
                escrowScopeId: scope.uid,
                custodianMailboxUids: [uuid.v4()],
                dateRangeStart: new Date("2026-01-01"),
                dateRangeEnd: new Date("2026-06-01"),
            }),
        );

        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${scope.uid}`)
            .set("Authorization", "jwt " + adminToken);

        expect(result.status).toBe(409);
    });

    it("Blocks deleting a scope while a mailbox is still assigned to it (409), leaving the assignment in place, until it is unassigned (round 6).", async () => {
        const scope = await createEscrowScope();
        const other = await createEscrowScope({ name: "other" });
        const mailbox = await mailboxRepo.save(
            new MailboxMongo({
                ownerUserUid: uuid.v4(),
                primarySmtpAddress: `${uuid.v4()}@example.com`,
                aliasAddresses: [],
                displayName: "Custodian",
                timezone: "UTC",
                quotaBytes: 1_000_000,
                usedBytes: 0,
                escrowScopeId: scope.uid,
            }),
        );

        const refused = await request(server.getApplication()).delete(`${baseUrl}/${scope.uid}`).set("Authorization", "jwt " + adminToken);
        expect(refused.status).toBe(409);
        expect(refused.body.message).toMatch(/still assigned to 1 mailbox/);
        expect(await repo.findOne({ uid: scope.uid } as any)).toBeTruthy();
        expect((await mailboxRepo.findOne({ uid: mailbox.uid } as any))?.escrowScopeId).toBe(scope.uid);
        expect(await auditLogRepo.find({ targetUid: scope.uid, action: AuditAction.ESCROW_SCOPE_DELETE }).toArray()).toHaveLength(0);

        // A scope no mailbox is assigned to is unaffected by another scope's assignments.
        expect((await request(server.getApplication()).delete(`${baseUrl}/${other.uid}`).set("Authorization", "jwt " + adminToken)).status).toBeLessThan(300);

        await mailboxRepo.updateOne({ uid: mailbox.uid } as any, { $set: { escrowScopeId: null } });
        const deleted = await request(server.getApplication()).delete(`${baseUrl}/${scope.uid}`).set("Authorization", "jwt " + adminToken);
        expect(deleted.status).toBeGreaterThanOrEqual(200);
        expect(deleted.status).toBeLessThan(300);
    });

    it("Allows deleting a scope once its referencing Matter is itself deleted.", async () => {
        const scope = await createEscrowScope();
        const matter = await matterRepo.save(
            new MatterMongo({
                name: "Investigation A",
                escrowScopeId: scope.uid,
                custodianMailboxUids: [uuid.v4()],
                dateRangeStart: new Date("2026-01-01"),
                dateRangeEnd: new Date("2026-06-01"),
            }),
        );
        await matterRepo.deleteOne({ uid: matter.uid });

        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${scope.uid}`)
            .set("Authorization", "jwt " + adminToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
    });

    it("A trusted admin updating a nonexistent escrow scope gets 404.", async () => {
        const result = await request(server.getApplication())
            .put(`${baseUrl}/${uuid.v4()}`)
            .set("Authorization", "jwt " + adminToken)
            .send({ name: "renamed" });

        expect(result.status).toBe(404);
    });

    it("A trusted admin deleting a nonexistent escrow scope gets 404.", async () => {
        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${uuid.v4()}`)
            .set("Authorization", "jwt " + adminToken);

        expect(result.status).toBe(404);
    });

    principalResolveEndpointSuite({
        app: () => server.getApplication(),
        url: `${baseUrl}/resolve-holder`,
        trustedToken: adminToken,
        nonTrustedToken: userToken,
        maxAttempts: LOOKUP_MAX_ATTEMPTS,
        createOwnedMailbox: async () => {
            const ownerUid: string = uuid.v4();
            const alias = `alias_${uuid.v4()}@example.com`;
            const mailbox: MailboxMongo = await mailboxRepo.save(
                new MailboxMongo({
                    ownerUserUid: ownerUid,
                    primarySmtpAddress: `${uuid.v4()}@example.com`,
                    aliasAddresses: [alias],
                    displayName: "Candidate Holder",
                    timezone: "UTC",
                    quotaBytes: 1_000_000_000,
                    usedBytes: 0,
                }),
            );
            return { ownerUid, address: mailbox.primarySmtpAddress, alias, displayName: mailbox.displayName };
        },
        freshTrustedToken: () => JWTUtils.createTokenSync(config.get("auth"), { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() }),
    });
});
