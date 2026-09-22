///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Who a mailbox grant can name. An ACL record matches a token's user uid (or a role of that name) and nothing else, so
// a grant stored against what somebody TYPED - the username `jean-philippe`, say, on the live host's shared `hello@`
// mailbox - never applied to anyone: the mailbox only ever appeared to a token that bypassed ACLs altogether. Sharing
// resolves the principal - a mailbox address, an auth-server username or e-mail alias, or a user uid - to a user uid
// and stores ONLY that; anything that doesn't resolve is 400 `No user found for "<x>".` (`BaseMailboxAccessRoute`).
// Identical on both backends - see `mailAccessMatrixSuite.ts`; the runner points `mail:auth_server_url` at a fake.
import { request } from "@rapidrest/service-core/test";
import * as uuid from "uuid";
import { FolderType } from "../../src/models/types.js";
import type { MailAccessMatrixContext } from "./mailAccessMatrixSuite.js";

/** The host the runners configure as `mail:auth_server_url`; `fetch` to it is answered by the test. */
export const FAKE_AUTH_URL = "http://auth.test.invalid";

/** The runners' `mail:auto_provision:static_aliases`: the caller's own username when there is no identity service. */
export const FAKE_STATIC_ALIAS = "dev-user";

export function mailPrincipalSuite(ctx: MailAccessMatrixContext): void {
    const person = (roles: string[] = []): any => ({ uid: uuid.v4(), roles, scopes: [], elevated: Date.now() });
    const admin = person(["admin"]);
    let grantee: any;
    const url = (path: string) => `${ctx.prefix}${path}`;
    /** As `user`, with the `jwt` cookie the identity service is asked with. */
    const as = (req: any, user: any) => req.set("Authorization", "jwt " + ctx.token(user)).set("Cookie", `jwt=${ctx.token(user)}`);
    const access = (mailboxUid: string, principal: string = "") => url(`/mailboxes/${mailboxUid}/access${principal ? `/${encodeURIComponent(principal)}` : ""}`);

    /** What auth-server holds: alias -> uid. Answers `GET /api/aliases?alias=<x>` and `?userUid=<x>`. */
    let aliases: { alias: string; userUid: string; type?: string; verified?: boolean }[] = [];
    const fetchMock = vi.fn(async (input: any) => {
        const target = new URL(String(input));
        const alias = target.searchParams.get("alias");
        const userUid = target.searchParams.get("userUid");
        const rows = aliases.filter((row) => (alias ? row.alias === alias : row.userUid === userUid)).map((row) => ({ type: "name", verified: true, ...row }));
        return { ok: true, json: async () => rows } as any;
    });
    const realFetch = globalThis.fetch;
    beforeEach(() => {
        grantee = person();
        aliases = [];
        fetchMock.mockClear();
        globalThis.fetch = fetchMock as any;
    });
    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    /** A shared (ownerless) mailbox nobody holds a grant on. */
    const sharedMailbox = async (aclRecords: { userOrRoleId: string; actions: string[] }[] = []): Promise<{ mailbox: any; inbox: any }> => {
        const store = ctx.store();
        const mailbox = await store.save("Mailbox", {
            primarySmtpAddress: `hello-${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Support",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });
        await store.saveAcl(mailbox.uid, "Mailbox", aclRecords);
        const inbox = await store.save("Folder", { mailboxUid: mailbox.uid, name: "Inbox", type: FolderType.INBOX, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 });
        await store.saveAcl(inbox.uid, mailbox.uid, []);
        return { mailbox, inbox };
    };
    /** A user the server knows because they own a mailbox here. */
    const knownUser = async (): Promise<{ user: any; mailbox: any }> => {
        const user = person();
        const mailbox = await ctx.store().save("Mailbox", {
            ownerUserUid: user.uid,
            primarySmtpAddress: `known-${user.uid}@example.com`,
            aliasAddresses: [`alias-${user.uid}@example.com`],
            displayName: "Known Person",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });
        await ctx.store().saveAcl(mailbox.uid, "Mailbox", [{ userOrRoleId: user.uid, actions: ["*"] }]);
        return { user, mailbox };
    };
    const records = async (mailboxUid: string): Promise<{ userOrRoleId: string; actions: string[] }[]> => (await ctx.findAcl(mailboxUid))?.records ?? [];

    describe("Sharing resolves who it grants to, and stores only the user's uid", () => {
        it("Grants by mailbox address (its owner), by another address of it, and by user uid - and the grantee then sees the mailbox with an ordinary, non-elevated token, labelled as shared.", async () => {
            const { mailbox, inbox } = await sharedMailbox();
            const { user, mailbox: theirs } = await knownUser();
            const plain = { ...user, elevated: -1 };

            for (const principal of [theirs.primarySmtpAddress.toUpperCase(), `alias-${user.uid}@example.com`, user.uid, user.uid.toUpperCase()]) {
                expect((await as(request(ctx.app()).put(access(mailbox.uid, principal)), admin).send({ role: "viewer" })).status, principal).toBe(200);
                expect((await records(mailbox.uid)).map((record) => record.userOrRoleId)).toEqual([user.uid]);
            }
            const listed = await as(request(ctx.app()).get(url("/mailboxes")), plain);
            const mine = listed.body.find((row: any) => row.uid === mailbox.uid);
            expect(mine).toMatchObject({ primarySmtpAddress: mailbox.primarySmtpAddress, accessRole: "delegate" });
            expect(listed.body.find((row: any) => row.uid === theirs.uid)).toMatchObject({ accessRole: "owner" });
            expect((await as(request(ctx.app()).get(url(`/folders?mailboxUid=${mailbox.uid}`)), plain)).body.map((f: any) => f.uid)).toContain(inbox.uid);
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it("Grants by an auth-server username or e-mail alias, resolved for an administrator with their own cookie, and stores the uid - never the name.", async () => {
            const { mailbox } = await sharedMailbox();
            aliases = [
                { alias: "jean-philippe", userUid: grantee.uid },
                { alias: "jp@example.org", userUid: grantee.uid, type: "email" },
            ];
            for (const principal of ["jean-philippe", "jp@example.org"]) {
                expect((await as(request(ctx.app()).put(access(mailbox.uid, principal)), admin).send({ role: "manager" })).status, principal).toBe(200);
            }
            expect(await records(mailbox.uid)).toEqual([{ userOrRoleId: grantee.uid, actions: ["*"] }]);
            expect(fetchMock).toHaveBeenCalledWith(`${FAKE_AUTH_URL}/api/aliases?alias=jean-philippe&limit=10`, expect.objectContaining({ headers: { Cookie: expect.stringMatching(/^jwt=/) } }));
            // Ask again with the person's own (non-elevated) token: the mailbox is theirs to see.
            const plain = { ...grantee, elevated: -1 };
            expect((await as(request(ctx.app()).get(url("/mailboxes")), plain)).body.map((row: any) => row.uid)).toEqual([mailbox.uid]);
        });

        it("Lets an administrator with no mailbox add themselves by their uid or their own username - the case that left \`hello@\` without a working grant.", async () => {
            const byUid = await sharedMailbox();
            const byName = await sharedMailbox();
            aliases = [{ alias: "admin-name", userUid: admin.uid }];
            expect((await as(request(ctx.app()).put(access(byUid.mailbox.uid, admin.uid)), admin).send({ role: "manager" })).status).toBe(200);
            expect((await as(request(ctx.app()).put(access(byName.mailbox.uid, "admin-name")), admin).send({ role: "manager" })).status).toBe(200);
            expect(await records(byUid.mailbox.uid)).toEqual([{ userOrRoleId: admin.uid, actions: ["*"] }]);
            expect(await records(byName.mailbox.uid)).toEqual([{ userOrRoleId: admin.uid, actions: ["*"] }]);
            const listed = (await as(request(ctx.app()).get(url("/mailboxes")), { ...admin, elevated: -1 })).body.map((row: any) => row.uid);
            expect(listed.sort()).toEqual([byUid.mailbox.uid, byName.mailbox.uid].sort());
        });

        it("Reads the caller's own configured username (a deployment with no identity service) as the caller, case-insensitively.", async () => {
            const { mailbox } = await sharedMailbox();
            expect((await as(request(ctx.app()).put(access(mailbox.uid, FAKE_STATIC_ALIAS.toUpperCase())), admin).send({ role: "manager" })).status).toBe(200);
            expect(await records(mailbox.uid)).toEqual([{ userOrRoleId: admin.uid, actions: ["*"] }]);
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it("Refuses - and stores nothing - a name that resolves to nobody (400 No user found), an alias of someone else's, an unverified alias, an unknown uid and an ownerless mailbox's address.", async () => {
            const { mailbox } = await sharedMailbox();
            aliases = [{ alias: "unverified-name", userUid: grantee.uid, verified: false }];
            const refused = ["nobody", "unverified-name", uuid.v4(), mailbox.primarySmtpAddress, "someone@example.org", "role-name", " ", "x".repeat(400)];
            for (const principal of refused) {
                const result = await as(request(ctx.app()).put(access(mailbox.uid, principal)), admin).send({ role: "viewer" });
                expect([principal, result.status, result.body.message]).toEqual([principal, 400, `No user found for "${principal}".`]);
            }
            expect(await records(mailbox.uid)).toEqual([]);
        });

        it("Answers a username without a cookie to look it up with (or with no identity service configured for the caller) as unresolvable, and reports an unreachable identity service as 502.", async () => {
            const { mailbox } = await sharedMailbox();
            const noCookie = await request(ctx.app()).put(access(mailbox.uid, "jean-philippe")).set("Authorization", "jwt " + ctx.token(admin)).send({ role: "viewer" });
            expect(noCookie.status).toBe(400);
            expect(fetchMock).not.toHaveBeenCalled();

            fetchMock.mockRejectedValueOnce(new Error("connection refused"));
            const down = await as(request(ctx.app()).put(access(mailbox.uid, "jean-philippe")), admin).send({ role: "viewer" });
            expect(down.status).toBe(502);
            // One that never answers is given up on (aborted) at the configured timeout, and is just as unreachable.
            fetchMock.mockImplementationOnce(((_input: any, init: any) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))))) as any);
            expect((await as(request(ctx.app()).put(access(mailbox.uid, "jean-philippe")), admin).send({ role: "viewer" })).status).toBe(502);
            fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => [] } as any);
            expect((await as(request(ctx.app()).put(access(mailbox.uid, "jean-philippe")), admin).send({ role: "viewer" })).status).toBe(502);
            fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ not: "a list" }) } as any);
            expect((await as(request(ctx.app()).put(access(mailbox.uid, "jean-philippe")), admin).send({ role: "viewer" })).status).toBe(400);
            expect(await records(mailbox.uid)).toEqual([]);
        });

        it("Knows a uid the identity service holds an alias for, when the caller may read it - and revoking removes the mailbox from the grantee again.", async () => {
            const { mailbox } = await sharedMailbox();
            aliases = [{ alias: "someone", userUid: grantee.uid }];
            expect((await as(request(ctx.app()).put(access(mailbox.uid, grantee.uid)), admin).send({ role: "viewer" })).status).toBe(200);
            const plain = { ...grantee, elevated: -1 };
            expect((await as(request(ctx.app()).get(url("/mailboxes")), plain)).body.map((row: any) => row.uid)).toEqual([mailbox.uid]);

            expect((await as(request(ctx.app()).delete(access(mailbox.uid, grantee.uid)), admin)).status).toBe(204);
            expect((await as(request(ctx.app()).get(url("/mailboxes")), plain)).body).toEqual([]);
        });
    });

    describe("Previewing a principal (GET /:id/access/resolve)", () => {
        it("Answers who it is - uid, display name and address when they own a mailbox here - without granting anything.", async () => {
            const { mailbox } = await sharedMailbox();
            const { user, mailbox: theirs } = await knownUser();
            const byAddress = await as(request(ctx.app()).get(`${access(mailbox.uid, "resolve")}?principal=${encodeURIComponent(theirs.primarySmtpAddress)}`), admin);
            expect(byAddress.status).toBe(200);
            expect(byAddress.body).toEqual({ userUid: user.uid, displayName: "Known Person", address: theirs.primarySmtpAddress });
            aliases = [{ alias: "just-a-name", userUid: grantee.uid }];
            const byName = await as(request(ctx.app()).get(`${access(mailbox.uid, "resolve")}?principal=just-a-name`), admin);
            expect(byName.body).toEqual({ userUid: grantee.uid });
            expect(await records(mailbox.uid)).toEqual([]);
        });

        it("Is 404 for nobody, 400 for a blank or repeated principal, and needs the standing to manage the mailbox's members (403).", async () => {
            const { mailbox } = await sharedMailbox();
            const path = access(mailbox.uid, "resolve");
            const nobody = await as(request(ctx.app()).get(`${path}?principal=nobody`), admin);
            expect([nobody.status, nobody.body.message]).toEqual([404, 'No user found for "nobody".']);
            expect((await as(request(ctx.app()).get(`${path}?principal=%20`), admin)).status).toBe(400);
            expect((await as(request(ctx.app()).get(path), admin)).status).toBe(400);
            expect((await as(request(ctx.app()).get(`${path}?principal=a&principal=b`), admin)).status).toBe(400);
            expect((await as(request(ctx.app()).get(`${path}?principal=nobody`), grantee)).status).toBe(403);
        });
    });

    describe("Entries that were never a user uid", () => {
        it("Are flagged as having no effect in the member list, and one 'Replace with a user' (grant the resolved user, revoke the string) leaves only the real grant.", async () => {
            // What the live host's hello@ had: the grant stored against the username.
            const { mailbox } = await sharedMailbox([
                { userOrRoleId: "jean-philippe", actions: ["read", "list", "count", "exists"] },
                { userOrRoleId: grantee.uid, actions: ["read", "list", "count", "exists"] },
                { userOrRoleId: ".*", actions: [] },
            ]);
            const listed = await as(request(ctx.app()).get(access(mailbox.uid)), admin);
            expect(listed.body.map((member: any) => [member.userOrRoleId, !!member.noEffect])).toEqual([
                ["jean-philippe", true],
                [grantee.uid, false],
            ]);
            // The grantee's real token never matched the username record.
            const plainGrantee = { ...grantee, elevated: -1 };
            expect((await as(request(ctx.app()).get(url("/mailboxes")), plainGrantee)).body.map((row: any) => row.uid)).toEqual([mailbox.uid]);

            const owner = person();
            aliases = [{ alias: "jean-philippe", userUid: owner.uid }];
            expect((await as(request(ctx.app()).put(access(mailbox.uid, "jean-philippe")), admin).send({ role: "viewer" })).status).toBe(200);
            expect((await as(request(ctx.app()).delete(access(mailbox.uid, "jean-philippe")), admin)).status).toBe(204);
            const after = await as(request(ctx.app()).get(access(mailbox.uid)), admin);
            expect(after.body.map((member: any) => [member.userOrRoleId, !!member.noEffect])).toEqual([
                [grantee.uid, false],
                [owner.uid, false],
            ]);
            expect((await as(request(ctx.app()).get(url("/mailboxes")), { ...owner, elevated: -1 })).body.map((row: any) => row.uid)).toEqual([mailbox.uid]);
        });
    });
}
