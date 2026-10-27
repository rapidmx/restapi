///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// HTTP behaviour of the mailbox policy and setup routes, identical on both backends.
import { ApiErrors, RepoUtils } from "@rapidrest/service-core";
import { request } from "@rapidrest/service-core/test";
import { ApiError, JWTUtils } from "@rapidrest/core";
import * as uuid from "uuid";
import { AuditAction } from "../../src/models/types.js";
import { DEFAULT_MAILBOX_QUOTA_BYTES } from "../../src/routes/BaseMailboxPolicyRoute.js";

export interface SystemSettingsSuiteContext {
    config: any;
    app: () => any;
    prefix: string;
    clear: () => Promise<void>;
    /** Saves a domain row with a random name and these fields. */
    addDomain: (fields?: Record<string, unknown>) => Promise<void>;
    /** The stored domain row, as the database holds it. */
    domainRow: (uid: string) => Promise<any>;
    /** Saves a mailbox policy row with only the given fields set. */
    savePolicy: (fields: Record<string, unknown>) => Promise<void>;
    auditActions: () => Promise<string[]>;
    /** Saves a new setup state row with these fields. */
    saveSetupState: (fields: Record<string, unknown>) => Promise<void>;
    /** Sets the stored setup state row's `seededDomains`, as a replica recording a seeded domain does. */
    setSeededDomains: (names: string[]) => Promise<void>;
    /** The stored setup state row, as the database holds it. */
    setupRow: () => Promise<any>;
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
        /** What the server's config says for each field - what the policy is seeded with, and what `defaults` reports. */
        const configValues = () => ({
            defaultQuotaBytes: DEFAULT_MAILBOX_QUOTA_BYTES,
            autoProvisionEnabled: ctx.config.get("mail:auto_provision:enabled") ?? false,
            autoProvisionQuotaBytes: ctx.config.get("mail:auto_provision:quota_bytes") ?? DEFAULT_MAILBOX_QUOTA_BYTES,
        });

        it("returns config-derived defaults to any signed-in user before anything is saved", async () => {
            const result = await as(userToken, request(ctx.app()).get(url()));
            expect(result.status).toBe(200);
            expect(result.body).toEqual({ ...configValues(), defaults: configValues() });
            expect((await request(ctx.app()).get(url())).status).toBe(401);
        });

        it("stores quotas beyond 32 bits exactly, up to the largest safe integer", async () => {
            const saved = await as(adminToken, request(ctx.app()).put(url())).send({ defaultQuotaBytes: 50_000_000_000, autoProvisionQuotaBytes: Number.MAX_SAFE_INTEGER });
            expect(saved.status).toBe(200);
            const read = await as(userToken, request(ctx.app()).get(url()));
            expect(read.body).toEqual(expect.objectContaining({ defaultQuotaBytes: 50_000_000_000, autoProvisionQuotaBytes: Number.MAX_SAFE_INTEGER }));
            expect((await as(adminToken, request(ctx.app()).put(url())).send({ defaultQuotaBytes: Number.MAX_SAFE_INTEGER + 2 })).status).toBe(400);
        });

        it("saves a partial patch for an admin and audits it", async () => {
            const saved = await as(adminToken, request(ctx.app()).put(url())).send({ defaultQuotaBytes: 1000, autoProvisionEnabled: true, ignored: 1 });
            expect(saved.status).toBe(200);
            expect(saved.body).toEqual(expect.objectContaining({ defaultQuotaBytes: 1000, autoProvisionEnabled: true }));

            const second = await as(adminToken, request(ctx.app()).put(url())).send({ autoProvisionQuotaBytes: 2000 });
            expect(second.body).toEqual(expect.objectContaining({ defaultQuotaBytes: 1000, autoProvisionEnabled: true, autoProvisionQuotaBytes: 2000 }));

            const read = await as(userToken, request(ctx.app()).get(url()));
            expect(read.body).toEqual({ defaultQuotaBytes: 1000, autoProvisionEnabled: true, autoProvisionQuotaBytes: 2000, defaults: configValues() });
            expect(await ctx.auditActions()).toEqual([AuditAction.MAILBOX_POLICY_UPDATE, AuditAction.MAILBOX_POLICY_UPDATE]);
        });

        it("reports the server's config values as defaults whatever has been saved, so an admin can reset a field to them", async () => {
            await as(adminToken, request(ctx.app()).put(url())).send({ defaultQuotaBytes: 1000, autoProvisionEnabled: !configValues().autoProvisionEnabled, autoProvisionQuotaBytes: 2000 });

            const read = await as(userToken, request(ctx.app()).get(url()));
            expect(read.body.defaultQuotaBytes).toBe(1000);
            expect(read.body.defaults).toEqual(configValues());

            // Sending a default back is an ordinary update, and leaves the defaults themselves untouched.
            const reset = await as(adminToken, request(ctx.app()).put(url())).send({ defaultQuotaBytes: read.body.defaults.defaultQuotaBytes });
            expect(reset.status).toBe(200);
            expect(reset.body).toEqual(expect.objectContaining({ defaultQuotaBytes: configValues().defaultQuotaBytes, autoProvisionQuotaBytes: 2000, defaults: configValues() }));
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

        it("is required on a fresh install whose only domains were seeded from its configuration, and not once another exists", async () => {
            await ctx.addDomain({ origin: "seed" });
            await ctx.addDomain({ origin: "seed" });
            expect((await as(adminToken, request(ctx.app()).get(url()))).body).toEqual({ required: true });

            // Saving a step there starts setup, as on a deployment without domains.
            const step = await as(adminToken, request(ctx.app()).put(url())).send({ currentStep: "domain" });
            expect(step.body).toEqual(expect.objectContaining({ required: true, startedAt: expect.any(String) }));

            await ctx.clear();
            await ctx.addDomain({ origin: "seed" });
            await ctx.addDomain({ origin: "console" });
            expect((await as(adminToken, request(ctx.app()).get(url()))).body).toEqual({ required: false });

            // A domain from before seeding existed (no origin) counts as made in the console, so an existing deployment is never pulled into setup.
            await ctx.clear();
            await ctx.addDomain({ origin: "seed" });
            await ctx.addDomain();
            expect((await as(adminToken, request(ctx.app()).get(url()))).body).toEqual({ required: false });
        });

        it("marks a domain added in the console as such, and never lets a client claim it was seeded", async () => {
            const domains = (suffix = "") => `${ctx.prefix}/domains${suffix}`;
            const created = await as(adminToken, request(ctx.app()).post(domains())).send({ name: "console.example.com", origin: "seed" });
            expect(created.status).toBe(200);
            expect(created.body.origin).toBe("console");
            expect((await ctx.domainRow("console.example.com")).origin).toBe("console");
            expect((await as(adminToken, request(ctx.app()).get(url()))).body.required).toBe(false);

            // A plain PUT drops it; `PUT /:id/:property` refuses it.
            const put = await as(adminToken, request(ctx.app()).put(domains("/console.example.com"))).send({ ...created.body, origin: "seed", enabled: false });
            expect(put.status).toBe(200);
            expect(put.body.enabled).toBe(false);
            expect((await ctx.domainRow("console.example.com")).origin).toBe("console");
            expect((await as(adminToken, request(ctx.app()).put(domains("/console.example.com/origin"))).send({ value: "seed" })).status).toBe(403);
            expect((await ctx.domainRow("console.example.com")).origin).toBe("console");
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

        it("never makes setup required again by saving a step on a deployment that doesn't need it", async () => {
            await ctx.addDomain();
            const healthy = await as(adminToken, request(ctx.app()).put(url())).send({ currentStep: "domain" });
            expect(healthy.status).toBe(200);
            expect(healthy.body).toEqual({ required: false, currentStep: "domain" });

            await ctx.clear();
            await as(adminToken, request(ctx.app()).post(url("/complete")));
            const completed = await as(adminToken, request(ctx.app()).put(url())).send({ currentStep: "settings" });
            expect(completed.body).toEqual(expect.objectContaining({ required: false, currentStep: "settings" }));
            expect((await as(adminToken, request(ctx.app()).get(url()))).body.required).toBe(false);
        });

        it("saves concurrent steps without a version conflict", async () => {
            const results = await Promise.all(
                ["a", "b", "c"].map((currentStep) => as(adminToken, request(ctx.app()).put(url())).send({ currentStep })),
            );
            expect(results.map((result) => result.status)).toEqual([200, 200, 200]);
            expect(["a", "b", "c"]).toContain((await as(adminToken, request(ctx.app()).get(url()))).body.currentStep);
        });

        it("completes and reopens setup when a replica records a seeded domain at the same time, keeping that name", async () => {
            await ctx.saveSetupState({ startedAt: new Date("2026-10-01T00:00:00Z"), currentStep: "domain", seededDomains: ["example.com"] });
            // The seeder records a name between the route's read and its write: a lost race (409), then a write reported as moved on (500).
            const lostRace = (names: string[]) => async () => {
                await ctx.setSeededDomains(names);
                throw new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "stale");
            };
            const update = vi
                .spyOn(RepoUtils.prototype, "update")
                .mockImplementationOnce(lostRace(["example.com", "example.org"]))
                .mockRejectedValueOnce(new ApiError(ApiErrors.INTERNAL_ERROR, 500, "moved on"));
            try {
                const done = await as(adminToken, request(ctx.app()).post(url("/complete")));
                expect(done.status).toBe(200);
                expect(done.body).toEqual(expect.objectContaining({ required: false, completedAt: expect.any(String) }));
                expect(update).toHaveBeenCalledTimes(3);
                const completed = await ctx.setupRow();
                expect(completed.completedAt).toBeTruthy();
                expect(new Date(completed.startedAt).toISOString()).toBe("2026-10-01T00:00:00.000Z");
                expect(completed.seededDomains).toEqual(["example.com", "example.org"]);

                update.mockClear();
                update.mockImplementationOnce(lostRace(["example.com", "example.org", "example.net"])).mockRejectedValueOnce(
                    new ApiError(ApiErrors.INTERNAL_ERROR, 500, "moved on"),
                );
                const reopened = await as(adminToken, request(ctx.app()).post(url("/reopen")));
                expect(reopened.status).toBe(200);
                expect(reopened.body).toEqual(expect.objectContaining({ required: true, startedAt: expect.any(String) }));
                expect(update).toHaveBeenCalledTimes(3);
                const open = await ctx.setupRow();
                expect(open.completedAt ?? undefined).toBeUndefined();
                expect(open.currentStep ?? undefined).toBeUndefined();
                expect(open.seededDomains).toEqual(["example.com", "example.org", "example.net"]);
            } finally {
                update.mockRestore();
            }
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
