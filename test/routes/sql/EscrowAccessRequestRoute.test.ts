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
import { AuditLogEntrySQL } from "../../../src/models/sql/AuditLogEntrySQL.js";
import { EscrowAccessRequestSQL } from "../../../src/models/sql/EscrowAccessRequestSQL.js";
import { EscrowAuditLogEntrySQL } from "../../../src/models/sql/EscrowAuditLogEntrySQL.js";
import { EscrowScopeSQL } from "../../../src/models/sql/EscrowScopeSQL.js";
import { KeyVaultSQL } from "../../../src/models/sql/KeyVaultSQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { MatterSQL } from "../../../src/models/sql/MatterSQL.js";
import { AuditAction, EscrowAuditAction } from "../../../src/models/types.js";
import { registerTestDoubles } from "../../testDoubles.js";

describe("Route:EscrowAccessRequestSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/escrow-access-requests";
    let escrowScopeRepo: Repository<EscrowScopeSQL>;
    let matterRepo: Repository<MatterSQL>;
    let mailboxRepo: Repository<MailboxSQL>;
    let keyVaultRepo: Repository<KeyVaultSQL>;
    let requestRepo: Repository<EscrowAccessRequestSQL>;
    let escrowAuditRepo: Repository<EscrowAuditLogEntrySQL>;
    let auditLogRepo: Repository<AuditLogEntrySQL>;

    const holderA: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const holderAToken = JWTUtils.createTokenSync(config.get("auth"), holderA);
    const holderB: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const holderBToken = JWTUtils.createTokenSync(config.get("auth"), holderB);
    const nonHolder: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const nonHolderToken = JWTUtils.createTokenSync(config.get("auth"), nonHolder);
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

    const validPublicKey = { publicKey: "base64cert", type: "x509", fingerprint: "abc123", notBefore: 1000, notAfter: 2000 };

    const escrowWrap = (scopeId: string) => ({
        method: "escrow" as const,
        escrowScopeId: scopeId,
        ciphertext: "ct",
        nonce: "n",
        salt: "s",
        kdf: "argon2id",
        schemeVersion: 1,
        createdAt: Date.now(),
    });
    const passwordWrap = () => ({
        method: "password" as const,
        ciphertext: "pwct",
        nonce: "pwn",
        salt: "pws",
        kdf: "argon2id",
        schemeVersion: 1,
        createdAt: Date.now(),
    });

    const createEscrowScope = async function (data?: any): Promise<EscrowScopeSQL> {
        return await escrowScopeRepo.save(
            new EscrowScopeSQL({
                name: "legal",
                publicKey: validPublicKey,
                holderUserUids: [holderA.uid],
                requiredHolders: 1,
                notifySubjectOnAccess: false,
                ...data,
            }),
        );
    };

    const createMailbox = async function (data?: any): Promise<MailboxSQL> {
        return await mailboxRepo.save(
            new MailboxSQL({
                primarySmtpAddress: `${uuid.v4()}@example.com`,
                aliasAddresses: [],
                displayName: "Custodian Mailbox",
                timezone: "UTC",
                quotaBytes: 1_000_000_000,
                usedBytes: 0,
                ...data,
            }),
        );
    };

    const createMatter = async function (escrowScopeId: string, custodianMailboxUids: string[], data?: any): Promise<MatterSQL> {
        return await matterRepo.save(
            new MatterSQL({
                name: "Investigation A",
                escrowScopeId,
                custodianMailboxUids,
                dateRangeStart: new Date("2026-01-01"),
                dateRangeEnd: new Date("2026-06-01"),
                ...data,
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
            mailboxRepo = conn.getRepository(MailboxSQL);
            keyVaultRepo = conn.getRepository(KeyVaultSQL);
            requestRepo = conn.getRepository(EscrowAccessRequestSQL);
            escrowAuditRepo = conn.getRepository(EscrowAuditLogEntrySQL);
            auditLogRepo = conn.getRepository(AuditLogEntrySQL);
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await requestRepo.clear();
        await escrowAuditRepo.clear();
        await auditLogRepo.clear();
        await keyVaultRepo.clear();
        await matterRepo.clear();
        await mailboxRepo.clear();
        await escrowScopeRepo.clear();
    });

    describe("create()", () => {
        it("Rejects an unauthenticated caller (403).", async () => {
            const scope = await createEscrowScope();
            const mailbox = await createMailbox({ escrowScopeId: scope.uid });
            const matter = await createMatter(scope.uid, [mailbox.uid]);

            const result = await request(server.getApplication())
                .post(baseUrl)
                .send({ matterId: matter.uid, mailboxUid: mailbox.uid });

            expect(result.status).toBe(403);
        });

        it("Rejects a nonexistent matter (404).", async () => {
            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + holderAToken)
                .send({ matterId: uuid.v4(), mailboxUid: uuid.v4() });

            expect(result.status).toBe(404);
        });

        it("Rejects a request against a closed matter (400).", async () => {
            const scope = await createEscrowScope();
            const mailbox = await createMailbox({ escrowScopeId: scope.uid });
            const matter = await createMatter(scope.uid, [mailbox.uid], { closedAt: new Date() });

            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + holderAToken)
                .send({ matterId: matter.uid, mailboxUid: mailbox.uid });

            expect(result.status).toBe(400);
        });

        it("Rejects a non-holder of the matter's scope (403).", async () => {
            const scope = await createEscrowScope();
            const mailbox = await createMailbox({ escrowScopeId: scope.uid });
            const matter = await createMatter(scope.uid, [mailbox.uid]);

            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + nonHolderToken)
                .send({ matterId: matter.uid, mailboxUid: mailbox.uid });

            expect(result.status).toBe(403);
        });

        it("Rejects an unauthenticated or non-holder caller against a CLOSED matter with the exact same uniform 403 as an open one - never revealing the matter's own open/closed state to someone with no access to it at all (the holder-gate now runs before the closedAt check).", async () => {
            const scope = await createEscrowScope();
            const mailbox = await createMailbox({ escrowScopeId: scope.uid });
            const matter = await createMatter(scope.uid, [mailbox.uid], { closedAt: new Date() });

            const unauthResult = await request(server.getApplication())
                .post(baseUrl)
                .send({ matterId: matter.uid, mailboxUid: mailbox.uid });
            expect(unauthResult.status).toBe(403);
            expect(unauthResult.body.message).toBe("User does not have permission to perform this action.");

            const nonHolderResult = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + nonHolderToken)
                .send({ matterId: matter.uid, mailboxUid: mailbox.uid });
            expect(nonHolderResult.status).toBe(403);
            expect(nonHolderResult.body.message).toBe("User does not have permission to perform this action.");
        });

        it("A trusted admin who is not a holder gets 403 - proves separation of duties.", async () => {
            const scope = await createEscrowScope();
            const mailbox = await createMailbox({ escrowScopeId: scope.uid });
            const matter = await createMatter(scope.uid, [mailbox.uid]);

            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ matterId: matter.uid, mailboxUid: mailbox.uid });

            expect(result.status).toBe(403);
        });

        it("Rejects a mailbox that is not a custodian of the matter (400).", async () => {
            const scope = await createEscrowScope();
            const custodian = await createMailbox({ escrowScopeId: scope.uid });
            const other = await createMailbox({ escrowScopeId: scope.uid });
            const matter = await createMatter(scope.uid, [custodian.uid]);

            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + holderAToken)
                .send({ matterId: matter.uid, mailboxUid: other.uid });

            expect(result.status).toBe(400);
        });

        it("Rejects a nonexistent mailbox (404).", async () => {
            const scope = await createEscrowScope();
            const matter = await createMatter(scope.uid, [uuid.v4()]);
            const missingMailboxUid = matter.custodianMailboxUids[0];

            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + holderAToken)
                .send({ matterId: matter.uid, mailboxUid: missingMailboxUid });

            expect(result.status).toBe(404);
        });

        it("Rejects a custodian mailbox whose current escrowScopeId no longer matches the matter's scope (409).", async () => {
            const scope = await createEscrowScope();
            const otherScope = await createEscrowScope({ name: "other" });
            const mailbox = await createMailbox({ escrowScopeId: otherScope.uid });
            const matter = await createMatter(scope.uid, [mailbox.uid]);

            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + holderAToken)
                .send({ matterId: matter.uid, mailboxUid: mailbox.uid });

            expect(result.status).toBe(409);
        });

        it("requiredHolders:1 - creation alone reaches status 'approved' and material() is immediately readable.", async () => {
            const scope = await createEscrowScope({ requiredHolders: 1, holderUserUids: [holderA.uid] });
            const mailbox = await createMailbox({ escrowScopeId: scope.uid });
            await keyVaultRepo.save(
                new KeyVaultSQL({ mailboxUid: mailbox.uid, wrappedKeys: [], masterKeyWraps: [escrowWrap(scope.uid), passwordWrap()] }),
            );
            const matter = await createMatter(scope.uid, [mailbox.uid]);

            const createResult = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + holderAToken)
                .send({ matterId: matter.uid, mailboxUid: mailbox.uid });
            expect(createResult.status).toBeGreaterThanOrEqual(200);
            expect(createResult.status).toBeLessThan(300);
            expect(createResult.body.status).toBe("approved");
            expect(createResult.body.approvals).toHaveLength(1);
            expect(createResult.body.approvals[0].holderUserUid).toBe(holderA.uid);

            const createdEntries = await escrowAuditRepo.find({ order: { sequence: "ASC" } });
            expect(createdEntries).toHaveLength(1);
            expect(createdEntries[0].action).toBe(EscrowAuditAction.REQUEST_CREATED);
            expect(createdEntries[0].sequence).toBe(0);

            const materialResult = await request(server.getApplication())
                .get(`${baseUrl}/${createResult.body.uid}/material`)
                .set("Authorization", "jwt " + holderAToken);
            expect(materialResult.status).toBe(200);
            expect(materialResult.body.masterKeyWraps).toHaveLength(1);
            expect(materialResult.body.masterKeyWraps[0].method).toBe("escrow");
            expect(materialResult.body.masterKeyWraps[0].escrowScopeId).toBe(scope.uid);

            const afterMaterialEntries = await escrowAuditRepo.find({ order: { sequence: "ASC" } });
            expect(afterMaterialEntries).toHaveLength(2);
            expect(afterMaterialEntries[1].action).toBe(EscrowAuditAction.MATERIAL_READ);
            expect(afterMaterialEntries[1].previousHash).toBe(afterMaterialEntries[0].hash);

            const fulfilled = await requestRepo.findOne({ where: { uid: createResult.body.uid } });
            expect(fulfilled?.status).toBe("fulfilled");
            expect(fulfilled?.fulfilledAt).toBeTruthy();
        });
    });

    describe("requiredHolders:2 dual-control math", () => {
        async function seedScopeMatterMailbox() {
            const scope = await createEscrowScope({ requiredHolders: 2, holderUserUids: [holderA.uid, holderB.uid] });
            const mailbox = await createMailbox({ escrowScopeId: scope.uid });
            await keyVaultRepo.save(
                new KeyVaultSQL({ mailboxUid: mailbox.uid, wrappedKeys: [], masterKeyWraps: [escrowWrap(scope.uid), passwordWrap()] }),
            );
            const matter = await createMatter(scope.uid, [mailbox.uid]);
            return { scope, mailbox, matter };
        }

        it("Stays pending after creation, rejects material() (403), rejects self re-approval (400), rejects a non-holder approve (403), then approves and allows material() once B approves.", async () => {
            const { mailbox, matter } = await seedScopeMatterMailbox();

            const createResult = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + holderAToken)
                .send({ matterId: matter.uid, mailboxUid: mailbox.uid });
            expect(createResult.body.status).toBe("pending");
            expect(createResult.body.approvals).toHaveLength(1);
            const requestId = createResult.body.uid;

            const materialBefore = await request(server.getApplication())
                .get(`${baseUrl}/${requestId}/material`)
                .set("Authorization", "jwt " + holderAToken);
            expect(materialBefore.status).toBe(403);

            const selfApprove = await request(server.getApplication())
                .post(`${baseUrl}/${requestId}/approve`)
                .set("Authorization", "jwt " + holderAToken);
            expect(selfApprove.status).toBe(400);

            const nonHolderApprove = await request(server.getApplication())
                .post(`${baseUrl}/${requestId}/approve`)
                .set("Authorization", "jwt " + nonHolderToken);
            expect(nonHolderApprove.status).toBe(403);

            const approveB = await request(server.getApplication())
                .post(`${baseUrl}/${requestId}/approve`)
                .set("Authorization", "jwt " + holderBToken);
            expect(approveB.status).toBe(200);
            expect(approveB.body.status).toBe("approved");
            expect(approveB.body.approvals).toHaveLength(2);

            const auditEntries = await escrowAuditRepo.find({ order: { sequence: "ASC" } });
            expect(auditEntries.map((e) => e.action)).toEqual([EscrowAuditAction.REQUEST_CREATED, EscrowAuditAction.REQUEST_APPROVED]);
            expect(auditEntries[1].previousHash).toBe(auditEntries[0].hash);

            const materialAsA = await request(server.getApplication())
                .get(`${baseUrl}/${requestId}/material`)
                .set("Authorization", "jwt " + holderAToken);
            expect(materialAsA.status).toBe(200);
            expect(materialAsA.body.masterKeyWraps).toHaveLength(1);
            expect(materialAsA.body.masterKeyWraps[0].method).toBe("escrow");

            const materialAsB = await request(server.getApplication())
                .get(`${baseUrl}/${requestId}/material`)
                .set("Authorization", "jwt " + holderBToken);
            expect(materialAsB.status).toBe(200);

            const afterBothReads = await escrowAuditRepo.find({ where: { action: EscrowAuditAction.MATERIAL_READ } });
            expect(afterBothReads).toHaveLength(2);
        });

        it("Rejects re-approving an already-approved request (409).", async () => {
            const { mailbox, matter } = await seedScopeMatterMailbox();
            const createResult = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + holderAToken)
                .send({ matterId: matter.uid, mailboxUid: mailbox.uid });
            await request(server.getApplication())
                .post(`${baseUrl}/${createResult.body.uid}/approve`)
                .set("Authorization", "jwt " + holderBToken);

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${createResult.body.uid}/approve`)
                .set("Authorization", "jwt " + holderBToken);

            expect(result.status).toBe(409);
        });

        it("Rejects approving a nonexistent request (404).", async () => {
            const result = await request(server.getApplication())
                .post(`${baseUrl}/${uuid.v4()}/approve`)
                .set("Authorization", "jwt " + holderAToken);
            expect(result.status).toBe(404);
        });

        it("requiredHolders:3 - a single approve() still leaves the request pending (below threshold).", async () => {
            const holderC: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
            const holderCToken = JWTUtils.createTokenSync(config.get("auth"), holderC);
            const scope = await createEscrowScope({ requiredHolders: 3, holderUserUids: [holderA.uid, holderB.uid, holderC.uid] });
            const mailbox = await createMailbox({ escrowScopeId: scope.uid });
            const matter = await createMatter(scope.uid, [mailbox.uid]);
            const createResult = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + holderAToken)
                .send({ matterId: matter.uid, mailboxUid: mailbox.uid });

            const approveB = await request(server.getApplication())
                .post(`${baseUrl}/${createResult.body.uid}/approve`)
                .set("Authorization", "jwt " + holderBToken);
            expect(approveB.status).toBe(200);
            expect(approveB.body.status).toBe("pending");
            expect(approveB.body.approvals).toHaveLength(2);

            const approveC = await request(server.getApplication())
                .post(`${baseUrl}/${createResult.body.uid}/approve`)
                .set("Authorization", "jwt " + holderCToken);
            expect(approveC.body.status).toBe("approved");
        });
    });

    describe("Authorization ordering (holder-gate must run before any state check, matching deny()/findById()'s already-correct order in this class)", () => {
        it("approve(): a non-holder/unauthenticated caller against an already-approved (non-pending) request gets the same uniform 403 as a pending one - never revealing the request's own status.", async () => {
            const scope = await createEscrowScope({ requiredHolders: 1, holderUserUids: [holderA.uid] });
            const mailbox = await createMailbox({ escrowScopeId: scope.uid });
            const matter = await createMatter(scope.uid, [mailbox.uid]);
            const createResult = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + holderAToken)
                .send({ matterId: matter.uid, mailboxUid: mailbox.uid });
            expect(createResult.body.status).toBe("approved"); // requiredHolders: 1, so already non-pending

            const unauthResult = await request(server.getApplication()).post(`${baseUrl}/${createResult.body.uid}/approve`);
            expect(unauthResult.status).toBe(403);
            expect(unauthResult.body.message).toBe("User does not have permission to perform this action.");

            const nonHolderResult = await request(server.getApplication())
                .post(`${baseUrl}/${createResult.body.uid}/approve`)
                .set("Authorization", "jwt " + nonHolderToken);
            expect(nonHolderResult.status).toBe(403);
            expect(nonHolderResult.body.message).toBe("User does not have permission to perform this action.");
        });

        it("material(): a non-holder/unauthenticated caller against a not-yet-approved (pending) request gets the same uniform 403 as an approved one - never revealing whether the dual-control threshold has been met.", async () => {
            const scope = await createEscrowScope({ requiredHolders: 2, holderUserUids: [holderA.uid, holderB.uid] });
            const mailbox = await createMailbox({ escrowScopeId: scope.uid });
            const matter = await createMatter(scope.uid, [mailbox.uid]);
            const createResult = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + holderAToken)
                .send({ matterId: matter.uid, mailboxUid: mailbox.uid });
            expect(createResult.body.status).toBe("pending"); // requiredHolders: 2, only 1 approval so far

            const unauthResult = await request(server.getApplication()).get(`${baseUrl}/${createResult.body.uid}/material`);
            expect(unauthResult.status).toBe(403);
            expect(unauthResult.body.message).toBe("User does not have permission to perform this action.");

            const nonHolderResult = await request(server.getApplication())
                .get(`${baseUrl}/${createResult.body.uid}/material`)
                .set("Authorization", "jwt " + nonHolderToken);
            expect(nonHolderResult.status).toBe(403);
            expect(nonHolderResult.body.message).toBe("User does not have permission to perform this action.");
        });
    });

    describe("deny()", () => {
        it("Rejects denying a nonexistent request (404).", async () => {
            const result = await request(server.getApplication())
                .post(`${baseUrl}/${uuid.v4()}/deny`)
                .set("Authorization", "jwt " + holderAToken);
            expect(result.status).toBe(404);
        });

        it("Rejects a non-holder attempting to deny a pending request (403).", async () => {
            const scope = await createEscrowScope();
            const mailbox = await createMailbox({ escrowScopeId: scope.uid });
            const matter = await createMatter(scope.uid, [mailbox.uid]);
            const createResult = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + holderAToken)
                .send({ matterId: matter.uid, mailboxUid: mailbox.uid });

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${createResult.body.uid}/deny`)
                .set("Authorization", "jwt " + nonHolderToken);
            expect(result.status).toBe(403);
        });

        it("A holder can deny a pending request, blocking further approve/material, recorded only in the general audit log.", async () => {
            const scope = await createEscrowScope({ requiredHolders: 2, holderUserUids: [holderA.uid, holderB.uid] });
            const mailbox = await createMailbox({ escrowScopeId: scope.uid });
            const matter = await createMatter(scope.uid, [mailbox.uid]);
            const createResult = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + holderAToken)
                .send({ matterId: matter.uid, mailboxUid: mailbox.uid });

            const denyResult = await request(server.getApplication())
                .post(`${baseUrl}/${createResult.body.uid}/deny`)
                .set("Authorization", "jwt " + holderBToken);
            expect(denyResult.status).toBe(200);
            expect(denyResult.body.status).toBe("denied");
            expect(denyResult.body.deniedByUserUid).toBe(holderB.uid);

            const approveAfterDeny = await request(server.getApplication())
                .post(`${baseUrl}/${createResult.body.uid}/approve`)
                .set("Authorization", "jwt " + holderBToken);
            expect(approveAfterDeny.status).toBe(409);

            const materialAfterDeny = await request(server.getApplication())
                .get(`${baseUrl}/${createResult.body.uid}/material`)
                .set("Authorization", "jwt " + holderAToken);
            expect(materialAfterDeny.status).toBe(403);

            const escrowEntries = await escrowAuditRepo.find();
            expect(escrowEntries).toHaveLength(1); // only REQUEST_CREATED - deny is never hash-chained
            const generalEntries = await auditLogRepo.find({ where: { targetUid: createResult.body.uid } });
            expect(generalEntries.some((e) => e.action === AuditAction.ESCROW_ACCESS_REQUEST_DENIED)).toBe(true);
        });

        it("Rejects denying an already-denied request (409).", async () => {
            const scope = await createEscrowScope({ requiredHolders: 2, holderUserUids: [holderA.uid, holderB.uid] });
            const mailbox = await createMailbox({ escrowScopeId: scope.uid });
            const matter = await createMatter(scope.uid, [mailbox.uid]);

            const createResult = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + holderAToken)
                .send({ matterId: matter.uid, mailboxUid: mailbox.uid });
            await request(server.getApplication())
                .post(`${baseUrl}/${createResult.body.uid}/deny`)
                .set("Authorization", "jwt " + holderAToken);

            const result = await request(server.getApplication())
                .post(`${baseUrl}/${createResult.body.uid}/deny`)
                .set("Authorization", "jwt " + holderAToken);

            expect(result.status).toBe(409);
        });
    });

    describe("material()", () => {
        it("Rejects a nonexistent request (404).", async () => {
            const result = await request(server.getApplication())
                .get(`${baseUrl}/${uuid.v4()}/material`)
                .set("Authorization", "jwt " + holderAToken);
            expect(result.status).toBe(404);
        });

        it("Returns an empty masterKeyWraps array when the mailbox has never enrolled a key (no KeyVault row).", async () => {
            const scope = await createEscrowScope();
            const mailbox = await createMailbox({ escrowScopeId: scope.uid });
            const matter = await createMatter(scope.uid, [mailbox.uid]);
            const createResult = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + holderAToken)
                .send({ matterId: matter.uid, mailboxUid: mailbox.uid });

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${createResult.body.uid}/material`)
                .set("Authorization", "jwt " + holderAToken);
            expect(result.status).toBe(200);
            expect(result.body.masterKeyWraps).toEqual([]);
        });

        it("Rejects a request whose mailbox no longer exists (404).", async () => {
            const scope = await createEscrowScope();
            const mailbox = await createMailbox({ escrowScopeId: scope.uid });
            const matter = await createMatter(scope.uid, [mailbox.uid]);
            const createResult = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + holderAToken)
                .send({ matterId: matter.uid, mailboxUid: mailbox.uid });
            await mailboxRepo.delete({ uid: mailbox.uid });

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${createResult.body.uid}/material`)
                .set("Authorization", "jwt " + holderAToken);
            expect(result.status).toBe(404);
        });
    });

    describe("find()/findById()", () => {
        it("find() returns an empty list when the caller holds a scope but no Matter exists under it yet.", async () => {
            await createEscrowScope();

            const result = await request(server.getApplication()).get(baseUrl).set("Authorization", "jwt " + holderAToken);
            expect(result.status).toBe(200);
            expect(result.body).toEqual([]);
        });

        it("findById() returns the request to a holder of its matter's scope.", async () => {
            const scope = await createEscrowScope();
            const mailbox = await createMailbox({ escrowScopeId: scope.uid });
            const matter = await createMatter(scope.uid, [mailbox.uid]);
            const createResult = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + holderAToken)
                .send({ matterId: matter.uid, mailboxUid: mailbox.uid });

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${createResult.body.uid}`)
                .set("Authorization", "jwt " + holderAToken);
            expect(result.status).toBe(200);
            expect(result.body.uid).toBe(createResult.body.uid);
        });

        it("find() returns only requests under matters whose scope the caller holds.", async () => {
            const scopeA = await createEscrowScope({ holderUserUids: [holderA.uid] });
            const scopeB = await createEscrowScope({ name: "other", holderUserUids: [holderB.uid] });
            const mailboxA = await createMailbox({ escrowScopeId: scopeA.uid });
            const mailboxB = await createMailbox({ escrowScopeId: scopeB.uid });
            const matterA = await createMatter(scopeA.uid, [mailboxA.uid]);
            const matterB = await createMatter(scopeB.uid, [mailboxB.uid]);

            await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + holderAToken)
                .send({ matterId: matterA.uid, mailboxUid: mailboxA.uid });
            await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + holderBToken)
                .send({ matterId: matterB.uid, mailboxUid: mailboxB.uid });

            const result = await request(server.getApplication()).get(baseUrl).set("Authorization", "jwt " + holderAToken);
            expect(result.status).toBe(200);
            expect(result.body).toHaveLength(1);
            expect(result.body[0].matterId).toBe(matterA.uid);
        });

        it("find() returns an empty list for a caller who holds no scope at all.", async () => {
            const scope = await createEscrowScope();
            const mailbox = await createMailbox({ escrowScopeId: scope.uid });
            const matter = await createMatter(scope.uid, [mailbox.uid]);
            await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + holderAToken)
                .send({ matterId: matter.uid, mailboxUid: mailbox.uid });

            const result = await request(server.getApplication()).get(baseUrl).set("Authorization", "jwt " + nonHolderToken);
            expect(result.status).toBe(200);
            expect(result.body).toEqual([]);
        });

        it("findById() 403s a caller who does not hold the request's matter's scope.", async () => {
            const scope = await createEscrowScope();
            const mailbox = await createMailbox({ escrowScopeId: scope.uid });
            const matter = await createMatter(scope.uid, [mailbox.uid]);
            const createResult = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + holderAToken)
                .send({ matterId: matter.uid, mailboxUid: mailbox.uid });

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${createResult.body.uid}`)
                .set("Authorization", "jwt " + nonHolderToken);
            expect(result.status).toBe(403);
        });

        it("findById() 404s a nonexistent request.", async () => {
            const result = await request(server.getApplication())
                .get(`${baseUrl}/${uuid.v4()}`)
                .set("Authorization", "jwt " + holderAToken);
            expect(result.status).toBe(404);
        });
    });

    describe("Matter.delete() guard", () => {
        it("Rejects deleting a matter that an EscrowAccessRequest still references (409).", async () => {
            const scope = await createEscrowScope();
            const mailbox = await createMailbox({ escrowScopeId: scope.uid });
            const matter = await createMatter(scope.uid, [mailbox.uid]);
            await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + holderAToken)
                .send({ matterId: matter.uid, mailboxUid: mailbox.uid });

            const result = await request(server.getApplication())
                .delete(`/sql/matters/${matter.uid}`)
                .set("Authorization", "jwt " + holderAToken);

            expect(result.status).toBe(409);
        });
    });
});
