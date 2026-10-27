///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for what the real-DB suites can't reach: `DomainSeeder`'s `@Init` hook, including a server that doesn't register the DNS provider
// model. Seeding itself is tested on both backends in ./domainSeedSuite.ts.
import { RepoUtils } from "@rapidrest/service-core";
import { AuditLogUtils } from "../../src/util/AuditLogUtils.js";
import { DomainSeeder } from "../../src/util/DomainSeedUtils.js";

/** A uniquely named stand-in model class. */
function model(name: string): any {
    return { [name]: class {} }[name];
}

class TestDomainSeeder extends (DomainSeeder as any) {
    protected domainClass: any = model("DomainModel");
    protected setupStateClass: any = model("SetupModel");
    protected auditLogClass: any = model("AuditModel");
    protected dnsProviderClass: any = model("ProviderModel");
}

function withFactory(seeder: any, newInstance: any = vi.fn(async (type: any, opts: any) => ({ type, opts }))): any {
    const factory: any = { newInstance };
    Object.defineProperty(seeder, "_objectFactory", { value: factory, writable: true, configurable: true });
    return factory;
}

describe("DomainSeeder init()", () => {
    it("throws when the objectFactory is not set", async () => {
        await expect((new TestDomainSeeder() as any).init()).rejects.toThrow("objectFactory is not set.");
    });

    it("builds the domain, setup state, audit and provider repos and the audit service once, and finds the publisher", async () => {
        const seeder: any = new TestDomainSeeder();
        const factory = withFactory(seeder);
        await seeder.init();
        expect(factory.newInstance.mock.calls.map(([type, opts]: any) => [type, opts.name])).toEqual([
            [RepoUtils, "DomainModel"],
            [RepoUtils, "SetupModel"],
            [RepoUtils, "AuditModel"],
            [AuditLogUtils, "AuditModel"],
            [RepoUtils, "ProviderModel"],
            ["DnsPublisher", "default"],
        ]);
        await seeder.init();
        expect(factory.newInstance).toHaveBeenCalledTimes(6);
    });

    it("rebuilds nothing already set, and skips what has no model class", async () => {
        const bare: any = new TestDomainSeeder();
        const factory = withFactory(bare);
        Object.assign(bare, { domainClass: undefined, setupStateClass: undefined, auditLogClass: undefined, dnsProviderClass: undefined, dnsPublisher: {} });
        await bare.init();
        expect(factory.newInstance).not.toHaveBeenCalled();
    });

    it("still seeds when the server doesn't register the DNS provider model, only without providers", async () => {
        const seeder: any = new TestDomainSeeder();
        withFactory(
            seeder,
            vi.fn(async (type: any, opts: any) => {
                if (opts.name === "ProviderModel") {
                    throw new Error("No metadata for ProviderModel");
                }
                return { type, opts };
            }),
        );
        const logger = { warn: vi.fn() };
        Object.defineProperty(seeder, "logger", { value: logger, configurable: true });
        await seeder.init();
        expect(seeder.dnsProviderRepo).toBeUndefined();
        expect(seeder.domainRepo).toBeDefined();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("No metadata for ProviderModel"));
    });
});
