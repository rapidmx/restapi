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

        it("finds a mailbox whose address is stored in mixed case, but not by an address it no longer has", async () => {
            const local: string = `Mixed.Case.${uuid.v4()}`;
            const mixed = await ctx.createMailbox([], { uid: `${local}@example.com`.toLowerCase(), primarySmtpAddress: `${local}@Example.com` });
            const lookup = (email: string) => as(ctx.ownerToken, request(ctx.app()).get(`${ctx.baseUrl}/lookup-by-email?email=${encodeURIComponent(email)}`));
            const found = await lookup(`${local}@example.com`.toLowerCase());
            expect(found.status).toBe(200);
            expect(found.body).toEqual({ userUid: ctx.ownerUid, displayName: "Test Mailbox" });
            expect(mixed.uid).toBe(`${local}@example.com`.toLowerCase());

            // Renamed: the uid keeps the old address, which must no longer resolve; the new address still does.
            const renamed = await ctx.createMailbox([], { uid: `old-${local}@example.com`.toLowerCase(), primarySmtpAddress: `new-${local}@example.com`.toLowerCase(), displayName: "Renamed" });
            expect((await lookup(renamed.uid)).body).toBeNull();
            expect((await lookup(`new-${local}@example.com`)).body).toEqual({ userUid: ctx.ownerUid, displayName: "Renamed" });
            // An alias still resolves through a uid match.
            const aliased = await ctx.createMailbox([], { uid: `alias-${local}@example.com`.toLowerCase(), primarySmtpAddress: `other-${local}@example.com`.toLowerCase(), aliasAddresses: [`Alias-${local}@example.com`], displayName: "Aliased" });
            expect((await lookup(aliased.uid)).body).toEqual({ userUid: ctx.ownerUid, displayName: "Aliased" });
        });

        it("limits each caller to 30 lookups a minute, whatever the deployment's default for signed-in callers", async () => {
            const caller: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
            const token: string = JWTUtils.createTokenSync(ctx.config.get("auth"), caller);
            const statuses: number[] = [];
            for (let i = 0; i < 31; i++) {
                statuses.push((await as(token, request(ctx.app()).get(`${ctx.baseUrl}/lookup-by-email?email=nobody@example.com`))).status);
            }
            expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
            expect(statuses[30]).toBe(429);
        });
    });

    describe("fields only a trusted caller may change", () => {
        const updateOnly = [ACLAction.READ, ACLAction.UPDATE];
        const mailboxUrl = (uid: string, property: string = "") => `${ctx.baseUrl}/${uid}${property ? `/${property}` : ""}`;
        /** A full-object style `PUT`, carrying the mailbox's current optimistic-lock version. */
        const putMailbox = async (token: string, uid: string, body: Record<string, unknown>) => {
            const { version } = (await as(adminToken, request(ctx.app()).get(mailboxUrl(uid)))).body;
            return await as(token, request(ctx.app()).put(mailboxUrl(uid))).send({ uid, version, ...body });
        };

        it("refuses a delegate with update access changing the owner, quota or used bytes, by PUT or property PUT", async () => {
            const mailbox: any = await ctx.createMailbox([{ userOrRoleId: delegate.uid, actions: updateOnly }]);
            for (const body of [{ ownerUserUid: delegate.uid }, { ownerUserUid: null }, { quotaBytes: 1e15 }, { usedBytes: 0.5 }]) {
                const result = await putMailbox(delegateToken, mailbox.uid, body);
                expect(result.status).toBe(403);
                expect(result.body.message).toMatch(/can only be changed by a trusted administrator/);
            }
            expect((await as(delegateToken, request(ctx.app()).put(mailboxUrl(mailbox.uid, "ownerUserUid"))).send(JSON.stringify(delegate.uid)).set("Content-Type", "application/json")).status).toBe(403);

            // Round-tripping the current values is fine (including the owner uid in another case), as is anything else.
            const roundTrip = await putMailbox(delegateToken, mailbox.uid, {
                ownerUserUid: ctx.ownerUid.toUpperCase(),
                quotaBytes: 1_000_000_000,
                usedBytes: 0,
                displayName: "Renamed",
            });
            expect(roundTrip.status).toBe(200);
            expect(roundTrip.body).toEqual(expect.objectContaining({ ownerUserUid: ctx.ownerUid, quotaBytes: 1_000_000_000, displayName: "Renamed" }));
        });

        it("lets a trusted caller change them, requiring a user uid for the owner and storing it lowercase", async () => {
            const mailbox: any = await ctx.createMailbox();
            const newOwner: string = uuid.v4();
            const changed = await putMailbox(adminToken, mailbox.uid, { ownerUserUid: newOwner.toUpperCase(), quotaBytes: 2e10 });
            expect(changed.status).toBe(200);
            expect(changed.body).toEqual(expect.objectContaining({ ownerUserUid: newOwner, quotaBytes: 2e10 }));
            for (const ownerUserUid of ["dev-user", "anonymous", 5]) {
                const result = await putMailbox(adminToken, mailbox.uid, { ownerUserUid });
                expect(result.status).toBe(400);
            }
            const shared = await putMailbox(adminToken, mailbox.uid, { ownerUserUid: null });
            expect(shared.status).toBe(200);
            expect(shared.body.ownerUserUid ?? undefined).toBeUndefined();

            // An owner uid stored before this check existed still round-trips.
            const legacy: any = await ctx.createMailbox([], { ownerUserUid: "dev-user" });
            expect((await putMailbox(adminToken, legacy.uid, { ownerUserUid: "dev-user", displayName: "Kept" })).status).toBe(200);
        });

        it("stores changed addresses lowercase, by PUT or property PUT", async () => {
            const mailbox: any = await ctx.createMailbox();
            // Adding an alias is held to create's rules (see `validateAliasChange()`): an admin here, since the owner has
            // no auth-server usernames in this suite. A non-address entry is refused.
            const invalid = await putMailbox(adminToken, mailbox.uid, { aliasAddresses: ["Alias.One@Example.com", 3] });
            expect(invalid.status).toBe(400);
            const aliases = await putMailbox(adminToken, mailbox.uid, { aliasAddresses: ["Alias.One@Example.com"] });
            expect(aliases.status).toBe(200);
            expect(aliases.body.aliasAddresses).toEqual(["alias.one@example.com"]);
            const property = await as(adminToken, request(ctx.app()).put(mailboxUrl(mailbox.uid, "aliasAddresses"))).send(["Alias.Two@Example.com"]);
            expect(property.status).toBe(200);
            expect(property.body.aliasAddresses).toEqual(["alias.two@example.com"]);
            // Renaming is held to the same rule (see `validateAddressChange()`) - an admin again; the owner below only
            // resends the current address, which isn't a change.
            const renamed = await as(adminToken, request(ctx.app()).put(mailboxUrl(mailbox.uid, "primarySmtpAddress"))).send(`New.${mailbox.primarySmtpAddress.toUpperCase()}`);
            expect(renamed.status).toBe(200);
            expect(renamed.body.primarySmtpAddress).toBe(`new.${mailbox.primarySmtpAddress}`);
            // Resending the current address in another case isn't a change.
            const same = await as(ctx.ownerToken, request(ctx.app()).put(mailboxUrl(mailbox.uid, "primarySmtpAddress"))).send(`NEW.${mailbox.primarySmtpAddress}`);
            expect(same.status).toBe(200);
            const notAddress = await as(ctx.ownerToken, request(ctx.app()).put(mailboxUrl(mailbox.uid, "primarySmtpAddress"))).send([1]);
            expect(notAddress.status).toBe(400);
        });

        it("still answers 404 for a trusted-only field change on a mailbox that doesn't exist", async () => {
            const missing = `${uuid.v4()}@example.com`;
            const result = await as(adminToken, request(ctx.app()).put(mailboxUrl(missing))).send({ uid: missing, version: 0, ownerUserUid: uuid.v4(), quotaBytes: 1 });
            expect(result.status).toBe(404);
        });
    });

    describe("GET /:id/access/me", () => {
        const me = (mailboxUid: string) => `${ctx.baseUrl}/${mailboxUid}/access/me`;
        const none = { canRead: false, canCreate: false, canUpdate: false, canDelete: false, canManage: false };
        const all = { canRead: true, canCreate: true, canUpdate: true, canDelete: true, canManage: true };

        it("reports the caller's effective access from owner, delegate, role, wildcard and trusted-role records", async () => {
            const roleUser: any = { uid: uuid.v4(), roles: ["support"], elevated: Date.now() };
            const stranger: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
            const mailbox = await ctx.createMailbox([
                { userOrRoleId: delegate.uid, actions: [ACLAction.READ, ACLAction.UPDATE] },
                { userOrRoleId: "support", actions: [ACLAction.FULL] },
            ]);
            const get = async (token: string, uid: string = mailbox.uid) => await as(token, request(ctx.app()).get(me(uid)));
            const token = (user: any) => JWTUtils.createTokenSync(ctx.config.get("auth"), user);

            expect((await get(ctx.ownerToken)).body).toEqual(all);
            expect((await get(adminToken)).body).toEqual(all);
            expect((await get(token(roleUser))).body).toEqual(all);
            expect((await get(delegateToken)).body).toEqual({ canRead: true, canCreate: false, canUpdate: true, canDelete: false, canManage: true });
            const denied = await get(token(stranger));
            expect(denied.status).toBe(200);
            expect(denied.body).toEqual(none);

            const open = await ctx.createMailbox([{ userOrRoleId: ".*", actions: [ACLAction.READ] }]);
            expect((await get(token(stranger), open.uid)).body).toEqual({ ...none, canRead: true });
        });

        it("returns 404 for a missing mailbox and 401 without a signed-in caller", async () => {
            expect((await as(ctx.ownerToken, request(ctx.app()).get(me(`${uuid.v4()}@example.com`)))).status).toBe(404);
            const mailbox = await ctx.createMailbox();
            expect((await request(ctx.app()).get(me(mailbox.uid))).status).toBe(401);
        });

        it("reports no access when the mailbox has no ACL", async () => {
            const mailbox = await ctx.createMailbox();
            vi.spyOn(ACLUtils.prototype, "findACL").mockResolvedValue(undefined);
            expect((await as(delegateToken, request(ctx.app()).get(me(mailbox.uid)))).body).toEqual(none);
        });

        it("never treats 'me' as a member id", async () => {
            const mailbox = await ctx.createMailbox();
            const put = await as(ctx.ownerToken, request(ctx.app()).put(access(mailbox.uid, "me"))).send({ role: "viewer" });
            expect(put.status).toBe(400);
            expect(put.body.message).toBe("Access can only be granted to a user.");
            expect((await as(ctx.ownerToken, request(ctx.app()).delete(access(mailbox.uid, "me")))).status).toBe(204);
            expect((await as(ctx.ownerToken, request(ctx.app()).get(access(mailbox.uid)))).body).toEqual([]);
            expect((await as(ctx.ownerToken, request(ctx.app()).get(me(mailbox.uid)))).body).toEqual(all);
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

        it("stores a user uid lowercase, and matches the owner, the caller and existing records whatever their case", async () => {
            const mailbox = await ctx.createMailbox([{ userOrRoleId: delegate.uid, actions: [ACLAction.READ, ACLAction.UPDATE] }]);
            const upper: string = target.toUpperCase();
            const granted = await as(ctx.ownerToken, request(ctx.app()).put(access(mailbox.uid, upper))).send({ role: "viewer" });
            expect(granted.status).toBe(200);
            expect(granted.body).toEqual({ userOrRoleId: target, role: "viewer" });
            expect((await as(ctx.ownerToken, request(ctx.app()).put(access(mailbox.uid, target))).send({ role: "manager" })).status).toBe(200);
            const members = await as(ctx.ownerToken, request(ctx.app()).get(access(mailbox.uid)));
            expect(members.body.filter((member: any) => member.userOrRoleId.toLowerCase() === target)).toEqual([
                { userOrRoleId: target, role: "manager", actions: [ACLAction.FULL] },
            ]);

            expect((await as(ctx.ownerToken, request(ctx.app()).put(access(mailbox.uid, ctx.ownerUid.toUpperCase()))).send({ role: "viewer" })).status).toBe(400);
            expect((await as(delegateToken, request(ctx.app()).put(access(mailbox.uid, delegate.uid.toUpperCase()))).send({ role: "viewer" })).status).toBe(403);
            expect((await as(ctx.ownerToken, request(ctx.app()).delete(access(mailbox.uid, upper)))).status).toBe(204);
            expect((await as(ctx.ownerToken, request(ctx.app()).get(access(mailbox.uid)))).body.map((member: any) => member.userOrRoleId)).toEqual([delegate.uid]);
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

        it("takes full access to add, change or remove a record for someone a role or wildcard record may give full access", async () => {
            for (const grant of ["support", ".*"]) {
                const viewerTarget: string = uuid.v4();
                const mailbox = await ctx.createMailbox([
                    { userOrRoleId: delegate.uid, actions: updateOnly },
                    { userOrRoleId: grant, actions: [ACLAction.FULL] },
                    { userOrRoleId: viewerTarget, actions: [ACLAction.READ] },
                ]);
                // A record of the target's own would override (narrow) that grant, and removing one would restore it.
                expect((await as(delegateToken, request(ctx.app()).put(access(mailbox.uid, target))).send({ role: "viewer" })).status).toBe(403);
                expect((await as(delegateToken, request(ctx.app()).delete(access(mailbox.uid, viewerTarget)))).status).toBe(403);
                expect((await as(ctx.ownerToken, request(ctx.app()).put(access(mailbox.uid, target))).send({ role: "viewer" })).status).toBe(200);
                expect((await as(ctx.ownerToken, request(ctx.app()).delete(access(mailbox.uid, viewerTarget)))).status).toBe(204);
            }
            // A role record that doesn't grant full access, or one for a trusted role, changes nothing.
            const mailbox = await ctx.createMailbox([
                { userOrRoleId: delegate.uid, actions: updateOnly },
                { userOrRoleId: "support", actions: [ACLAction.READ] },
                { userOrRoleId: "admin", actions: [ACLAction.FULL] },
            ]);
            expect((await as(delegateToken, request(ctx.app()).put(access(mailbox.uid, target))).send({ role: "viewer" })).status).toBe(200);
        });

        it("takes full access to add a record for someone a parent ACL gives full access", async () => {
            const mailbox = await ctx.createMailbox([{ userOrRoleId: delegate.uid, actions: updateOnly }]);
            const findACL = ACLUtils.prototype.findACL;
            vi.spyOn(ACLUtils.prototype, "findACL").mockImplementation(async function (this: any, ...args: any[]) {
                const acl: any = await (findACL as any).apply(this, args);
                if (acl?.uid === mailbox.uid) {
                    acl.parent = { uid: "parent", records: [{ userOrRoleId: target, actions: [ACLAction.FULL] }], parent: acl.parent };
                }
                return acl;
            });
            expect((await as(delegateToken, request(ctx.app()).put(access(mailbox.uid, target))).send({ role: "viewer" })).status).toBe(403);
        });

        it("checks permission against the same uncached ACL it saves", async () => {
            const mailbox = await ctx.createMailbox([{ userOrRoleId: delegate.uid, actions: updateOnly }]);
            const hasPermission = vi.spyOn(ACLUtils.prototype, "hasPermission");
            expect((await as(delegateToken, request(ctx.app()).put(access(mailbox.uid, target))).send({ role: "viewer" })).status).toBe(200);
            expect(hasPermission).toHaveBeenCalledWith(expect.objectContaining({ uid: delegate.uid }), expect.objectContaining({ uid: mailbox.uid }), ACLAction.UPDATE);
            expect(hasPermission).not.toHaveBeenCalledWith(expect.anything(), mailbox.uid, expect.anything());
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
