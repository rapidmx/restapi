///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { request } from "@rapidrest/service-core/test";
import { MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { EscrowAuditLogEntryMongo } from "../../../src/models/mongo/EscrowAuditLogEntryMongo.js";
import { EscrowScopeMongo } from "../../../src/models/mongo/EscrowScopeMongo.js";
import { MatterMongo } from "../../../src/models/mongo/MatterMongo.js";
import { EscrowAuditAction } from "../../../src/models/types.js";
import { recordEscrowAuditEntry } from "../../../src/util/EscrowAuditUtils.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:EscrowAuditLogMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/escrow-audit-log";
    let escrowScopeRepo: MongoRepository<EscrowScopeMongo>;
    let matterRepo: MongoRepository<MatterMongo>;
    let auditRepo: MongoRepository<EscrowAuditLogEntryMongo>;

    const holderA: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const holderAToken = JWTUtils.createTokenSync(config.get("auth"), holderA);
    const holderB: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const holderBToken = JWTUtils.createTokenSync(config.get("auth"), holderB);
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

    const validPublicKey = { publicKey: "base64cert", type: "x509", fingerprint: "abc123", notBefore: 1000, notAfter: 2000 };

    const createEscrowScope = async function (holderUserUids: string[]): Promise<EscrowScopeMongo> {
        return await escrowScopeRepo.save(
            new EscrowScopeMongo({ name: "legal", publicKey: validPublicKey, holderUserUids, requiredHolders: 1 }),
        );
    };

    const createMatter = async function (escrowScopeId: string): Promise<MatterMongo> {
        return await matterRepo.save(
            new MatterMongo({
                name: "Investigation",
                escrowScopeId,
                custodianMailboxUids: [uuid.v4()],
                dateRangeStart: new Date("2026-01-01"),
                dateRangeEnd: new Date("2026-06-01"),
            }),
        );
    };

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("mongo");
        if (conn instanceof MongoConnection) {
            escrowScopeRepo = conn.getMongoRepository("EscrowScopeMongo");
            matterRepo = conn.getMongoRepository("MatterMongo");
            auditRepo = conn.getMongoRepository("EscrowAuditLogEntryMongo");
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
        for (const r of [auditRepo, matterRepo, escrowScopeRepo]) {
            try {
                await r.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
    });

    it("Rejects create/update/delete/truncate for every caller, including trusted admin.", async () => {
        const createResult = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({});
        expect(createResult.status).toBe(403);

        const updateResult = await request(server.getApplication())
            .put(`${baseUrl}/${uuid.v4()}`)
            .set("Authorization", "jwt " + adminToken)
            .send({});
        expect(updateResult.status).toBe(403);

        const deleteResult = await request(server.getApplication())
            .delete(`${baseUrl}/${uuid.v4()}`)
            .set("Authorization", "jwt " + adminToken);
        expect(deleteResult.status).toBe(403);

        const truncateResult = await request(server.getApplication())
            .delete(baseUrl)
            .set("Authorization", "jwt " + adminToken);
        expect(truncateResult.status).toBe(403);
    });

    it("A holder of scope A sees only entries for scope A's matters via find().", async () => {
        const scopeA = await createEscrowScope([holderA.uid]);
        const scopeB = await createEscrowScope([holderB.uid]);
        const matterA = await createMatter(scopeA.uid);
        const matterB = await createMatter(scopeB.uid);

        await recordEscrowAuditEntry(objectFactory, EscrowAuditLogEntryMongo, {
            action: EscrowAuditAction.REQUEST_CREATED,
            holderUserUid: holderA.uid,
            matterId: matterA.uid,
            mailboxUid: uuid.v4(),
            requestId: uuid.v4(),
        });
        await recordEscrowAuditEntry(objectFactory, EscrowAuditLogEntryMongo, {
            action: EscrowAuditAction.REQUEST_CREATED,
            holderUserUid: holderB.uid,
            matterId: matterB.uid,
            mailboxUid: uuid.v4(),
            requestId: uuid.v4(),
        });

        const result = await request(server.getApplication()).get(baseUrl).set("Authorization", "jwt " + holderAToken);

        expect(result.status).toBe(200);
        expect(result.body.length).toBe(1);
        expect(result.body[0].matterId).toBe(matterA.uid);
    });

    it("A holder who holds no scope at all sees an empty list.", async () => {
        const scopeA = await createEscrowScope([holderA.uid]);
        const matterA = await createMatter(scopeA.uid);
        await recordEscrowAuditEntry(objectFactory, EscrowAuditLogEntryMongo, {
            action: EscrowAuditAction.REQUEST_CREATED,
            holderUserUid: holderA.uid,
            matterId: matterA.uid,
            mailboxUid: uuid.v4(),
            requestId: uuid.v4(),
        });

        const result = await request(server.getApplication()).get(baseUrl).set("Authorization", "jwt " + holderBToken);

        expect(result.status).toBe(200);
        expect(result.body).toEqual([]);
    });

    it("A trusted admin sees every entry, unfiltered.", async () => {
        const scopeA = await createEscrowScope([holderA.uid]);
        const scopeB = await createEscrowScope([holderB.uid]);
        const matterA = await createMatter(scopeA.uid);
        const matterB = await createMatter(scopeB.uid);

        await recordEscrowAuditEntry(objectFactory, EscrowAuditLogEntryMongo, {
            action: EscrowAuditAction.REQUEST_CREATED,
            holderUserUid: holderA.uid,
            matterId: matterA.uid,
            mailboxUid: uuid.v4(),
            requestId: uuid.v4(),
        });
        await recordEscrowAuditEntry(objectFactory, EscrowAuditLogEntryMongo, {
            action: EscrowAuditAction.REQUEST_CREATED,
            holderUserUid: holderB.uid,
            matterId: matterB.uid,
            mailboxUid: uuid.v4(),
            requestId: uuid.v4(),
        });

        const result = await request(server.getApplication()).get(baseUrl).set("Authorization", "jwt " + adminToken);

        expect(result.status).toBe(200);
        expect(result.body.length).toBe(2);
    });

    it("A holder of scope A sees only scope A's count via count(), a trusted admin sees every entry's count.", async () => {
        const scopeA = await createEscrowScope([holderA.uid]);
        const scopeB = await createEscrowScope([holderB.uid]);
        const matterA = await createMatter(scopeA.uid);
        const matterB = await createMatter(scopeB.uid);

        await recordEscrowAuditEntry(objectFactory, EscrowAuditLogEntryMongo, {
            action: EscrowAuditAction.REQUEST_CREATED,
            holderUserUid: holderA.uid,
            matterId: matterA.uid,
            mailboxUid: uuid.v4(),
            requestId: uuid.v4(),
        });
        await recordEscrowAuditEntry(objectFactory, EscrowAuditLogEntryMongo, {
            action: EscrowAuditAction.REQUEST_CREATED,
            holderUserUid: holderB.uid,
            matterId: matterB.uid,
            mailboxUid: uuid.v4(),
            requestId: uuid.v4(),
        });

        const holderResult = await request(server.getApplication()).head(baseUrl).set("Authorization", "jwt " + holderAToken);
        expect(holderResult.headers["content-length"]).toBe("1");

        const adminResult = await request(server.getApplication()).head(baseUrl).set("Authorization", "jwt " + adminToken);
        expect(adminResult.headers["content-length"]).toBe("2");
    });

    it("A holder who holds no scope at all gets a zero count via count(), without ever calling repoUtils.count().", async () => {
        const scopeA = await createEscrowScope([holderA.uid]);
        const matterA = await createMatter(scopeA.uid);
        await recordEscrowAuditEntry(objectFactory, EscrowAuditLogEntryMongo, {
            action: EscrowAuditAction.REQUEST_CREATED,
            holderUserUid: holderA.uid,
            matterId: matterA.uid,
            mailboxUid: uuid.v4(),
            requestId: uuid.v4(),
        });

        const result = await request(server.getApplication()).head(baseUrl).set("Authorization", "jwt " + holderBToken);

        expect(result.headers["content-length"]).toBe("0");
    });

    it("A holder of scope A can read scope A's entry by id via findById(), but gets 404 for scope B's.", async () => {
        const scopeA = await createEscrowScope([holderA.uid]);
        const scopeB = await createEscrowScope([holderB.uid]);
        const matterA = await createMatter(scopeA.uid);
        const matterB = await createMatter(scopeB.uid);

        const entryA = await recordEscrowAuditEntry(objectFactory, EscrowAuditLogEntryMongo, {
            action: EscrowAuditAction.REQUEST_CREATED,
            holderUserUid: holderA.uid,
            matterId: matterA.uid,
            mailboxUid: uuid.v4(),
            requestId: uuid.v4(),
        });
        const entryB = await recordEscrowAuditEntry(objectFactory, EscrowAuditLogEntryMongo, {
            action: EscrowAuditAction.REQUEST_CREATED,
            holderUserUid: holderB.uid,
            matterId: matterB.uid,
            mailboxUid: uuid.v4(),
            requestId: uuid.v4(),
        });

        const ownResult = await request(server.getApplication())
            .get(`${baseUrl}/${entryA.uid}`)
            .set("Authorization", "jwt " + holderAToken);
        expect(ownResult.status).toBe(200);
        expect(ownResult.body.matterId).toBe(matterA.uid);

        const otherResult = await request(server.getApplication())
            .get(`${baseUrl}/${entryB.uid}`)
            .set("Authorization", "jwt " + holderAToken);
        expect(otherResult.status).toBe(404);

        const adminResult = await request(server.getApplication())
            .get(`${baseUrl}/${entryB.uid}`)
            .set("Authorization", "jwt " + adminToken);
        expect(adminResult.status).toBe(200);
    });

    it("A trusted admin reading a nonexistent escrow audit log entry by id gets 404.", async () => {
        const result = await request(server.getApplication())
            .get(`${baseUrl}/${uuid.v4()}`)
            .set("Authorization", "jwt " + adminToken);

        expect(result.status).toBe(404);
    });

    it("A holder gets 403 on GET /verify.", async () => {
        const result = await request(server.getApplication())
            .get(`${baseUrl}/verify`)
            .set("Authorization", "jwt " + holderAToken);

        expect(result.status).toBe(403);
    });

    it("A trusted admin gets {valid:true} on an intact chain and detects tampering after a direct repo mutation.", async () => {
        const scope = await createEscrowScope([holderA.uid]);
        const matter = await createMatter(scope.uid);
        await recordEscrowAuditEntry(objectFactory, EscrowAuditLogEntryMongo, {
            action: EscrowAuditAction.REQUEST_CREATED,
            holderUserUid: holderA.uid,
            matterId: matter.uid,
            mailboxUid: uuid.v4(),
            requestId: uuid.v4(),
        });
        await recordEscrowAuditEntry(objectFactory, EscrowAuditLogEntryMongo, {
            action: EscrowAuditAction.REQUEST_APPROVED,
            holderUserUid: holderA.uid,
            matterId: matter.uid,
            mailboxUid: uuid.v4(),
            requestId: uuid.v4(),
        });

        const intactResult = await request(server.getApplication())
            .get(`${baseUrl}/verify`)
            .set("Authorization", "jwt " + adminToken);
        expect(intactResult.status).toBe(200);
        expect(intactResult.body).toEqual({ valid: true });

        const entries = await auditRepo.find({}).sort({ sequence: 1 }).toArray();
        await auditRepo.updateOne({ uid: entries[1].uid }, { $set: { details: { tampered: true } } });

        const tamperedResult = await request(server.getApplication())
            .get(`${baseUrl}/verify`)
            .set("Authorization", "jwt " + adminToken);
        expect(tamperedResult.status).toBe(200);
        expect(tamperedResult.body.valid).toBe(false);
        expect(tamperedResult.body.brokenAtSequence).toBe(entries[1].sequence);
    });
});
