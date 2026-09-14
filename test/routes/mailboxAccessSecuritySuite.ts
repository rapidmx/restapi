///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Who may grant what through the MailboxAccess route, and the email lookup's guards - identical on both backends.
// `test/routes/{mongo,sql}/MailboxAccessRoute.test.ts` each supply a started server and direct database access.
import { request } from "@rapidrest/service-core/test";
import { ACLAction, ACLUtils } from "@rapidrest/service-core";
import { JWTUtils } from "@rapidrest/core";
import * as uuid from "uuid";
import { AuditAction } from "../../src/models/types.js";

export interface MailboxAccessSecuritySuiteContext {
    config: any;
    app: () => any;
    baseUrl: string;
    ownerUid: string;
    ownerToken: string;
    /** Creates a mailbox owned by `ownerUid`, with an ACL granting the owner full access plus `records`. */
    createMailbox: (records?: { userOrRoleId: string; actions: string[] }[], overrides?: Record<string, unknown>) => Promise<{ uid: string; primarySmtpAddress: string }>;
    auditEntries: () => Promise<any[]>;
}

export function mailboxAccessSecuritySuite(ctx: MailboxAccessSecuritySuiteContext): void {
    const delegate: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const target: string = uuid.v4();
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    let delegateToken: string;
    let adminToken: string;

    beforeAll(() => {
        delegateToken = JWTUtils.createTokenSync(ctx.config.get("auth"), delegate);
        adminToken = JWTUtils.createTokenSync(ctx.config.get("auth"), admin);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    const as = (token: string, req: any) => req.set("Authorization", "jwt " + token);
    const access = (mailboxUid: string, member: string = "") => `${ctx.baseUrl}/${mailboxUid}/access${member ? `/${encodeURIComponent(member)}` : ""}`;

    describe("lookup-by-email guards", () => {
        it("requires a signed-in caller", async () => {
            const mailbox = await ctx.createMailbox();
            const result = await request(ctx.app()).get(`${ctx.baseUrl}/lookup-by-email?email=${encodeURIComponent(mailbox.primarySmtpAddress)}`);
            expect(result.status).toBe(401);
        });

        it("refuses anything but one plain address, so search operators can't list the directory", async () => {
            await ctx.createMailbox();
            for (const email of ["like(*)", "like(a*)", "regex(.*)", "in(a@example.com,b@example.com)", "nin(x@example.com)", "eq(a@example.com)", "a b@example.com", "no-at-sign", "a@b@example.com", "@example.com", `${"a".repeat(320)}@example.com`]) {
                const result = await as(ctx.ownerToken, request(ctx.app()).get(`${ctx.baseUrl}/lookup-by-email?email=${encodeURIComponent(email)}`));
                expect(result.status).toBe(400);
            }
            const repeated = await as(ctx.ownerToken, request(ctx.app()).get(`${ctx.baseUrl}/lookup-by-email?email=a@example.com&email=b@example.com`));
            expect(repeated.status).toBe(400);
        });
    });

    describe("who can be granted access", () => {
        it("only grants access to a user uid, never a role, anonymous or a wildcard", async () => {
            const mailbox = await ctx.createMailbox();
            for (const member of ["anonymous", ".*", "*", "admin", "not-a-uuid", `${uuid.v4()}x`]) {
                const result = await as(ctx.ownerToken, request(ctx.app()).put(access(mailbox.uid, member))).send({ role: "viewer" });
                expect(result.status).toBe(400);
                expect(result.body.message).toBe("Access can only be granted to a user.");
            }
        });

        it("refuses to set 'custom', which is display-only", async () => {
            const mailbox = await ctx.createMailbox();
            const result = await as(ctx.ownerToken, request(ctx.app()).put(access(mailbox.uid, target))).send({ role: "custom" });
            expect(result.status).toBe(400);
        });
    });

    describe("escalation", () => {
        const updateOnly = [ACLAction.READ, ACLAction.UPDATE];

        it("lets a delegate with update access manage viewers, but not grant, change or remove full access", async () => {
            const manager: string = uuid.v4();
            const mailbox = await ctx.createMailbox([
                { userOrRoleId: delegate.uid, actions: updateOnly },
                { userOrRoleId: manager, actions: [ACLAction.FULL] },
            ]);
            expect((await as(delegateToken, request(ctx.app()).put(access(mailbox.uid, target))).send({ role: "viewer" })).status).toBe(200);
            expect((await as(delegateToken, request(ctx.app()).delete(access(mailbox.uid, target)))).status).toBe(204);

            expect((await as(delegateToken, request(ctx.app()).put(access(mailbox.uid, target))).send({ role: "manager" })).status).toBe(403);
            expect((await as(delegateToken, request(ctx.app()).put(access(mailbox.uid, manager))).send({ role: "viewer" })).status).toBe(403);
            expect((await as(delegateToken, request(ctx.app()).delete(access(mailbox.uid, manager)))).status).toBe(403);

            expect((await as(ctx.ownerToken, request(ctx.app()).put(access(mailbox.uid, target))).send({ role: "manager" })).status).toBe(200);
        });

        it("refuses a caller changing their own record, unless they're trusted", async () => {
            const mailbox = await ctx.createMailbox([
                { userOrRoleId: delegate.uid, actions: updateOnly },
                { userOrRoleId: admin.uid, actions: [ACLAction.READ] },
            ]);
            const own = await as(delegateToken, request(ctx.app()).put(access(mailbox.uid, delegate.uid))).send({ role: "manager" });
            expect(own.status).toBe(403);
            expect(own.body.message).toBe("You can't change your own access to this mailbox.");
            expect((await as(delegateToken, request(ctx.app()).delete(access(mailbox.uid, delegate.uid)))).status).toBe(403);

            expect((await as(adminToken, request(ctx.app()).put(access(mailbox.uid, admin.uid))).send({ role: "manager" })).status).toBe(200);
            expect((await as(adminToken, request(ctx.app()).delete(access(mailbox.uid, admin.uid)))).status).toBe(204);
        });
    });

    describe("listing", () => {
        it("shows a record granting other actions as 'custom' with its actions, and leaves out records granting nothing", async () => {
            const custom: string = uuid.v4();
            const mailbox = await ctx.createMailbox([
                { userOrRoleId: custom, actions: [ACLAction.READ, ACLAction.UPDATE, ACLAction.DELETE] },
                { userOrRoleId: "anonymous", actions: [] },
            ]);
            const result = await as(ctx.ownerToken, request(ctx.app()).get(access(mailbox.uid)));
            expect(result.status).toBe(200);
            expect(result.body).toEqual([{ userOrRoleId: custom, role: "custom", actions: [ACLAction.READ, ACLAction.UPDATE, ACLAction.DELETE] }]);
        });
    });

    describe("auditing and consistency", () => {
        it("audits every grant, role change and revocation with the previous and new role", async () => {
            const mailbox = await ctx.createMailbox();
            await as(ctx.ownerToken, request(ctx.app()).put(access(mailbox.uid, target))).send({ role: "viewer" });
            await as(ctx.ownerToken, request(ctx.app()).put(access(mailbox.uid, target))).send({ role: "manager" });
            await as(ctx.ownerToken, request(ctx.app()).delete(access(mailbox.uid, target)));
            // Removing someone who isn't a member changes nothing, so audits nothing.
            await as(ctx.ownerToken, request(ctx.app()).delete(access(mailbox.uid, target)));

            const entries = (await ctx.auditEntries()).filter((entry) => entry.mailboxUid === mailbox.uid);
            expect(entries.map((entry) => [entry.action, entry.actorUserUid, entry.targetUid, entry.details])).toEqual([
                [AuditAction.MAILBOX_ACCESS_GRANT, ctx.ownerUid, mailbox.uid, { userOrRoleId: target, role: "viewer" }],
                [AuditAction.MAILBOX_ACCESS_GRANT, ctx.ownerUid, mailbox.uid, { userOrRoleId: target, previousRole: "viewer", role: "manager" }],
                [AuditAction.MAILBOX_ACCESS_REVOKE, ctx.ownerUid, mailbox.uid, { userOrRoleId: target, previousRole: "manager" }],
            ]);
        });

        it("reads the ACL uncached, and reports a concurrent ACL change as 409 rather than 500", async () => {
            const mailbox = await ctx.createMailbox();
            const findACL = vi.spyOn(ACLUtils.prototype, "findACL");
            vi.spyOn(ACLUtils.prototype, "saveACL").mockRejectedValueOnce(
                new Error(`The acl to save must be of the same version. ACL=${mailbox.uid}, Expected=2, Actual=1`),
            );
            const conflict = await as(ctx.ownerToken, request(ctx.app()).put(access(mailbox.uid, target))).send({ role: "viewer" });
            expect(conflict.status).toBe(409);
            // (`findACL()` fills the parent list in as it walks the chain.)
            expect(findACL).toHaveBeenCalledWith(mailbox.uid, expect.any(Array), { skipCache: true });

            vi.spyOn(ACLUtils.prototype, "saveACL").mockRejectedValueOnce(new Error("disk full"));
            expect((await as(ctx.ownerToken, request(ctx.app()).put(access(mailbox.uid, target))).send({ role: "viewer" })).status).toBe(500);
        });
    });
}
