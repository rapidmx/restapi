///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Guards on CRUDRoute's generic bulk/property/truncate endpoints (audit logs, escrow audit log, domains), key vault
// ownership, and branding asset/HTML safety - identical on both backends. Run from the SecurityControls test files.
import { request } from "@rapidrest/service-core/test";
import { ACLAction } from "@rapidrest/service-core";
import * as uuid from "uuid";
import { AuditAction } from "../../src/models/types.js";
import type { SecurityControlsSuiteContext } from "./escrowControlsSuite.js";

export function writeGuardsSuite(ctx: SecurityControlsSuiteContext): void {
    const newUser = (roles: string[] = []): any => ({ uid: uuid.v4(), roles, elevated: Date.now() });
    const authed = (method: "get" | "put" | "post" | "delete", user: any, path: string) =>
        (request(ctx.app()) as any)[method](`${ctx.prefix}${path}`).set("Authorization", "jwt " + ctx.token(user));
    const admin = newUser(["admin"]);

    describe("generic write endpoints", () => {
        beforeEach(async () => {
            await ctx.store().clear("AuditLogEntry", "EscrowAuditLogEntry", "Domain");
        });

        it("refuses rewriting audit log entries through PUT / and PUT /:id/:property, even for an admin", async () => {
            const entry = await ctx.store().save("AuditLogEntry", { action: AuditAction.DOMAIN_CREATE, targetType: "Domain", targetUid: "a" });

            const bulk = await authed("put", admin, "/audit-logs").send([{ uid: entry.uid, version: entry.version, targetUid: "rewritten" }]);
            const property = await authed("put", admin, `/audit-logs/${entry.uid}/targetUid`).send("rewritten");

            expect(bulk.status).toBe(403);
            expect(property.status).toBe(403);
            expect((await ctx.store().find("AuditLogEntry", { uid: entry.uid }))[0].targetUid).toBe("a");
        });

        it("refuses rewriting escrow audit log entries through PUT / and PUT /:id/:property, even for an admin", async () => {
            const entry = await ctx.store().save("EscrowAuditLogEntry", {
                sequence: 0,
                hash: "original-hash",
                action: "escrow_access_request.created",
                holderUserUid: uuid.v4(),
                matterId: uuid.v4(),
                mailboxUid: uuid.v4(),
                requestId: uuid.v4(),
                occurredAt: new Date(),
            });

            const bulk = await authed("put", admin, "/escrow-audit-log").send([{ uid: entry.uid, version: entry.version, hash: "forged" }]);
            const property = await authed("put", admin, `/escrow-audit-log/${entry.uid}/hash`).send("forged");

            expect(bulk.status).toBe(403);
            expect(property.status).toBe(403);
            expect((await ctx.store().find("EscrowAuditLogEntry", { uid: entry.uid }))[0].hash).toBe("original-hash");
        });

        it("never lets PUT / or PUT /:id/:property mark a domain verified, audits what they do change, and refuses truncate", async () => {
            const domain = await ctx.store().save("Domain", {
                uid: "unverified.example.org",
                name: "unverified.example.org",
                enabled: true,
                verified: false,
                verificationToken: "token",
            });

            const bulk = await authed("put", admin, "/domains").send([{ uid: domain.uid, version: domain.version, verified: true, enabled: false }]);
            expect(bulk.status).toBe(200);
            let stored = (await ctx.store().find("Domain", { uid: domain.uid }))[0];
            expect(stored.verified).toBe(false);
            expect(stored.enabled).toBe(false);
            expect(await ctx.store().find("AuditLogEntry", { action: AuditAction.DOMAIN_UPDATE })).toHaveLength(1);

            for (const property of ["verified", "verifiedAt", "verificationToken"]) {
                expect((await authed("put", admin, `/domains/${domain.uid}/${property}`).send("true")).status).toBe(403);
            }
            stored = (await ctx.store().find("Domain", { uid: domain.uid }))[0];
            expect(stored.verified).toBe(false);
            expect(stored.verificationToken).toBe("token");

            expect((await authed("put", admin, `/domains/${domain.uid}/dmarcPolicy`).send("reject")).status).toBe(200);
            expect((await authed("put", admin, `/domains/${domain.uid}/dmarcPolicy`).send("bogus")).status).toBe(400);
            expect((await authed("put", newUser(), `/domains/${domain.uid}/dmarcPolicy`).send("none")).status).toBe(403);

            expect((await authed("put", admin, `/domains/no-such.example.org/enabled`).send("true")).status).toBe(404);
            expect((await authed("delete", admin, "/domains")).status).toBe(403);
            expect(await ctx.store().find("Domain")).toHaveLength(1);
        });
    });

    describe("key vault ownership", () => {
        const owner = newUser();
        const delegate = newUser();
        const wrap = (method: string, methodId?: string, extra?: any) => ({
            method,
            methodId,
            ciphertext: "ct",
            nonce: "n",
            salt: "s",
            kdf: "argon2id",
            schemeVersion: 1,
            createdAt: Date.now(),
            ...extra,
        });
        const createMailbox = async (masterKeyWraps: any[]) => {
            const mailbox = await ctx.store().save("Mailbox", {
                ownerUserUid: owner.uid,
                primarySmtpAddress: `${uuid.v4()}@example.com`,
                aliasAddresses: [],
                displayName: "Owner",
                timezone: "UTC",
                quotaBytes: 1_000_000_000,
                usedBytes: 0,
            });
            await ctx.store().saveAcl(mailbox.uid, "Mailbox", [
                { userOrRoleId: owner.uid, actions: [ACLAction.FULL] },
                { userOrRoleId: delegate.uid, actions: [ACLAction.READ, ACLAction.UPDATE] },
            ]);
            await ctx.store().save("KeyVault", { mailboxUid: mailbox.uid, wrappedKeys: [], masterKeyWraps });
            return mailbox;
        };

        beforeEach(async () => {
            await ctx.store().clear("KeyVault", "Mailbox", "AuditLogEntry");
        });

        it("refuses every key vault write from a delegate with UPDATE access, while still letting them read", async () => {
            const mailbox = await createMailbox([wrap("password")]);
            const wrappedKey = { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" };

            expect((await authed("get", delegate, `/mailboxes/${mailbox.uid}/keyvault`)).status).toBe(200);
            expect((await authed("post", delegate, `/mailboxes/${mailbox.uid}/keyvault/keys`).send({ useType: "encrypt", csr: "x", wrappedKey })).status).toBe(403);
            expect((await authed("post", delegate, `/mailboxes/${mailbox.uid}/keyvault/keys/sign-enrollment`).send({ csr: "x", wrappedKey })).status).toBe(
                403,
            );
            expect((await authed("post", delegate, `/mailboxes/${mailbox.uid}/keyvault/wraps`).send(wrap("passkey", "p1"))).status).toBe(403);
            expect((await authed("delete", delegate, `/mailboxes/${mailbox.uid}/keyvault/wraps/password`)).status).toBe(403);
            expect((await ctx.store().find("KeyVault", { mailboxUid: mailbox.uid }))[0].masterKeyWraps).toHaveLength(1);
        });

        it("refuses removing the last non-escrow master key wrap (409), but removes one of several", async () => {
            const onlyPassword = await createMailbox([wrap("password")]);
            expect((await authed("delete", owner, `/mailboxes/${onlyPassword.uid}/keyvault/wraps/password`)).status).toBe(409);

            const scopeId = uuid.v4();
            const passwordAndEscrow = await createMailbox([wrap("password"), wrap("escrow", undefined, { escrowScopeId: scopeId })]);
            expect((await authed("delete", owner, `/mailboxes/${passwordAndEscrow.uid}/keyvault/wraps/password`)).status).toBe(409);
            expect((await ctx.store().find("KeyVault", { mailboxUid: passwordAndEscrow.uid }))[0].masterKeyWraps).toHaveLength(2);

            const twoMethods = await createMailbox([wrap("password"), wrap("passkey", "p1")]);
            const removed = await authed("delete", owner, `/mailboxes/${twoMethods.uid}/keyvault/wraps/passkey?methodId=p1`);
            expect(removed.status).toBe(200);
            expect(removed.body.masterKeyWraps.map((w: any) => w.method)).toEqual(["password"]);
        });
    });

    describe("branding", () => {
        const upload = (path: string, contentType: string, body: Buffer) =>
            authed("post", admin, `/branding/${path}`).set("Content-Type", contentType).send(body);

        beforeEach(async () => {
            await ctx.store().clear("Branding", "AuditLogEntry");
        });

        it("accepts only raster image types for the logo and icon - no SVG - and serves assets with nosniff and a sandbox CSP", async () => {
            const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
            expect((await upload("logo", "image/svg+xml", svg)).status).toBe(400);
            expect((await upload("icon", "image/svg+xml", svg)).status).toBe(400);
            expect((await upload("logo", "text/html", svg)).status).toBe(400);
            expect((await upload("logo", "image/gif", Buffer.from("GIF89a"))).status).toBe(400);

            expect((await upload("logo", "IMAGE/PNG; foo=bar", Buffer.from("png-bytes"))).status).toBe(200);
            expect((await upload("icon", "image/x-icon", Buffer.from("ico-bytes"))).status).toBe(200);
            expect((await upload("stylesheet", "text/css; charset=utf-8", Buffer.from("body{}"))).status).toBe(200);

            const logo = await request(ctx.app()).get(`${ctx.prefix}/branding/logo`);
            expect(logo.status).toBe(200);
            expect(logo.headers["content-type"]).toContain("image/png");
            expect(logo.headers["x-content-type-options"]).toBe("nosniff");
            expect(logo.headers["content-security-policy"]).toBe("sandbox");
            const stylesheet = await request(ctx.app()).get(`${ctx.prefix}/branding/stylesheet`);
            expect(stylesheet.headers["x-content-type-options"]).toBe("nosniff");
        });

        it("sanitizes headerHtml/footerHtml on save", async () => {
            const result = await authed("put", admin, "/branding").send({
                companyName: "Acme",
                title: "Acme Mail",
                headerHtml:
                    '<div class="banner" onclick="steal()">Welcome<script>alert(1)</script>' +
                    '<a href="javascript:alert(1)">bad</a><a href="https://example.com/help">help</a>' +
                    '<img src="https://example.com/x.png" onerror="steal()"><iframe src="https://evil.example"></iframe></div>',
                footerHtml: '<p style="color: red">Footer<img src="data:image/png;base64,AAAA"></p>',
            });

            expect(result.status).toBe(200);
            const { headerHtml, footerHtml } = result.body;
            for (const html of [headerHtml, footerHtml]) {
                expect(html).not.toMatch(/script|onclick|onerror|javascript:|iframe|data:/i);
            }
            expect(headerHtml).toContain('class="banner"');
            expect(headerHtml).toContain("Welcome");
            expect(headerHtml).toContain('href="https://example.com/help"');
            expect(footerHtml).toContain("Footer");
            expect((await request(ctx.app()).get(`${ctx.prefix}/branding`)).body.headerHtml).toBe(headerHtml);

            expect((await authed("put", admin, "/branding").send({ footerHtml: 42 })).status).toBe(400);
            const cleared = await authed("put", admin, "/branding").send({ headerHtml: null });
            expect(cleared.status).toBe(200);
            expect(cleared.body.headerHtml).toBeUndefined();
        });
    });
}
