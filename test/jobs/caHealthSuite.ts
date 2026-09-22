///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// How `AcmeEnrollmentDriverJob` surfaces the certificate authority failing, identical on both backends: a warning once per distinct failure (not on
// every tick), the health the info endpoint reports, one audit entry per run of failures, and the per-enrollment errors that are not the CA's still
// logged as before. The provider is a fake whose CA side fails on demand; the health record is the real one, on a temporary file.
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { AuditAction } from "../../src/models/types.js";
import { SigningEnrollmentHealth } from "../../src/pki/SigningEnrollmentHealth.js";

export interface CaHealthSuiteContext {
    job: () => any;
    /** The audit entries of `action` written so far. */
    auditEntries: (action: AuditAction) => Promise<any[]>;
}

export function caHealthSuite(ctx: CaHealthSuiteContext): void {
    describe("the certificate authority's health", () => {
        let dir: string;
        let original: any;
        let provider: any;
        let warn: ReturnType<typeof vi.spyOn>;
        let info: ReturnType<typeof vi.spyOn>;
        let error: ReturnType<typeof vi.spyOn>;
        /** What `advanceEnrollment()` does for an id: resolve `true`/`false`, or throw. */
        let behaviour: Map<string, () => Promise<boolean | void>>;

        beforeAll(async () => {
            dir = await fs.mkdtemp(path.join(os.tmpdir(), "job-ca-health-"));
        });
        afterAll(async () => {
            await fs.rm(dir, { recursive: true, force: true });
        });
        beforeEach(() => {
            const job = ctx.job();
            original = job.signingCertificateEnrollment;
            behaviour = new Map();
            provider = {
                health: new SigningEnrollmentHealth(() => path.join(dir, `health-${Math.random()}.json`)),
                listPendingEnrollments: async () => [...behaviour.keys()].map((enrollmentId) => ({ enrollmentId, identity: `${enrollmentId}@example.com`, status: "pending" })),
                advanceEnrollment: async (id: string) => behaviour.get(id)!(),
                getIssuedMaterial: async () => undefined,
                markInstalled: async () => undefined,
            };
            job.signingCertificateEnrollment = provider;
            warn = vi.spyOn(job.logger, "warn");
            info = vi.spyOn(job.logger, "info");
            error = vi.spyOn(job.logger, "error");
        });
        afterEach(() => {
            ctx.job().signingCertificateEnrollment = original;
            vi.restoreAllMocks();
        });

        const caDown = (message: string = "connect ECONNREFUSED") => async () => {
            throw Object.assign(new Error(message), { enrollmentPhase: "ca" });
        };
        const ca = async (): Promise<any[]> => ctx.auditEntries(AuditAction.SIGNING_ENROLLMENT_CA_UNREACHABLE);
        const warnings = (): string[] => warn.mock.calls.map((call: any[]) => String(call[0])).filter((line: string) => line.includes("certificate authority could not"));

        it("logs a failing CA once, then again only when the error changes, and says when it answers again", async () => {
            behaviour.set("a", caDown());
            behaviour.set("b", caDown());

            await ctx.job().run();
            await ctx.job().run();
            await ctx.job().run();

            expect(warnings()).toHaveLength(1);
            expect(warnings()[0]).toContain("the check of 2 signing certificate request(s): connect ECONNREFUSED");
            // Not once per enrollment per tick as an error.
            expect(error).not.toHaveBeenCalled();

            behaviour.set("a", caDown("getaddrinfo ENOTFOUND acme.example"));
            behaviour.set("b", caDown("getaddrinfo ENOTFOUND acme.example"));
            await ctx.job().run();
            expect(warnings()).toHaveLength(2);

            behaviour.set("a", async () => true);
            behaviour.set("b", async () => true);
            await ctx.job().run();
            expect(info).toHaveBeenCalledWith("AcmeEnrollmentDriverJob: the certificate authority answers again.");
            await ctx.job().run();
            expect(info.mock.calls.filter((call: any[]) => String(call[0]).includes("answers again"))).toHaveLength(1);
        });

        it("records the health the info endpoint reports: the error, sanitized, and the last success", async () => {
            behaviour.set("a", async () => true);
            await ctx.job().run();
            expect((await provider.health.report()).lastSuccessAt).toBeTruthy();

            behaviour.set("a", caDown("POST https://acme.test/order/1?token=abc failed"));
            await ctx.job().run();

            expect(await provider.health.report()).toEqual(expect.objectContaining({ ok: false, lastError: "POST [url acme.test] failed" }));
        });

        it("writes one audit entry when the failures reach the threshold, once per run of failures", async () => {
            behaviour.set("a", caDown("connect ETIMEDOUT https://acme.test/dir?token=abc"));

            await ctx.job().run();
            await ctx.job().run();
            expect(await ca()).toHaveLength(0);
            await ctx.job().run();
            await ctx.job().run();
            await ctx.job().run();

            const entries = await ca();
            expect(entries).toHaveLength(1);
            expect(entries[0]).toEqual(expect.objectContaining({ targetType: "SigningEnrollment", targetUid: "ca" }));
            expect(entries[0].details).toEqual(expect.objectContaining({ consecutiveFailures: 3, error: "connect ETIMEDOUT [url acme.test]", firstFailureAt: expect.any(String) }));
            expect(JSON.stringify(entries[0].details)).not.toContain("token");

            // The CA answers, then fails again: a new run of failures, a new entry.
            behaviour.set("a", async () => true);
            await ctx.job().run();
            behaviour.set("a", caDown());
            await ctx.job().run();
            await ctx.job().run();
            await ctx.job().run();
            expect(await ca()).toHaveLength(2);
        });

        it("audits after the configured number of failures", async () => {
            ctx.job().failureAuditAfter = 1;
            behaviour.set("a", caDown());

            await ctx.job().run();

            expect(await ca()).toHaveLength(1);
            ctx.job().failureAuditAfter = 3;
        });

        it("records nothing for a run that needed no CA, and a success only when the CA answered", async () => {
            behaviour.set("a", async () => false);
            behaviour.set("b", async () => undefined);

            await ctx.job().run();

            expect(await provider.health.report()).toEqual({ ok: true });
        });

        it("still logs an error that is not the CA's (the reply e-mail, an unexpected failure) for its enrollment, and lets the others advance", async () => {
            behaviour.set("mail", async () => {
                throw Object.assign(new Error("relay refused"), { enrollmentPhase: "reply" });
            });
            behaviour.set("odd", async () => {
                throw new Error("something else");
            });
            behaviour.set("ok", async () => true);

            await ctx.job().run();

            expect(error).toHaveBeenCalledWith(expect.stringContaining("failed to advance enrollment 'mail'"));
            expect(error).toHaveBeenCalledWith(expect.stringContaining("failed to advance enrollment 'odd'"));
            expect(warnings()).toHaveLength(0);
            expect(await provider.health.report()).toEqual(expect.objectContaining({ ok: true, lastSuccessAt: expect.any(String) }));
        });

        it("never fails a run because the health could not be recorded", async () => {
            provider.health.record = async () => {
                throw new Error("disk full");
            };
            behaviour.set("a", caDown());

            await expect(ctx.job().run()).resolves.toBeUndefined();

            expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not record the certificate authority's health: disk full"));
        });

        it("logs a CA failure the way it always did, and records no health, for a provider that keeps none", async () => {
            delete provider.health;
            behaviour.set("a", caDown());

            await expect(ctx.job().run()).resolves.toBeUndefined();

            expect(error).toHaveBeenCalledWith(expect.stringContaining("failed to advance enrollment 'a'"));
            expect(warnings()).toHaveLength(0);
            expect(await ca()).toHaveLength(0);
        });
    });
}
