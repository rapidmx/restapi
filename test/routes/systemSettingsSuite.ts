///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// HTTP behaviour of the mailbox policy and setup routes, identical on both backends.
import { request } from "@rapidrest/service-core/test";
import { JWTUtils } from "@rapidrest/core";
import * as uuid from "uuid";
import { AuditAction } from "../../src/models/types.js";
import { DEFAULT_MAILBOX_QUOTA_BYTES } from "../../src/routes/BaseMailboxPolicyRoute.js";

export interface SystemSettingsSuiteContext {
    config: any;
    app: () => any;
    prefix: string;
    clear: () => Promise<void>;
    addDomain: () => Promise<void>;
    /** Saves a mailbox policy row with only the given fields set. */
    savePolicy: (fields: Record<string, unknown>) => Promise<void>;
    auditActions: () => Promise<string[]>;
}

export function systemSettingsSuite(ctx: SystemSettingsSuiteContext): void {
    let userToken: string;
    let adminToken: string;

    beforeAll(() => {
        userToken = JWTUtils.createTokenSync(ctx.config.get("auth"), { uid: uuid.v4(), roles: [], elevated: Date.now() });
        adminToken = JWTUtils.createTokenSync(ctx.config.get("auth"), { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() });
    });

    beforeEach(async () => {
        await ctx.clear();
    });

    const as = (token: string, req: any) => req.set("Authorization", "jwt " + token);

    describe("mailbox policy", () => {
        const url = () => `${ctx.prefix}/mailbox-policy`;

        it("returns config-derived defaults to any signed-in user before anything is saved", async () => {
            const result = await as(userToken, request(ctx.app()).get(url()));
            expect(result.status).toBe(200);
            expect(result.body).toEqual({
                defaultQuotaBytes: DEFAULT_MAILBOX_QUOTA_BYTES,
                autoProvisionEnabled: ctx.config.get("mail:auto_provision:enabled") ?? false,
                autoProvisionQuotaBytes: ctx.config.get("mail:auto_provision:quota_bytes") ?? DEFAULT_MAILBOX_QUOTA_BYTES,
            });
            expect((await request(ctx.app()).get(url())).status).toBe(403);
        });

        it("saves a partial patch for an admin and audits it", async () => {
            const saved = await as(adminToken, request(ctx.app()).put(url())).send({ defaultQuotaBytes: 1000, autoProvisionEnabled: true, ignored: 1 });
            expect(saved.status).toBe(200);
            expect(saved.body).toEqual(expect.objectContaining({ defaultQuotaBytes: 1000, autoProvisionEnabled: true }));

            const second = await as(adminToken, request(ctx.app()).put(url())).send({ autoProvisionQuotaBytes: 2000 });
            expect(second.body).toEqual(expect.objectContaining({ defaultQuotaBytes: 1000, autoProvisionEnabled: true, autoProvisionQuotaBytes: 2000 }));

            const read = await as(userToken, request(ctx.app()).get(url()));
            expect(read.body).toEqual({ defaultQuotaBytes: 1000, autoProvisionEnabled: true, autoProvisionQuotaBytes: 2000 });
            expect(await ctx.auditActions()).toEqual([AuditAction.MAILBOX_POLICY_UPDATE, AuditAction.MAILBOX_POLICY_UPDATE]);
        });

        it("fills fields a previously saved row lacks from config, on reads and writes", async () => {
            await ctx.savePolicy({ defaultQuotaBytes: 777 });
            const read = await as(userToken, request(ctx.app()).get(url()));
            expect(read.body).toEqual(expect.objectContaining({ defaultQuotaBytes: 777, autoProvisionEnabled: expect.any(Boolean) }));
            const written = await as(adminToken, request(ctx.app()).put(url())).send({ defaultQuotaBytes: 778 });
            expect(written.body).toEqual({ ...read.body, defaultQuotaBytes: 778 });
        });

        it("rejects non-admins and invalid values", async () => {
            expect((await as(userToken, request(ctx.app()).put(url())).send({ defaultQuotaBytes: 1 })).status).toBe(403);
            for (const body of [{ defaultQuotaBytes: 0 }, { autoProvisionQuotaBytes: 1.5 }, { defaultQuotaBytes: "5" }, { autoProvisionEnabled: "yes" }]) {
                expect((await as(adminToken, request(ctx.app()).put(url())).send(body)).status).toBe(400);
            }
        });
    });

    describe("setup", () => {
        const url = (suffix = "") => `${ctx.prefix}/setup${suffix}`;

        it("is required on a fresh deployment with no domains, and admin-only", async () => {
            expect((await as(userToken, request(ctx.app()).get(url()))).status).toBe(403);
            const result = await as(adminToken, request(ctx.app()).get(url()));
            expect(result.status).toBe(200);
            expect(result.body).toEqual({ required: true });
        });

        it("is not required on a deployment that already has a domain and never started setup", async () => {
            await ctx.addDomain();
            expect((await as(adminToken, request(ctx.app()).get(url()))).body).toEqual({ required: false });
        });

        it("records progress, stays required once started even after a domain exists, and completes", async () => {
            const step = await as(adminToken, request(ctx.app()).put(url())).send({ currentStep: "domain" });
            expect(step.status).toBe(200);
            expect(step.body).toEqual(expect.objectContaining({ required: true, currentStep: "domain", startedAt: expect.any(String) }));

            await ctx.addDomain();
            const next = await as(adminToken, request(ctx.app()).put(url())).send({ currentStep: "settings" });
            expect(next.body).toEqual(expect.objectContaining({ required: true, currentStep: "settings", startedAt: step.body.startedAt }));

            const done = await as(adminToken, request(ctx.app()).post(url("/complete")));
            expect(done.status).toBe(200);
            expect(done.body).toEqual(expect.objectContaining({ required: false, completedAt: expect.any(String) }));
            expect((await as(adminToken, request(ctx.app()).get(url()))).body.required).toBe(false);

            const reopened = await as(adminToken, request(ctx.app()).post(url("/reopen")));
            expect(reopened.body).toEqual(expect.objectContaining({ required: true, startedAt: expect.any(String) }));
            expect(reopened.body.completedAt).toBeUndefined();
            expect(reopened.body.currentStep).toBeUndefined();
            expect(await ctx.auditActions()).toEqual(expect.arrayContaining([AuditAction.SETUP_COMPLETE, AuditAction.SETUP_REOPEN]));
        });

        it("completes setup that was never started", async () => {
            const done = await as(adminToken, request(ctx.app()).post(url("/complete")));
            expect(done.body).toEqual(expect.objectContaining({ required: false, startedAt: expect.any(String) }));
        });

        it("rejects an invalid step and non-admin writes", async () => {
            for (const body of [{}, { currentStep: "" }, { currentStep: 5 }, { currentStep: "x".repeat(65) }]) {
                expect((await as(adminToken, request(ctx.app()).put(url())).send(body)).status).toBe(400);
            }
            expect((await as(userToken, request(ctx.app()).put(url())).send({ currentStep: "a" })).status).toBe(403);
            expect((await as(userToken, request(ctx.app()).post(url("/complete")))).status).toBe(403);
            expect((await as(userToken, request(ctx.app()).post(url("/reopen")))).status).toBe(403);
        });
    });
}
