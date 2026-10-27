///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for what the real-database suite (configKeyRotationSuite.ts) can't reach on `ConfigKeyRotationJob`: its `@Init` hook, the notice it
// can't hear and a job that was never initialized. The rotation itself is tested on both backends in the suite.
import { ConfigKeyRotationJob } from "../../src/jobs/ConfigKeyRotationJob.js";
import { ConfigEnvelopeSourceRegistry } from "../../src/secrets/ConfigEnvelopeSource.js";
import { LocalConfigKeyChannel } from "../../src/secrets/ConfigKeyChannel.js";

class RegisteringJob extends ConfigKeyRotationJob<any> {
    protected configKeyStateClass: any = { name: "StateModel" };
    protected auditLogClass: any = { name: "AuditModel" };
    public registered?: ConfigEnvelopeSourceRegistry;

    protected registerSources(registry: ConfigEnvelopeSourceRegistry): void {
        this.registered = registry;
        registry.register({ record: "Thing", modelClass: class {}, envelopes: () => [], replace: () => ({}) });
    }
}

class BareJob extends ConfigKeyRotationJob<any> {
    protected configKeyStateClass: any = undefined;
    protected auditLogClass: any = undefined;
}

describe("ConfigKeyRotationJob initialize()", () => {
    function withFactory(job: any): any {
        const factory: any = { newInstance: vi.fn(async (type: any, opts: any) => ({ type, opts })) };
        Object.defineProperty(job, "_objectFactory", { value: factory, writable: true, configurable: true });
        return factory;
    }

    it("throws when the objectFactory is not set", async () => {
        await expect((new RegisteringJob() as any).init()).rejects.toThrow("objectFactory is not set.");
    });

    it("builds its repositories, its keyring store and its channel, registers the record types' sources and listens for the notice", async () => {
        const job: any = new RegisteringJob();
        const channel = new LocalConfigKeyChannel();
        const factory = withFactory(job);
        factory.newInstance = vi.fn(async (type: any, opts: any) => (type === "ConfigKeyChannel" ? channel : { type, opts }));
        job.keyringBackend = "none";
        job.logger = { warn: vi.fn() };

        await job.init();

        expect(job.stateRepo).toEqual({ type: expect.anything(), opts: { name: "StateModel", args: [{ name: "StateModel" }] } });
        expect(job.auditLogRepo.opts.name).toBe("AuditModel");
        expect(job.auditLogUtils.opts.name).toBe("AuditModel");
        expect(job.keyringStore).toBeUndefined();
        expect(job.channel).toBe(channel);
        expect(job.registered).toBe(job.sources);
        expect(job.sources.list().map((source: any) => source.record)).toEqual(["Thing"]);
        const heard = vi.spyOn(job, "run").mockResolvedValue(undefined);
        await channel.notifyChanged();
        expect(heard).toHaveBeenCalledTimes(1);
        await job.dispose();
    });

    it("builds nothing it has no model for, and registers no sources by default", async () => {
        const job: any = new BareJob();
        withFactory(job);
        job.logger = { warn: vi.fn() };
        job.channel = new LocalConfigKeyChannel();
        await job.init();
        expect(job.stateRepo).toBeUndefined();
        expect(job.auditLogRepo).toBeUndefined();
        expect(job.auditLogUtils).toBeUndefined();
        expect(job.sources.list()).toEqual([]);
        await job.dispose();
    });

    it("says so, and relies on the schedule, when the notice can't be heard", async () => {
        const job: any = new BareJob();
        withFactory(job);
        const logger = { warn: vi.fn() };
        job.logger = logger;
        job.channel = {
            onChanged: vi.fn(async () => {
                throw new Error("redis down");
            }),
        };
        await job.init();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("redis down"));
        await expect(job.dispose()).resolves.toBeUndefined();
    });

    it("replaces its earlier subscription when it subscribes again, and ignores one that fails to stop", async () => {
        const job: any = new BareJob();
        const stops = [
            vi.fn(async () => {
                throw new Error("already gone");
            }),
            vi.fn(async () => {
                throw new Error("already gone too");
            }),
        ];
        job.channel = { onChanged: vi.fn(async () => stops.shift()) };
        await job.subscribe();
        await job.subscribe();
        expect(stops).toHaveLength(0);
        await job.dispose();
        await expect(job.dispose()).resolves.toBeUndefined();
    });

    it("does nothing before it has been initialized", async () => {
        await expect(new BareJob().run()).resolves.toBeUndefined();
    });
});
