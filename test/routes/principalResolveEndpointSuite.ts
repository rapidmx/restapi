///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// A trusted-role-gated `resolve`-shaped endpoint built on `util/PrincipalResolutionUtils.ts` shares this exact
// contract wherever it's mounted (`BaseMailboxRoute.resolveOwner()`, `BaseEscrowScopeRoute.resolveHolder()`) - a
// shared suite here, invoked from each mount point's own `test/routes/{mongo,sql}/*.test.ts`, mirrors
// `mailboxAccessSecuritySuite.ts`'s own "one suite, several call sites" convention rather than duplicating these
// checks (permission, exact-match, enumeration-resistance, rate limiting) at every mount point.
import { request } from "@rapidrest/service-core/test";
import * as uuid from "uuid";

export interface PrincipalResolveEndpointSuiteContext {
    app: () => any;
    /** The full resolve endpoint path, e.g. `/mongo/mailboxes/resolve-owner` or `/mongo/escrow-scopes/resolve-holder`. */
    url: string;
    /** A trusted-role token, sufficient to call the endpoint. */
    trustedToken: string;
    /** A signed-in, non-trusted token - refused (403), same as an anonymous caller. */
    nonTrustedToken: string;
    /** How many requests the endpoint allows one caller per its rate-limit window (`LOOKUP_MAX_ATTEMPTS`). */
    maxAttempts: number;
    /** Creates a mailbox owned by a fresh random uid, with one alias address, returning that uid, its primary
     * address, an alias address and display name - "a known user" throughout this suite. */
    createOwnedMailbox: () => Promise<{ ownerUid: string; address: string; alias: string; displayName: string }>;
    /** A brand-new trusted-role token, minted fresh so the rate-limit test's count starts at zero. */
    freshTrustedToken: () => string;
}

export function principalResolveEndpointSuite(ctx: PrincipalResolveEndpointSuiteContext): void {
    const resolve = (token: string | undefined, principal: string) => {
        const req = request(ctx.app()).get(`${ctx.url}?principal=${encodeURIComponent(principal)}`);
        return token ? req.set("Authorization", "jwt " + token) : req;
    };

    describe(`resolve (${ctx.url})`, () => {
        it("refuses an anonymous caller", async () => {
            const result = await resolve(undefined, "x");
            expect(result.status).toBe(403);
        });

        it("refuses a signed-in, non-trusted caller", async () => {
            const result = await resolve(ctx.nonTrustedToken, "x");
            expect(result.status).toBe(403);
        });

        it("resolves a known user by uid (any case) or by the address of a mailbox they own (any case) - exact match", async () => {
            const { ownerUid, address, displayName } = await ctx.createOwnedMailbox();

            const byUid = await resolve(ctx.trustedToken, ownerUid.toUpperCase());
            expect(byUid.status).toBe(200);
            expect(byUid.body).toEqual({ userUid: ownerUid, displayName, address });

            const byAddress = await resolve(ctx.trustedToken, address.toUpperCase());
            expect(byAddress.status).toBe(200);
            expect(byAddress.body).toEqual({ userUid: ownerUid, displayName, address });
        });

        it("resolves a known user by an alias address of a mailbox they own (any case) - exact match", async () => {
            const { ownerUid, address, alias, displayName } = await ctx.createOwnedMailbox();

            const byAlias = await resolve(ctx.trustedToken, alias.toUpperCase());
            expect(byAlias.status).toBe(200);
            expect(byAlias.body).toEqual({ userUid: ownerUid, displayName, address });
        });

        it("404s for nobody, and never fuzzy/partially matches (enumeration-resistant)", async () => {
            const { address } = await ctx.createOwnedMailbox();
            const missingUid: string = uuid.v4();

            const missing = await resolve(ctx.trustedToken, missingUid);
            expect(missing.status).toBe(404);
            expect(missing.body.message).toBe(`No user found for "${missingUid}".`);

            // A partial address (just the local part) must never fuzzy-match the mailbox created above.
            const partial = await resolve(ctx.trustedToken, address.split("@")[0]);
            expect(partial.status).toBe(404);

            // A role name, a wildcard and "anonymous" all name nobody either.
            for (const nonPerson of ["admin", ".*", "*", "anonymous"]) {
                const result = await resolve(ctx.trustedToken, nonPerson);
                expect(result.status).toBe(404);
            }
        });

        it("400s for a missing, blank or too-long 'principal'", async () => {
            const missing = await request(ctx.app()).get(ctx.url).set("Authorization", "jwt " + ctx.trustedToken);
            expect(missing.status).toBe(400);

            const blank = await resolve(ctx.trustedToken, "   ");
            expect(blank.status).toBe(400);

            const long = await resolve(ctx.trustedToken, `${"a".repeat(310)}@example.com`);
            expect(long.status).toBe(400);
        });

        it(`limits each caller to ${ctx.maxAttempts} lookups a minute`, async () => {
            const token: string = ctx.freshTrustedToken();
            const statuses: number[] = [];
            for (let i = 0; i <= ctx.maxAttempts; i++) {
                statuses.push((await resolve(token, `nobody-${i}`)).status);
            }
            expect(statuses.slice(0, ctx.maxAttempts).every((status) => status === 404)).toBe(true);
            expect(statuses[ctx.maxAttempts]).toBe(429);
        });
    });
}
