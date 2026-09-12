///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { request } from "@rapidrest/service-core/test";
import { Server, ObjectFactory, ConnectionManager, isSqlDataSource } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import { EscrowAuditLogEntrySQL } from "../../../src/models/sql/EscrowAuditLogEntrySQL.js";
import { EscrowScopeSQL } from "../../../src/models/sql/EscrowScopeSQL.js";
import { MatterSQL } from "../../../src/models/sql/MatterSQL.js";
import { EscrowAuditAction } from "../../../src/models/types.js";
import { recordEscrowAuditEntry } from "../../../src/util/EscrowAuditUtils.js";
import { registerTestDoubles } from "../../testDoubles.js";

describe("Route:EscrowAuditLogSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/escrow-audit-log";
    let escrowScopeRepo: Repository<EscrowScopeSQL>;
    let matterRepo: Repository<MatterSQL>;
    let auditRepo: Repository<EscrowAuditLogEntrySQL>;

    const holderA: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const holderAToken = JWTUtils.createTokenSync(config.get("auth"), holderA);
    const holderB: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const holderBToken = JWTUtils.createTokenSync(config.get("auth"), holderB);
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

    const validPublicKey = { publicKey: "base64cert", type: "x509", fingerprint: "abc123", notBefore: 1000, notAfter: 2000 };

    const createEscrowScope = async function (holderUserUids: string[]): Promise<EscrowScopeSQL> {
        return await escrowScopeRepo.save(
            new EscrowScopeSQL({ name: "legal", publicKey: validPublicKey, holderUserUids, requiredHolders: 1 }),
        );
    };

    const createMatter = async function (escrowScopeId: string): Promise<MatterSQL> {
        return await matterRepo.save(
            new MatterSQL({
                name: "Investigation",
                escrowScopeId,
                custodianMailboxUids: [uuid.v4()],
                dateRangeStart: new Date("2026-01-01"),
                dateRangeEnd: new Date("2026-06-01"),
            }),
        );
    };

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("sql");
        if (isSqlDataSource(conn)) {
            escrowScopeRepo = conn.getRepository(EscrowScopeSQL);
            matterRepo = conn.getRepository(MatterSQL);
            auditRepo = conn.getRepository(EscrowAuditLogEntrySQL);
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await auditRepo.clear();
        await matterRepo.clear();
        await escrowScopeRepo.clear();
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

        await recordEscrowAuditEntry(objectFactory, EscrowAuditLogEntrySQL, {
            action: EscrowAuditAction.REQUEST_CREATED,
            holderUserUid: holderA.uid,
            matterId: matterA.uid,
            mailboxUid: uuid.v4(),
            requestId: uuid.v4(),
        });
        await recordEscrowAuditEntry(objectFactory, EscrowAuditLogEntrySQL, {
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
        await recordEscrowAuditEntry(objectFactory, EscrowAuditLogEntrySQL, {
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

        await recordEscrowAuditEntry(objectFactory, EscrowAuditLogEntrySQL, {
            action: EscrowAuditAction.REQUEST_CREATED,
            holderUserUid: holderA.uid,
            matterId: matterA.uid,
            mailboxUid: uuid.v4(),
            requestId: uuid.v4(),
        });
        await recordEscrowAuditEntry(objectFactory, EscrowAuditLogEntrySQL, {
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

    it("A holder gets 403 on GET /verify.", async () => {
        const result = await request(server.getApplication())
            .get(`${baseUrl}/verify`)
            .set("Authorization", "jwt " + holderAToken);

        expect(result.status).toBe(403);
    });

    it("A trusted admin gets {valid:true} on an intact chain and detects tampering after a direct repo mutation.", async () => {
        const scope = await createEscrowScope([holderA.uid]);
        const matter = await createMatter(scope.uid);
        await recordEscrowAuditEntry(objectFactory, EscrowAuditLogEntrySQL, {
            action: EscrowAuditAction.REQUEST_CREATED,
            holderUserUid: holderA.uid,
            matterId: matter.uid,
            mailboxUid: uuid.v4(),
            requestId: uuid.v4(),
        });
        await recordEscrowAuditEntry(objectFactory, EscrowAuditLogEntrySQL, {
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

        const entries = await auditRepo.find({ order: { sequence: "ASC" } });
        await auditRepo.update({ uid: entries[1].uid }, { details: { tampered: true } });

        const tamperedResult = await request(server.getApplication())
            .get(`${baseUrl}/verify`)
            .set("Authorization", "jwt " + adminToken);
        expect(tamperedResult.status).toBe(200);
        expect(tamperedResult.body.valid).toBe(false);
        expect(tamperedResult.body.brokenAtSequence).toBe(entries[1].sequence);
    });
});
