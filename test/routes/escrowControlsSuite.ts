///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Escrow dual control, matter state and holder-scoped list checks - identical on both backends (the `$or` cases
// only ever leaked on SQL, but must hold on both). Run from the SecurityControls test files.
import { request } from "@rapidrest/service-core/test";
import { RepoUtils } from "@rapidrest/service-core";
import * as uuid from "uuid";
import { AuditAction } from "../../src/models/types.js";
import type { EntityStore } from "./entityStore.js";

export interface SecurityControlsSuiteContext {
    app: () => any;
    /** The test server's route prefix, `/sql` or `/mongo`. */
    prefix: string;
    token: (user: any) => string;
    store: () => EntityStore;
}

const HOUR_MS = 60 * 60 * 1000;

export function escrowControlsSuite(ctx: SecurityControlsSuiteContext): void {
    const newUser = (roles: string[] = []): any => ({ uid: uuid.v4(), roles, elevated: Date.now() });
    const as = (user: any) => ({
        get: (path: string) => request(ctx.app()).get(`${ctx.prefix}${path}`).set("Authorization", "jwt " + ctx.token(user)),
        head: (path: string) => request(ctx.app()).head(`${ctx.prefix}${path}`).set("Authorization", "jwt " + ctx.token(user)),
        post: (path: string, body?: any) => request(ctx.app()).post(`${ctx.prefix}${path}`).set("Authorization", "jwt " + ctx.token(user)).send(body),
        put: (path: string, body?: any) => request(ctx.app()).put(`${ctx.prefix}${path}`).set("Authorization", "jwt " + ctx.token(user)).send(body),
        delete: (path: string) => request(ctx.app()).delete(`${ctx.prefix}${path}`).set("Authorization", "jwt " + ctx.token(user)),
    });

    const publicKey = (fingerprint: string = "fp-1") => ({ publicKey: "cert", type: "x509", fingerprint, notBefore: 1000, notAfter: 2000 });
    const createScope = async (data: any) =>
        await ctx.store().save("EscrowScope", { name: "legal", publicKey: publicKey(), requiredHolders: 1, notifySubjectOnAccess: false, ...data });
    const createMailbox = async (data?: any) =>
        await ctx.store().save("Mailbox", {
            ownerUserUid: uuid.v4(),
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Custodian",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
            ...data,
        });
    const createMatter = async (escrowScopeId: string, custodianMailboxUids: string[], data?: any) =>
        await ctx.store().save("Matter", {
            name: "Investigation",
            escrowScopeId,
            custodianMailboxUids,
            dateRangeStart: new Date("2026-01-01T00:00:00.000Z"),
            dateRangeEnd: new Date("2026-06-01T00:00:00.000Z"),
            ...data,
        });
    const createRequest = async (matter: any, mailbox: any, approvals: { holderUserUid: string; approvedAt: Date }[], data?: any) =>
        await ctx.store().save("EscrowAccessRequest", {
            matterId: matter.uid,
            mailboxUid: mailbox.uid,
            requestedByUserUid: approvals[0]?.holderUserUid ?? uuid.v4(),
            approvals,
            requiredHoldersAtCreation: approvals.length || 1,
            status: "approved",
            ...data,
        });
    const escrowWrap = (escrowScopeId: string) => ({
        method: "escrow",
        escrowScopeId,
        ciphertext: "ct",
        nonce: "n",
        salt: "s",
        kdf: "argon2id",
        schemeVersion: 1,
        createdAt: Date.now(),
    });

    /** A two-holder scope, a custodian mailbox assigned to it with an escrow wrap, an open matter, and an access
     * request approved by both holders `approvedHoursAgo` hours ago. */
    const approvedSetup = async (approvedHoursAgo: number = 0) => {
        const holderA = newUser();
        const holderB = newUser();
        const scope = await createScope({ holderUserUids: [holderA.uid, holderB.uid], requiredHolders: 2 });
        const mailbox = await createMailbox({ escrowScopeId: scope.uid });
        await ctx.store().save("KeyVault", { mailboxUid: mailbox.uid, wrappedKeys: [], masterKeyWraps: [escrowWrap(scope.uid)] });
        const matter = await createMatter(scope.uid, [mailbox.uid]);
        const approvedAt = new Date(Date.now() - approvedHoursAgo * HOUR_MS);
        const accessRequest = await createRequest(matter, mailbox, [
            { holderUserUid: holderA.uid, approvedAt },
            { holderUserUid: holderB.uid, approvedAt },
        ]);
        return { holderA, holderB, scope, mailbox, matter, accessRequest };
    };

    beforeEach(async () => {
        await ctx
            .store()
            .clear("EscrowAccessRequest", "EscrowAuditLogEntry", "AuditLogEntry", "KeyVault", "Matter", "MatterExportRequest", "Mailbox", "EscrowScope");
    });

    describe("escrow scope dual control", () => {
        it("refuses an administrator making themselves a holder, on create and update", async () => {
            const adminA = newUser(["admin"]);
            const adminB = newUser(["admin"]);
            const body = { name: "legal", publicKey: publicKey(), holderUserUids: [adminA.uid, uuid.v4()], requiredHolders: 2, notifySubjectOnAccess: false };

            expect((await as(adminA).post("/escrow-scopes", body)).status).toBe(403);
            const created = await as(adminB).post("/escrow-scopes", body);
            expect(created.status).toBe(200);
            const [createAudit] = await ctx.store().find("AuditLogEntry", { action: AuditAction.ESCROW_SCOPE_CREATE });
            expect(createAudit.details.after.holderUserUids).toEqual(body.holderUserUids);
            expect(createAudit.details.after.requiredHolders).toBe(2);

            const other = await createScope({ holderUserUids: [uuid.v4(), uuid.v4()], requiredHolders: 2 });
            const selfAdd = await as(adminA).put(`/escrow-scopes/${other.uid}`, {
                uid: other.uid,
                version: other.version,
                holderUserUids: [...other.holderUserUids, adminA.uid],
            });
            expect(selfAdd.status).toBe(403);
            expect((await ctx.store().find("EscrowScope", { uid: other.uid }))[0].holderUserUids).toEqual(other.holderUserUids);
        });

        it("refuses a holder changing their own scope's holders, required holders or public key", async () => {
            const adminA = newUser(["admin"]);
            const scope = await createScope({ holderUserUids: [adminA.uid, uuid.v4()], requiredHolders: 2 });
            const put = (patch: any) => as(adminA).put(`/escrow-scopes/${scope.uid}`, { uid: scope.uid, version: scope.version, ...patch });

            expect((await put({ requiredHolders: 1 })).status).toBe(403);
            expect((await put({ publicKey: publicKey("fp-2") })).status).toBe(403);
            // Re-sending the unchanged holder list with a harmless edit is fine.
            const renamed = await put({ holderUserUids: scope.holderUserUids, name: "renamed" });
            expect(renamed.status).toBe(200);
            expect(renamed.body.requiredHolders).toBe(2);
        });

        it("refuses loosening or re-keying a scope while an approval under it is still live, and audits changes before/after", async () => {
            const { scope } = await approvedSetup(1);
            const admin = newUser(["admin"]);
            const put = (patch: any) => as(admin).put(`/escrow-scopes/${scope.uid}`, { uid: scope.uid, version: scope.version, ...patch });

            expect((await put({ requiredHolders: 1 })).status).toBe(409);
            expect((await put({ publicKey: publicKey("fp-2") })).status).toBe(409);
            expect((await put({ holderUserUids: [scope.holderUserUids[0], uuid.v4()] })).status).toBe(409);
            expect((await as(admin).put(`/escrow-scopes/${scope.uid}/requiredHolders`).send([1])).status).not.toBe(200);
            expect(
                (await as(admin).put("/escrow-scopes", [{ uid: scope.uid, version: scope.version, requiredHolders: 1 }])).status,
            ).toBe(409);

            const renamed = await put({ name: "renamed" });
            expect(renamed.status).toBe(200);
            const [audit] = await ctx.store().find("AuditLogEntry", { action: AuditAction.ESCROW_SCOPE_UPDATE });
            expect(audit.details.before.name).toBe("legal");
            expect(audit.details.after.name).toBe("renamed");
            expect(audit.details.after.requiredHolders).toBe(2);
            expect((await ctx.store().find("EscrowScope", { uid: scope.uid }))[0].requiredHolders).toBe(2);
        });

        it("allows the same change once every approval under the scope has expired", async () => {
            const { scope } = await approvedSetup(73);
            const admin = newUser(["admin"]);

            const result = await as(admin).put(`/escrow-scopes/${scope.uid}`, { uid: scope.uid, version: scope.version, requiredHolders: 1 });

            expect(result.status).toBe(200);
            expect(result.body.requiredHolders).toBe(1);
        });

        it("routes updateBulk/updateProperty through the same rules, and refuses truncate", async () => {
            const admin = newUser(["admin"]);
            const scope = await createScope({ holderUserUids: [uuid.v4()], requiredHolders: 1 });

            const bulk = await as(admin).put("/escrow-scopes", [{ uid: scope.uid, version: scope.version, holderUserUids: [admin.uid] }]);
            expect(bulk.status).toBe(403);
            const property = await as(admin).put(`/escrow-scopes/${scope.uid}/holderUserUids`, [admin.uid]);
            expect(property.status).toBe(403);
            expect((await ctx.store().find("EscrowScope", { uid: scope.uid }))[0].holderUserUids).toEqual(scope.holderUserUids);

            expect((await as(admin).delete("/escrow-scopes")).status).toBe(403);
            expect(await ctx.store().find("EscrowScope")).toHaveLength(1);
            expect((await as(admin).put(`/escrow-scopes/${scope.uid}/uid`).send("other")).status).toBe(400);
            expect((await as(admin).put(`/escrow-scopes/${uuid.v4()}/name`).send("renamed")).status).toBe(404);
            expect((await as(newUser()).put(`/escrow-scopes/${scope.uid}/name`).send("renamed")).status).toBe(403);
        });

        it("applies a permitted updateBulk to every entry and returns the updated scopes", async () => {
            const admin = newUser(["admin"]);
            const scope1 = await createScope({ name: "one", holderUserUids: [uuid.v4()], requiredHolders: 1 });
            const scope2 = await createScope({ name: "two", holderUserUids: [uuid.v4()], requiredHolders: 1 });

            const bulk = await as(admin).put("/escrow-scopes", [
                { uid: scope1.uid, version: scope1.version, name: "one-renamed" },
                { uid: scope2.uid, version: scope2.version, name: "two-renamed" },
            ]);

            expect(bulk.status).toBe(200);
            expect(bulk.body.map((s: any) => s.name)).toEqual(["one-renamed", "two-renamed"]);
            expect((await ctx.store().find("EscrowScope", { uid: scope2.uid }))[0].name).toBe("two-renamed");
            expect(await ctx.store().find("AuditLogEntry", { action: AuditAction.ESCROW_SCOPE_UPDATE })).toHaveLength(2);
        });
    });

    describe("escrow access material", () => {
        it("releases the escrow wraps for a live approval", async () => {
            const { holderA, accessRequest } = await approvedSetup(1);

            const result = await as(holderA).get(`/escrow-access-requests/${accessRequest.uid}/material`);

            expect(result.status).toBe(200);
            expect(result.body.masterKeyWraps).toHaveLength(1);
        });

        it("refuses once the approval is older than the approval TTL (72h by default)", async () => {
            const { holderA, accessRequest } = await approvedSetup(73);

            const result = await as(holderA).get(`/escrow-access-requests/${accessRequest.uid}/material`);

            expect(result.status).toBe(403);
            expect(await ctx.store().find("EscrowAuditLogEntry")).toHaveLength(0);
        });

        it("doesn't count an approval from a user who is no longer a holder", async () => {
            const { holderA, scope, accessRequest } = await approvedSetup(1);
            await ctx.store().update("EscrowScope", scope.uid, { holderUserUids: [holderA.uid, uuid.v4()] });

            const result = await as(holderA).get(`/escrow-access-requests/${accessRequest.uid}/material`);

            expect(result.status).toBe(403);
        });

        it("refuses for a closed matter, or a mailbox no longer a custodian (409)", async () => {
            const closed = await approvedSetup(1);
            await ctx.store().update("Matter", closed.matter.uid, { closedAt: new Date() });
            expect((await as(closed.holderA).get(`/escrow-access-requests/${closed.accessRequest.uid}/material`)).status).toBe(409);

            const removed = await approvedSetup(1);
            await ctx.store().update("Matter", removed.matter.uid, { custodianMailboxUids: [uuid.v4()] });
            expect((await as(removed.holderA).get(`/escrow-access-requests/${removed.accessRequest.uid}/material`)).status).toBe(409);
        });

        it("refuses approving a request, exporting or searching once its matter is closed (400)", async () => {
            const { holderA, holderB, scope, mailbox } = await approvedSetup(1);
            const matter = await createMatter(scope.uid, [mailbox.uid], { closedAt: new Date() });
            const pending = await createRequest(matter, mailbox, [{ holderUserUid: holderA.uid, approvedAt: new Date() }], {
                requiredHoldersAtCreation: 2,
                status: "pending",
            });

            expect((await as(holderB).post(`/escrow-access-requests/${pending.uid}/approve`)).status).toBe(400);
            expect((await as(holderA).post("/matter-export-requests", { matterId: matter.uid })).status).toBe(400);
            expect(await ctx.store().find("MatterExportRequest")).toHaveLength(0);
            expect((await as(holderA).get(`/matter-search?matterId=${matter.uid}&q=hello`)).status).toBe(400);
        });

        it("retries the whole create when the escrow audit append keeps colliding, leaving exactly one request", async () => {
            const holder = newUser();
            const scope = await createScope({ holderUserUids: [holder.uid], requiredHolders: 1 });
            const mailbox = await createMailbox({ escrowScopeId: scope.uid });
            const matter = await createMatter(scope.uid, [mailbox.uid]);

            // `recordEscrowAuditEntry()` makes 5 attempts of its own - fail every one of the first call's.
            let failures = 5;
            const original = RepoUtils.prototype.create;
            const spy = vi.spyOn(RepoUtils.prototype, "create").mockImplementation(async function (this: any, ...args: any[]) {
                if (String(this.modelClass?.name).startsWith("EscrowAuditLogEntry") && failures > 0) {
                    failures--;
                    throw new Error("duplicate key value violates unique constraint (sequence)");
                }
                return await (original as any).apply(this, args);
            });
            try {
                const result = await as(holder).post("/escrow-access-requests", { matterId: matter.uid, mailboxUid: mailbox.uid });

                expect(result.status).toBe(200);
                expect(failures).toBe(0);
            } finally {
                spy.mockRestore();
            }
            expect(await ctx.store().find("EscrowAccessRequest")).toHaveLength(1);
            expect(await ctx.store().find("EscrowAuditLogEntry")).toHaveLength(1);
        });

        it("gives up after a few whole-request retries, and retries an approval the same way", async () => {
            const holderA = newUser();
            const holderB = newUser();
            const scope = await createScope({ holderUserUids: [holderA.uid, holderB.uid], requiredHolders: 2 });
            const mailbox = await createMailbox({ escrowScopeId: scope.uid });
            const matter = await createMatter(scope.uid, [mailbox.uid]);
            const pending = await createRequest(matter, mailbox, [{ holderUserUid: holderA.uid, approvedAt: new Date() }], {
                requiredHoldersAtCreation: 2,
                status: "pending",
            });

            let failures = 0;
            const original = RepoUtils.prototype.create;
            const spy = vi.spyOn(RepoUtils.prototype, "create").mockImplementation(async function (this: any, ...args: any[]) {
                if (String(this.modelClass?.name).startsWith("EscrowAuditLogEntry") && failures > 0) {
                    failures--;
                    throw new Error("duplicate key value violates unique constraint (sequence)");
                }
                return await (original as any).apply(this, args);
            });
            try {
                failures = 1000;
                expect((await as(holderA).post("/escrow-access-requests", { matterId: matter.uid, mailboxUid: mailbox.uid })).status).toBe(500);

                failures = 5;
                const approved = await as(holderB).post(`/escrow-access-requests/${pending.uid}/approve`);
                expect(approved.status).toBe(200);
                expect(approved.body.status).toBe("approved");
                expect(approved.body.approvals).toHaveLength(2);

                failures = 5;
                expect((await as(holderB).get(`/escrow-access-requests/${pending.uid}/material`)).status).toBe(200);
            } finally {
                spy.mockRestore();
            }
            const stored = (await ctx.store().find("EscrowAccessRequest", { uid: pending.uid }))[0];
            expect(stored.approvals).toHaveLength(2);
            expect(stored.status).toBe("fulfilled");
        });
    });

    describe("holder-scoped lists", () => {
        /** holderA holds scope1 (matter1 + a request); holderB holds scope2 (matter2 + a request). */
        const twoScopes = async () => {
            const holderA = newUser();
            const holderB = newUser();
            const scope1 = await createScope({ holderUserUids: [holderA.uid] });
            const scope2 = await createScope({ holderUserUids: [holderB.uid] });
            const mailbox1 = await createMailbox({ escrowScopeId: scope1.uid });
            const mailbox2 = await createMailbox({ escrowScopeId: scope2.uid });
            const matter1 = await createMatter(scope1.uid, [mailbox1.uid]);
            const matter2 = await createMatter(scope2.uid, [mailbox2.uid]);
            const request1 = await createRequest(matter1, mailbox1, [{ holderUserUid: holderA.uid, approvedAt: new Date() }]);
            const request2 = await createRequest(matter2, mailbox2, [{ holderUserUid: holderB.uid, approvedAt: new Date() }]);
            return { holderA, holderB, scope1, scope2, mailbox1, matter1, matter2, request1, request2 };
        };

        it("never lets a client $or replace the forced holder restriction on matters, access requests or the escrow audit log", async () => {
            const { holderA, scope2, matter1, matter2, request1, request2 } = await twoScopes();
            await ctx.store().save("EscrowAuditLogEntry", {
                sequence: 0,
                hash: "h",
                action: "escrow_access_request.created",
                holderUserUid: uuid.v4(),
                matterId: matter2.uid,
                mailboxUid: uuid.v4(),
                requestId: request2.uid,
                occurredAt: new Date(),
            });

            const matters = await as(holderA).get(`/matters?%24or%5B0%5D%5BescrowScopeId%5D=${scope2.uid}`);
            expect([200, 400]).toContain(matters.status);
            if (matters.status === 200) {
                expect(matters.body.map((m: any) => m.uid)).not.toContain(matter2.uid);
            }
            const matterCount = await as(holderA).head(`/matters?%24or%5B0%5D%5BescrowScopeId%5D=${scope2.uid}&uid=${matter2.uid}`);
            expect(Number(matterCount.headers["content-length"] ?? 0)).toBe(0);

            const requests = await as(holderA).get(`/escrow-access-requests?%24or%5B0%5D%5BmatterId%5D=${matter2.uid}`);
            expect(requests.status).toBe(200);
            expect(requests.body.map((r: any) => r.uid)).toEqual([request1.uid]);

            const entries = await as(holderA).get(`/escrow-audit-log?%24or%5B0%5D%5BmatterId%5D=${matter2.uid}`);
            expect([200, 400]).toContain(entries.status);
            if (entries.status === 200) {
                expect(entries.body.map((e: any) => e.matterId)).not.toContain(matter2.uid);
            }

            // A plain matterId filter narrows within what the holder can see, and never widens it.
            expect((await as(holderA).get(`/escrow-access-requests?matterId=${matter2.uid}`)).body).toEqual([]);
            expect((await as(holderA).get(`/escrow-access-requests?matterId=${matter1.uid}`)).body.map((r: any) => r.uid)).toEqual([request1.uid]);
            expect((await as(holderA).get(`/escrow-audit-log?matterId=${matter2.uid}`)).body).toEqual([]);
        });

        it("still applies a holder's plain field filters (e.g. status, action) within the forced matter restriction", async () => {
            const { holderA, mailbox1, matter1, request1 } = await twoScopes();
            await createRequest(matter1, mailbox1, [], { status: "pending" });
            for (const [sequence, action] of ["escrow_access_request.created", "escrow_access_request.approved"].entries()) {
                await ctx.store().save("EscrowAuditLogEntry", {
                    sequence,
                    hash: `h${sequence}`,
                    action,
                    holderUserUid: holderA.uid,
                    matterId: matter1.uid,
                    mailboxUid: mailbox1.uid,
                    requestId: request1.uid,
                    occurredAt: new Date(),
                });
            }

            const approved = await as(holderA).get("/escrow-access-requests?status=approved");
            expect(approved.status).toBe(200);
            expect(approved.body.map((r: any) => r.uid)).toEqual([request1.uid]);

            const created = await as(holderA).get("/escrow-audit-log?action=escrow_access_request.created");
            expect(created.status).toBe(200);
            expect(created.body.map((e: any) => e.action)).toEqual(["escrow_access_request.created"]);
        });

        it("lists access and export requests newest first, with limit/page and a matterId filter", async () => {
            const { holderA, mailbox1, matter1, scope1 } = await twoScopes();
            await ctx.store().clear("EscrowAccessRequest");
            const otherMatter = await createMatter(scope1.uid, [mailbox1.uid]);
            const base = Date.now() - 10 * HOUR_MS;
            const accessUids: string[] = [];
            const exportUids: string[] = [];
            for (let i = 0; i < 3; i++) {
                const created = new Date(base + i * HOUR_MS);
                accessUids.push(
                    (await createRequest(matter1, mailbox1, [{ holderUserUid: holderA.uid, approvedAt: created }], { dateCreated: created })).uid,
                );
                exportUids.push(
                    (
                        await ctx.store().save("MatterExportRequest", {
                            matterId: matter1.uid,
                            requestedByUserUid: holderA.uid,
                            status: "pending",
                            dateCreated: created,
                        })
                    ).uid,
                );
            }
            await createRequest(otherMatter, mailbox1, [{ holderUserUid: holderA.uid, approvedAt: new Date(base) }], { dateCreated: new Date(base) });
            await ctx.store().save("MatterExportRequest", { matterId: otherMatter.uid, requestedByUserUid: holderA.uid, status: "pending", dateCreated: new Date(base) });

            const newestTwo = await as(holderA).get(`/escrow-access-requests?matterId=${matter1.uid}&limit=2`);
            expect(newestTwo.body.map((r: any) => r.uid)).toEqual([accessUids[2], accessUids[1]]);
            const secondPage = await as(holderA).get(`/escrow-access-requests?matterId=${matter1.uid}&limit=2&page=1`);
            expect(secondPage.body.map((r: any) => r.uid)).toEqual([accessUids[0]]);
            expect((await as(holderA).get("/escrow-access-requests")).body).toHaveLength(4);

            const exports = await as(holderA).get(`/matter-export-requests?matterId=${matter1.uid}&limit=2`);
            expect(exports.body.map((r: any) => r.uid)).toEqual([exportUids[2], exportUids[1]]);
            expect((await as(holderA).get(`/matter-export-requests?matterId=${matter1.uid}&page=1&limit=2`)).body.map((r: any) => r.uid)).toEqual([
                exportUids[0],
            ]);
            expect((await as(holderA).get("/matter-export-requests")).body).toHaveLength(4);
            expect((await as(holderA).get(`/matter-export-requests?matterId=${uuid.v4()}`)).body).toEqual([]);

            for (const query of ["limit=0", "limit=abc", "page=-1", "page=1.5"]) {
                expect((await as(holderA).get(`/escrow-access-requests?${query}`)).status).toBe(400);
                expect((await as(holderA).get(`/matter-export-requests?${query}`)).status).toBe(400);
            }
        });
    });

    describe("round 4", () => {
        const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

        it("never takes a client uid (or _id/version) for a new escrow scope or matter", async () => {
            const admin = newUser(["admin"]);
            const holder = newUser();
            const scopeResult = await as(admin).post("/escrow-scopes", {
                uid: "chosen,scope",
                _id: "0123456789abcdef01234567",
                version: 7,
                name: "legal",
                publicKey: publicKey(),
                holderUserUids: [holder.uid],
                requiredHolders: 1,
                notifySubjectOnAccess: false,
            });
            expect(scopeResult.status).toBe(200);
            expect(scopeResult.body.uid).toMatch(UUID);
            expect(scopeResult.body.version).toBe(0);

            const matterResult = await as(holder).post("/matters", {
                uid: "chosen,matter",
                name: "Investigation",
                escrowScopeId: scopeResult.body.uid,
                custodianMailboxUids: [uuid.v4()],
            });
            expect(matterResult.status).toBe(200);
            expect(matterResult.body.uid).toMatch(UUID);
            expect(await ctx.store().find("Matter", { uid: "chosen,matter" })).toHaveLength(0);
        });

        it("never widens a holder's lists or a matter truncate through a (legacy) uid containing a comma", async () => {
            const victim = newUser();
            const attacker = newUser();
            const victimScope = await createScope({ holderUserUids: [victim.uid] });
            const victimMailbox = await createMailbox({ escrowScopeId: victimScope.uid });
            const victimMatter = await createMatter(victimScope.uid, [victimMailbox.uid]);
            const victimRequest = await createRequest(victimMatter, victimMailbox, [{ holderUserUid: victim.uid, approvedAt: new Date() }]);
            await ctx.store().save("MatterExportRequest", { matterId: victimMatter.uid, requestedByUserUid: victim.uid, status: "pending" });

            // Rows written before uids were server-minted: a scope and a matter whose uids smuggle the victim's in.
            const legacyScope = await createScope({ uid: `x,${victimScope.uid}`, holderUserUids: [attacker.uid] });
            expect(legacyScope.uid).toContain(",");
            const attackerScope = await createScope({ holderUserUids: [attacker.uid] });
            await createMatter(attackerScope.uid, [uuid.v4()], { uid: `y,${victimMatter.uid}` });

            const matters = await as(attacker).get("/matters");
            expect(matters.status).toBe(200);
            expect(matters.body.map((m: any) => m.uid)).not.toContain(victimMatter.uid);
            expect((await as(attacker).get("/escrow-access-requests")).body.map((r: any) => r.uid)).not.toContain(victimRequest.uid);
            expect((await as(attacker).get("/matter-export-requests")).body).toEqual([]);

            expect((await as(attacker).delete("/matters")).status).toBeLessThan(300);
            expect(await ctx.store().find("Matter", { uid: victimMatter.uid })).toHaveLength(1);
            expect(await ctx.store().find("Matter", { uid: `y,${victimMatter.uid}` })).toHaveLength(0);
        });

        it("treats a round-tripped public key (ISO dates, revokedAt: null, other key order) as unchanged, but a different key as a change", async () => {
            const { scope } = await approvedSetup(1);
            const admin = newUser(["admin"]);
            const stored = (await ctx.store().find("EscrowScope", { uid: scope.uid }))[0];
            const roundTripped = {
                revokedAt: null,
                notAfter: new Date(stored.publicKey.notAfter).toISOString(),
                notBefore: new Date(stored.publicKey.notBefore).toISOString(),
                fingerprint: stored.publicKey.fingerprint.toUpperCase(),
                type: stored.publicKey.type,
                publicKey: stored.publicKey.publicKey,
            };

            const renamed = await as(admin).put(`/escrow-scopes/${scope.uid}`, { uid: scope.uid, version: stored.version, name: "renamed", publicKey: roundTripped });
            expect(renamed.status).toBe(200);
            const after = (await ctx.store().find("EscrowScope", { uid: scope.uid }))[0];
            expect(after.name).toBe("renamed");
            // The stored key is kept as it was, not replaced by the reformatted copy.
            expect(after.publicKey.notBefore).toBe(stored.publicKey.notBefore);

            // Same fingerprint but different key material, or a different validity window: real changes, refused while
            // the approval is live.
            for (const changed of [{ publicKey: "other-cert" }, { notAfter: stored.publicKey.notAfter + 5000 }]) {
                const result = await as(admin).put(`/escrow-scopes/${scope.uid}`, {
                    uid: scope.uid,
                    version: after.version,
                    publicKey: { ...stored.publicKey, ...changed },
                });
                expect(result.status).toBe(409);
            }
        });

        it("refuses downloading an export of a closed matter (409)", async () => {
            const holder = newUser();
            const scope = await createScope({ holderUserUids: [holder.uid] });
            const matter = await createMatter(scope.uid, [uuid.v4()], { closedAt: new Date() });
            const exportRequest = await ctx.store().save("MatterExportRequest", {
                matterId: matter.uid,
                requestedByUserUid: holder.uid,
                status: "ready",
                blobKey: `matter-export/${uuid.v4()}`,
            });

            const result = await as(holder).get(`/matter-export-requests/${exportRequest.uid}/download`);

            expect(result.status).toBe(409);
        });

        it("refuses dotted or $ keys on matter, escrow scope and domain updates (400), changing nothing", async () => {
            const admin = newUser(["admin"]);
            const holder = newUser();
            const scope = await createScope({ holderUserUids: [holder.uid, uuid.v4()], requiredHolders: 2 });
            const matter = await createMatter(scope.uid, [uuid.v4()]);
            const domainName = `${uuid.v4()}.example.org`;
            const domain = await ctx.store().save("Domain", { uid: domainName, name: domainName, enabled: true, verified: false, verificationToken: "t" });

            for (const body of [{ "custodianMailboxUids.0": "someone-else" }, { $set: { closedAt: new Date() } }]) {
                expect((await as(holder).put(`/matters/${matter.uid}`, { uid: matter.uid, version: matter.version, ...body })).status).toBe(400);
            }
            expect((await as(holder).put("/matters", [{ uid: matter.uid, version: matter.version, "name.x": "y" }])).status).toBe(400);
            expect((await as(holder).put(`/matters/${matter.uid}/custodianMailboxUids.0`).send(["x"])).status).toBe(400);
            expect((await ctx.store().find("Matter", { uid: matter.uid }))[0].custodianMailboxUids).toEqual(matter.custodianMailboxUids);

            expect((await as(admin).put(`/escrow-scopes/${scope.uid}`, { uid: scope.uid, version: scope.version, "holderUserUids.0": admin.uid })).status).toBe(400);
            expect((await as(admin).put("/escrow-scopes", [{ uid: scope.uid, version: scope.version, "requiredHolders.x": 1 }])).status).toBe(400);
            expect((await as(admin).put(`/escrow-scopes/${scope.uid}/holderUserUids.0`).send([admin.uid])).status).toBe(400);
            expect((await ctx.store().find("EscrowScope", { uid: scope.uid }))[0].holderUserUids).toEqual(scope.holderUserUids);

            expect((await as(admin).put(`/domains/${domain.uid}`, { uid: domain.uid, version: domain.version, "verified.x": true })).status).toBe(400);
            expect((await as(admin).put("/domains", [{ uid: domain.uid, version: domain.version, $inc: { version: 1 } }])).status).toBe(400);
            expect((await as(admin).put(`/domains/${domain.uid}/dkim.selector`).send("x")).status).toBe(400);
            expect((await ctx.store().find("Domain", { uid: domain.uid }))[0].verified).toBe(false);
        });

        it("refuses malformed body shapes on matter, escrow scope and domain writes (400), changing nothing", async () => {
            const admin = newUser(["admin"]);
            const holder = newUser();
            const scope = await createScope({ holderUserUids: [holder.uid, uuid.v4()], requiredHolders: 2 });
            const matter = await createMatter(scope.uid, [uuid.v4()]);
            const domainName = `${uuid.v4()}.example.org`;
            const domain = await ctx.store().save("Domain", { uid: domainName, name: domainName, enabled: true, verified: false, verificationToken: "t" });
            const scopesBefore: number = (await ctx.store().find("EscrowScope", {})).length;
            const mattersBefore: number = (await ctx.store().find("Matter", {})).length;

            // A nested array / an empty array body passes the generic per-element validation (it has no elements to
            // validate), so the route's own shape checks are what refuse it.
            expect((await as(admin).post("/escrow-scopes", [[]])).status).toBe(400);
            expect((await as(admin).put(`/escrow-scopes/${scope.uid}`, [])).status).toBe(400);
            expect((await as(holder).post("/matters", [[]])).status).toBe(400);
            expect((await as(holder).put(`/matters/${matter.uid}`, [])).status).toBe(400);
            expect((await as(admin).put(`/domains/${domain.uid}`, [])).status).toBe(400);

            expect((await ctx.store().find("EscrowScope", {})).length).toBe(scopesBefore);
            expect((await ctx.store().find("Matter", {})).length).toBe(mattersBefore);
            const [storedScope] = await ctx.store().find("EscrowScope", { uid: scope.uid });
            expect(storedScope.version).toBe(scope.version);
            const [storedMatter] = await ctx.store().find("Matter", { uid: matter.uid });
            expect(storedMatter.version).toBe(matter.version);
            const [storedDomain] = await ctx.store().find("Domain", { uid: domain.uid });
            expect(storedDomain.version).toBe(domain.version);
        });
    });
}
