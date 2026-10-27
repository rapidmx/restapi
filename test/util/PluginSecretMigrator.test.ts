///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for what the real-DB suites can't reach: `PluginSecretMigrator`'s `@Init` hook, and the failures that only a fake repository can
// stage (the row can't be read back after losing a race, it was deleted meanwhile, the audit entry can't be written). Migration itself is tested on both
// backends in ./pluginSecretMigrationSuite.ts.
import { ApiError } from "@rapidrest/core";
import { ApiErrors, RepoUtils } from "@rapidrest/service-core";
import { PLUGIN_API_VERSION } from "../../src/plugins/PluginUtils.js";
import { AuditLogUtils } from "../../src/util/AuditLogUtils.js";
import { PluginSecretMigrator } from "../../src/util/PluginSecretMigrator.js";
import { InMemorySecretStore } from "../testDoubles.js";

/** A uniquely named stand-in model class. */
function model(name: string): any {
    return { [name]: class {} }[name];
}

class TestPluginSecretMigrator extends (PluginSecretMigrator as any) {
    protected pluginClass: any = model("PluginModel");
    protected auditLogClass: any = model("AuditModel");
}

function withFactory(migrator: any, newInstance: any = vi.fn(async (type: any, opts: any) => ({ type, opts }))): any {
    const factory: any = { newInstance };
    Object.defineProperty(migrator, "_objectFactory", { value: factory, writable: true, configurable: true });
    return factory;
}

const ROW = {
    uid: "p1",
    version: 1,
    name: "@rapidmx/vault",
    removed: false,
    settings: { "mail:v:api_key": "s3cr3t" },
    manifest: { apiVersion: PLUGIN_API_VERSION, displayName: "Vault", settings: [{ key: "mail:v:api_key", label: "API key", type: "string" }] },
};

/** A migrator over a fake repository holding `ROW`, whose `update()` always loses the optimistic lock. */
function migratorLosingEveryRace(findOne: () => Promise<any>): { migrator: any; store: InMemorySecretStore; logger: any } {
    const migrator: any = new TestPluginSecretMigrator();
    const store = new InMemorySecretStore();
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    Object.defineProperty(migrator, "logger", { value: logger, configurable: true });
    migrator.secretStore = store;
    migrator.pluginRepo = {
        find: vi.fn(async () => [ROW]),
        findOne: vi.fn(findOne),
        update: vi.fn(async () => {
            throw new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "stale");
        }),
    };
    migrator.auditLogUtils = { record: vi.fn() };
    return { migrator, store, logger };
}

describe("PluginSecretMigrator init()", () => {
    it("throws when the objectFactory is not set", async () => {
        await expect((new TestPluginSecretMigrator() as any).init()).rejects.toThrow("objectFactory is not set.");
    });

    it("builds the plugin and audit repos and the audit service once", async () => {
        const migrator: any = new TestPluginSecretMigrator();
        const factory = withFactory(migrator);
        await migrator.init();
        expect(factory.newInstance.mock.calls.map(([type, opts]: any) => [type, opts.name])).toEqual([
            [RepoUtils, "PluginModel"],
            [RepoUtils, "AuditModel"],
            [AuditLogUtils, "AuditModel"],
        ]);
        await migrator.init();
        expect(factory.newInstance).toHaveBeenCalledTimes(3);
    });

    it("rebuilds nothing already set, and skips what has no model class", async () => {
        const bare: any = new TestPluginSecretMigrator();
        const factory = withFactory(bare);
        Object.assign(bare, { pluginClass: undefined, auditLogClass: undefined });
        await bare.init();
        expect(factory.newInstance).not.toHaveBeenCalled();
    });
});

describe("PluginSecretMigrator run()", () => {
    it("leaves a row it can't read back after losing a race for the next start", async () => {
        const { migrator, store, logger } = migratorLosingEveryRace(async () => {
            throw new Error("database unavailable");
        });
        expect(await migrator.run()).toEqual({ storeAvailable: true, migrated: [], dropped: [], remaining: [{ name: "@rapidmx/vault", key: "mail:v:api_key" }] });
        expect(store.secrets.size).toBe(0);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("database unavailable"));
        expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("s3cr3t");
    });

    it("has nothing left to move for a row deleted while it was moving it", async () => {
        const { migrator, store } = migratorLosingEveryRace(async () => null);
        expect(await migrator.run()).toEqual({ storeAvailable: true, migrated: [], dropped: [], remaining: [] });
        expect(store.secrets.size).toBe(0);
    });

    it("keeps a move it saved when its audit entry can't be written, and logs that", async () => {
        const { migrator, store, logger } = migratorLosingEveryRace(async () => ROW);
        migrator.pluginRepo.update = vi.fn(async (fields: any) => fields);
        migrator.auditLogUtils.record = vi.fn(async () => {
            throw new Error("audit log unavailable");
        });
        expect(await migrator.run()).toEqual({ storeAvailable: true, migrated: [{ name: "@rapidmx/vault", key: "mail:v:api_key" }], dropped: [], remaining: [] });
        expect(store.secrets.size).toBe(1);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("audit log unavailable"));
    });

    it("says nothing when a server without a store has no plaintext secret to keep", async () => {
        const { migrator, logger } = migratorLosingEveryRace(async () => ROW);
        migrator.pluginRepo.find = vi.fn(async () => [{ ...ROW, settings: { "mail:v:note": "hi" } }]);
        migrator.secretStore = undefined;
        expect(await migrator.run()).toEqual({ storeAvailable: false, migrated: [], dropped: [], remaining: [] });
        expect(logger.warn).not.toHaveBeenCalled();
    });
});
