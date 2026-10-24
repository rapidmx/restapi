///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The OpenPGP Web Key Directory (`BaseWkdRoute`), identical on both backends - run by
// `test/routes/{mongo,sql}/KeyDiscoveryRoute.test.ts`.
import { request } from "@rapidrest/service-core/test";
import * as uuid from "uuid";
import { computeWkdHash } from "../../src/util/WkdUtils.js";
import { openPgpKey } from "../openPgpTestKeys.js";

export interface WkdRouteSuiteContext {
    app: () => any;
    /** e.g. `/mongo/.well-known/openpgpkey`. */
    baseUrl: string;
    createMailbox: (data: any) => Promise<any>;
    saveVerifiedDomain: (name: string) => Promise<void>;
    setOpenPgpAllowed: (allowed: boolean | undefined) => Promise<void>;
}

export function wkdRouteSuite(ctx: WkdRouteSuiteContext): void {
    describe("OpenPGP Web Key Directory", () => {
        const domain = `wkd-${uuid.v4().slice(0, 8)}.example`;
        let local: string;
        let current: Awaited<ReturnType<typeof openPgpKey>>;

        beforeEach(async () => {
            await ctx.saveVerifiedDomain(domain);
            local = `Alice.${uuid.v4().slice(0, 6)}`;
            const address = `${local.toLowerCase()}@${domain}`;
            const older = await openPgpKey(address, { created: new Date(Date.now() - 60_000) });
            current = await openPgpKey(address);
            const retired = await openPgpKey(address);
            await ctx.createMailbox({
                primarySmtpAddress: address,
                keys: [
                    { publicKey: "c21pbWU=", type: "x509", useType: "encrypt", fingerprint: "smime", notBefore: 0, notAfter: Date.now() + 86_400_000 },
                    older.key,
                    current.key,
                    { ...retired.key, notBefore: Date.now() + 1000, revokedAt: Date.now() },
                ],
            });
        });

        afterEach(async () => {
            await ctx.setOpenPgpAllowed(undefined);
        });

        it("serves the newest active OpenPGP certificate over the direct and advanced methods, binary, with an open CORS policy", async () => {
            const hash = computeWkdHash(local);
            const direct = await request(ctx.app()).get(`${ctx.baseUrl}/hu/${hash}?l=${encodeURIComponent(local)}`).set("Host", domain);
            expect(direct.status).toBe(200);
            expect(direct.headers["content-type"]).toContain("application/octet-stream");
            expect(direct.headers["access-control-allow-origin"]).toBe("*");
            expect(direct.headers["cache-control"]).toMatch(/^max-age=\d+$/);
            // The test client decodes bodies as text, so the binary certificate is checked by its length.
            expect(Number(direct.headers["content-length"])).toBe(Buffer.from(current.key.publicKey, "base64").length);

            const advanced = await request(ctx.app()).get(`${ctx.baseUrl}/${domain.toUpperCase()}/hu/${hash}?l=${encodeURIComponent(local)}`);
            expect(advanced.status).toBe(200);
            expect(Number(advanced.headers["content-length"])).toBe(Buffer.from(current.key.publicKey, "base64").length);
        });

        it("serves the policy file for both methods", async () => {
            for (const path of ["/policy", `/${domain}/policy`]) {
                const res = await request(ctx.app()).get(`${ctx.baseUrl}${path}`);
                expect(res.status).toBe(200);
                expect(res.headers["access-control-allow-origin"]).toBe("*");
            }
        });

        it("answers 404 without l, for a hash that doesn't match it, an unknown address or domain, and while OpenPGP is disallowed", async () => {
            const hash = computeWkdHash(local);
            const get = (path: string, host: string = domain) => request(ctx.app()).get(`${ctx.baseUrl}${path}`).set("Host", host);
            expect((await get(`/hu/${hash}`)).status).toBe(404);
            expect((await get(`/hu/${computeWkdHash("other")}?l=${local}`)).status).toBe(404);
            expect((await get(`/hu/not-a-hash?l=${local}`)).status).toBe(404);
            expect((await get(`/hu/${computeWkdHash("nobody")}?l=nobody`)).status).toBe(404);
            expect((await get(`/hu/${hash}?l=${local}`, "unknown.example")).status).toBe(404);
            expect((await get(`/hu/${hash}?l=${"x".repeat(65)}`)).status).toBe(404);
            expect((await get(`/hu/${hash}?l=${local}`, "")).status).toBe(404);

            await ctx.setOpenPgpAllowed(false);
            expect((await get(`/hu/${hash}?l=${encodeURIComponent(local)}`)).status).toBe(404);
        });
    });
}
