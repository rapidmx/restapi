///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// A non-trusted caller's direct `POST /mailboxes`, held to the same rules as auto-provisioning - identical on both
// backends. `test/routes/{mongo,sql}/MailboxAutoProvision.test.ts` supply a server with self-service provisioning
// enabled by config, `example.com`/`example.org` verified, and a stubbed auth-server `fetch`.
import { request } from "@rapidrest/service-core/test";
import * as uuid from "uuid";

export interface MailboxSelfServiceCreateSuiteContext {
    app: () => any;
    baseUrl: string;
    userUid: string;
    userToken: string;
    adminToken: string;
    /** Adds the `jwt` cookie `fetchNameAliases()` forwards, alongside the `Authorization` header. */
    withAuth: (req: any, token: string) => any;
    /** Makes auth-server answer with these name aliases. */
    mockAliases: (aliases: string[]) => void;
    /** Saves the mailbox policy with self-service provisioning turned off. */
    disableSelfService: () => Promise<void>;
    mailboxes: () => Promise<any[]>;
    tokenFor: (user: any) => string;
}

export function mailboxSelfServiceCreateSuite(ctx: MailboxSelfServiceCreateSuiteContext): void {
    const post = (token: string, body: unknown) => ctx.withAuth(request(ctx.app()).post(ctx.baseUrl), token).send(body);
    const mailbox = (fields: Record<string, unknown> = {}) => ({
        primarySmtpAddress: "JSteinmetz@Example.com",
        aliasAddresses: [],
        displayName: "Mine",
        timezone: "UTC",
        ...fields,
    });

    describe("self-service POST /", () => {
        it("creates the caller's own mailbox at their own username, with the policy's quota whatever the request says", async () => {
            ctx.mockAliases(["jsteinmetz", "jp"]);
            const result = await post(
                ctx.userToken,
                mailbox({ aliasAddresses: ["JP@example.org"], ownerUserUid: uuid.v4(), quotaBytes: 1e15, usedBytes: 42 }),
            );
            expect(result.status).toBe(200);
            expect(result.body).toEqual(
                expect.objectContaining({
                    uid: "jsteinmetz@example.com",
                    primarySmtpAddress: "jsteinmetz@example.com",
                    aliasAddresses: ["jp@example.org"],
                    ownerUserUid: ctx.userUid,
                    quotaBytes: 5_000_000_000,
                    usedBytes: 0,
                }),
            );
            // Without an alias list at all.
            const bare = await post(ctx.userToken, { primarySmtpAddress: "jp@example.com", displayName: "Bare", timezone: "UTC" });
            expect(bare.status).toBe(200);
        });

        it("refuses an address that isn't one of the caller's usernames on a verified domain, creating nothing", async () => {
            ctx.mockAliases(["jsteinmetz"]);
            for (const fields of [
                { primarySmtpAddress: "someone-else@example.com" },
                { primarySmtpAddress: "jsteinmetz@not-configured.com" },
                { aliasAddresses: ["ceo@example.com"] },
                { aliasAddresses: [42] },
                { primarySmtpAddress: "jsteinmetz@example.com@example.com" },
            ]) {
                const result = await post(ctx.userToken, mailbox(fields));
                expect(result.status).toBe(403);
                expect(result.body.message).toBe("You can only create a mailbox at one of your own usernames on this server's domains.");
            }
            expect(await ctx.mailboxes()).toEqual([]);
            // A missing primary address is still the usual 400.
            expect((await post(ctx.userToken, mailbox({ primarySmtpAddress: undefined }))).status).toBe(400);
        });

        it("refuses when the mailbox policy turns self-service mailboxes off, even though config enables them", async () => {
            ctx.mockAliases(["jsteinmetz"]);
            await ctx.disableSelfService();
            const result = await post(ctx.userToken, mailbox());
            expect(result.status).toBe(403);
            expect(result.body.message).toBe("Creating your own mailbox is not enabled on this server.");
            // A trusted caller isn't bound by the policy, and keeps the quota it asks for.
            const admin = await post(ctx.adminToken, mailbox({ ownerUserUid: ctx.userUid, quotaBytes: 1_000 }));
            expect(admin.status).toBe(200);
            expect(admin.body.quotaBytes).toBe(1_000);
        });

        it("lets the owner add an alias at one of their own usernames (matched case-insensitively), but not someone else's", async () => {
            ctx.mockAliases(["JSteinmetz", "JP"]);
            const created = await post(ctx.userToken, mailbox());
            expect(created.status).toBe(200);
            const put = (body: unknown) => ctx.withAuth(request(ctx.app()).put(`${ctx.baseUrl}/${created.body.uid}`), ctx.userToken).send(body);

            const unowned = await put({ uid: created.body.uid, version: created.body.version, aliasAddresses: ["ceo@example.org"] });
            expect(unowned.status).toBe(403);
            expect(unowned.body.message).toBe("You can only add an alias at one of your own usernames on this server's domains.");

            const own = await put({ uid: created.body.uid, version: created.body.version, aliasAddresses: ["jp@example.org"] });
            expect(own.status).toBe(200);
            expect(own.body.aliasAddresses).toEqual(["jp@example.org"]);
        });

        it("checks a trusted caller's owner uid: a user uid (stored lowercase), their own uid, or none", async () => {
            const upper: string = uuid.v4().toUpperCase();
            const owned = await post(ctx.adminToken, mailbox({ primarySmtpAddress: "a@example.com", ownerUserUid: upper }));
            expect(owned.status).toBe(200);
            expect(owned.body.ownerUserUid).toBe(upper.toLowerCase());
            for (const ownerUserUid of ["dev-user", "admin", ".*", 7]) {
                const result = await post(ctx.adminToken, mailbox({ primarySmtpAddress: "b@example.com", ownerUserUid }));
                expect(result.status).toBe(400);
                expect(result.body.message).toBe("'ownerUserUid' must be a user uid.");
            }
            for (const ownerUserUid of [null, ""]) {
                const shared = await post(ctx.adminToken, mailbox({ primarySmtpAddress: `shared-${uuid.v4()}@example.com`, ownerUserUid }));
                expect(shared.status).toBe(200);
                expect(shared.body.ownerUserUid ?? undefined).toBeUndefined();
            }
            // An administrator whose own uid isn't a UUID (e.g. a development identity) can still own a mailbox.
            const devAdmin: string = ctx.tokenFor({ uid: "dev-admin", roles: ["admin"], elevated: Date.now() });
            const own = await post(devAdmin, mailbox({ primarySmtpAddress: "dev@example.com", ownerUserUid: "dev-admin" }));
            expect(own.status).toBe(200);
            expect(own.body.ownerUserUid).toBe("dev-admin");
        });
    });
}
