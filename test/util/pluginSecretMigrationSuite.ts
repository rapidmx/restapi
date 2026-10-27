///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `PluginSecretMigrator` (spec 5.4), identical on both backends: the one-time move of plaintext plugin secret settings into the secret store at server
// start. Each value is stored and the row keeps its reference, audited per key without the value; running it again changes nothing; an uninstalled
// plugin's plaintext secrets are dropped; without a store nothing moves and what stays in plaintext is reported; a store or row write that fails leaves
// the row as it was and removes what was written for it; two replicas migrating at once store each value once; nothing here fails the server's start.
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { AuditAction } from "../../src/models/types.js";
import { isPluginSecretRef, PLUGIN_API_VERSION } from "../../src/plugins/PluginUtils.js";
import { InMemorySecretStore } from "../testDoubles.js";

export interface PluginSecretMigrationSuiteContext {
    /** A new migrator, as the server builds one at startup (or another replica does). */
    newMigrator: () => Promise<any>;
    /** Saves a plugin row with these fields (and defaults for the rest), as an older server would have. */
    insertPlugin: (fields: Record<string, unknown>) => Promise<void>;
    /** Every plugin row, by name. */
    rows: () => Promise<Record<string, any>>;
    /** Bumps a row's optimistic-lock version directly, as a concurrent change would. */
    bumpVersion: (uid: string) => Promise<void>;
    auditEntries: () => Promise<any[]>;
}

const MANIFEST = {
    apiVersion: PLUGIN_API_VERSION,
    displayName: "Vault",
    settings: [
        { key: "mail:v:api_key", label: "API key", type: "string" },
        { key: "mail:v:pin", label: "PIN", type: "number", secret: true },
        { key: "mail:v:note", label: "Note", type: "string" },
        { key: "mail:v:empty_token", label: "Empty token", type: "string" },
    ],
};

export function pluginSecretMigrationSuite(ctx: PluginSecretMigrationSuiteContext): void {
    describe("PluginSecretMigrator", () => {
        let store: InMemorySecretStore;

        /** A migrator using this test's store. */
        const replica = async (): Promise<any> => {
            const migrator: any = await ctx.newMigrator();
            migrator.secretStore = store;
            return migrator;
        };
        const migrations = async () => (await ctx.auditEntries()).filter((entry) => entry.action === AuditAction.PLUGIN_SECRET_MIGRATED);
        const valueAt = (ref: any): Record<string, string> | undefined => store.secrets.get(ref.$secretRef.path);

        async function insertVault(fields: Record<string, unknown> = {}): Promise<void> {
            await ctx.insertPlugin({
                name: "@rapidmx/vault",
                packageVersion: "1.0.0",
                enabled: true,
                removed: false,
                settings: { "mail:v:api_key": "s3cr3t", "mail:v:pin": 4321, "mail:v:note": "hi", "mail:v:empty_token": "" },
                manifest: MANIFEST,
                ...fields,
            });
        }

        beforeEach(() => {
            store = new InMemorySecretStore();
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it("moves every plaintext secret setting into the store, the row keeping only references, audited per key without the value", async () => {
            await insertVault();
            await ctx.insertPlugin({ name: "@rapidmx/plain", packageVersion: "1.0.0", enabled: true, removed: false, settings: { "mail:p:note": "hi" }, manifest: MANIFEST });
            const plainVersion: number = (await ctx.rows())["@rapidmx/plain"].version;

            const result = await (await replica()).run();

            expect(result).toEqual({
                storeAvailable: true,
                migrated: [
                    { name: "@rapidmx/vault", key: "mail:v:api_key" },
                    { name: "@rapidmx/vault", key: "mail:v:pin" },
                ],
                dropped: [],
                remaining: [],
            });
            const rows = await ctx.rows();
            const settings = rows["@rapidmx/vault"].settings;
            expect(isPluginSecretRef(settings["mail:v:api_key"])).toBe(true);
            expect(settings["mail:v:api_key"].$secretRef.path).toMatch(/^plugins\/rapidmx\/vault\/mail_v_api_key-[0-9a-f]{16}$/);
            expect(valueAt(settings["mail:v:api_key"])).toEqual({ value: "s3cr3t" });
            expect(valueAt(settings["mail:v:pin"])).toEqual({ value: "4321", type: "number" });
            // Settings that aren't secrets, and an empty secret (which nothing treats as set), stay as they were.
            expect(settings["mail:v:note"]).toBe("hi");
            expect(settings["mail:v:empty_token"]).toBe("");
            expect(store.secrets.size).toBe(2);
            expect(JSON.stringify(rows)).not.toContain("s3cr3t");
            expect(rows["@rapidmx/plain"].version).toBe(plainVersion);

            const audits = await migrations();
            expect(audits.map((entry) => [entry.targetType, entry.targetUid, entry.details, entry.actorUserUid ?? undefined])).toEqual(
                expect.arrayContaining([
                    ["Plugin", rows["@rapidmx/vault"].uid, { name: "@rapidmx/vault", key: "mail:v:api_key" }, undefined],
                    ["Plugin", rows["@rapidmx/vault"].uid, { name: "@rapidmx/vault", key: "mail:v:pin" }, undefined],
                ]),
            );
            expect(audits).toHaveLength(2);
            expect(JSON.stringify(audits)).not.toContain("s3cr3t");
            expect(JSON.stringify(audits)).not.toContain("4321");
        });

        it("is idempotent: the next start finds nothing to move and writes nothing", async () => {
            await insertVault();
            await (await replica()).run();
            const before = await ctx.rows();

            expect(await (await replica()).run()).toEqual({ storeAvailable: true, migrated: [], dropped: [], remaining: [] });
            expect(await ctx.rows()).toEqual(before);
            expect(store.secrets.size).toBe(2);
            expect(await migrations()).toHaveLength(2);
        });

        it("drops an uninstalled plugin's plaintext secrets rather than storing them: adding it again starts from its defaults", async () => {
            await insertVault({ enabled: false, removed: true });

            const result = await (await replica()).run();

            expect(result).toEqual({
                storeAvailable: true,
                migrated: [],
                dropped: [
                    { name: "@rapidmx/vault", key: "mail:v:api_key" },
                    { name: "@rapidmx/vault", key: "mail:v:pin" },
                ],
                remaining: [],
            });
            expect((await ctx.rows())["@rapidmx/vault"].settings).toEqual({ "mail:v:note": "hi", "mail:v:empty_token": "" });
            expect(store.secrets.size).toBe(0);
            expect((await migrations()).map((entry) => entry.details)).toEqual(
                expect.arrayContaining([
                    { name: "@rapidmx/vault", key: "mail:v:api_key", dropped: true },
                    { name: "@rapidmx/vault", key: "mail:v:pin", dropped: true },
                ]),
            );
        });

        it("without a secret store changes nothing and reports what stays in plaintext, so Diagnostics can warn", async () => {
            await insertVault();
            const before = await ctx.rows();
            const remaining = [
                { name: "@rapidmx/vault", key: "mail:v:api_key" },
                { name: "@rapidmx/vault", key: "mail:v:pin" },
            ];

            store.backend = "none";
            expect(await (await replica()).run()).toEqual({ storeAvailable: false, migrated: [], dropped: [], remaining });

            // A server that registers no store at all.
            const unregistered: any = await ctx.newMigrator();
            unregistered.secretStore = undefined;
            expect(await unregistered.run()).toEqual({ storeAvailable: false, migrated: [], dropped: [], remaining });

            expect(await ctx.rows()).toEqual(before);
            expect(store.secrets.size).toBe(0);
            expect(await migrations()).toHaveLength(0);
        });

        it("a store write that fails leaves the row as it was and removes what it wrote for it; the next start moves it", async () => {
            await insertVault();
            const before = await ctx.rows();
            // The first write succeeds, the second is refused.
            store.duringChange = async () => {
                store.refuse = true;
            };

            const failed = await (await replica()).run();
            expect(failed).toEqual({
                storeAvailable: true,
                migrated: [],
                dropped: [],
                remaining: [
                    { name: "@rapidmx/vault", key: "mail:v:api_key" },
                    { name: "@rapidmx/vault", key: "mail:v:pin" },
                ],
            });
            expect(await ctx.rows()).toEqual(before);
            expect(store.secrets.size).toBe(0);
            expect(await migrations()).toHaveLength(0);

            store.refuse = false;
            expect((await (await replica()).run()).migrated).toHaveLength(2);
        });

        it("a row write that fails removes the secrets written for it, and one the store can't remove is only logged", async () => {
            await insertVault();
            const before = await ctx.rows();
            const migrator: any = await replica();
            vi.spyOn(migrator.pluginRepo, "update").mockRejectedValueOnce(new Error("database unavailable"));
            store.failDelete = true;

            const result = await migrator.run();
            expect(result.migrated).toEqual([]);
            expect(result.remaining).toHaveLength(2);
            expect(await ctx.rows()).toEqual(before);
            // The secrets it couldn't remove are left behind (never used: no row names them).
            expect(store.secrets.size).toBe(2);
            expect(await migrations()).toHaveLength(0);
        });

        it("two replicas migrating at once store each value once and audit it once", async () => {
            await insertVault();
            // While the first replica stores its first value, the second migrates the whole row.
            const first: any = await replica();
            store.duringChange = async () => {
                await (await replica()).run();
            };

            const result = await first.run();

            expect(result).toEqual({ storeAvailable: true, migrated: [], dropped: [], remaining: [] });
            const settings = (await ctx.rows())["@rapidmx/vault"].settings;
            const named: string[] = [settings["mail:v:api_key"].$secretRef.path, settings["mail:v:pin"].$secretRef.path].sort();
            // Only the winner's secrets are left: the loser removed what it wrote.
            expect([...store.secrets.keys()].sort()).toEqual(named);
            expect(valueAt(settings["mail:v:api_key"])).toEqual({ value: "s3cr3t" });
            expect(await migrations()).toHaveLength(2);
        });

        it("a row that keeps changing under it is left for the next start", async () => {
            await insertVault();
            const migrator: any = await replica();
            const uid: string = (await ctx.rows())["@rapidmx/vault"].uid;
            const stale = new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "stale");
            const update = vi.spyOn(migrator.pluginRepo, "update").mockRejectedValue(stale);

            const result = await migrator.run();
            expect(update).toHaveBeenCalledTimes(3);
            expect(result.remaining).toHaveLength(2);
            expect(store.secrets.size).toBe(0);
            expect(isPluginSecretRef((await ctx.rows())["@rapidmx/vault"].settings["mail:v:api_key"])).toBe(false);
            expect(uid).toBeDefined();
        });

        it("a row changed under it is read again and migrated as it now is", async () => {
            await insertVault();
            const uid: string = (await ctx.rows())["@rapidmx/vault"].uid;
            store.duringChange = async () => {
                await ctx.bumpVersion(uid);
            };

            const result = await (await replica()).run();
            expect(result.migrated).toHaveLength(2);
            const settings = (await ctx.rows())["@rapidmx/vault"].settings;
            expect([...store.secrets.keys()].sort()).toEqual([settings["mail:v:api_key"].$secretRef.path, settings["mail:v:pin"].$secretRef.path].sort());
        });

        it("reads every plugin row, past the first page a plain find returns", async () => {
            // One at a time: in-process SQLite can't hold two transactions at once.
            for (let i = 0; i < 100; i++) {
                const n: string = String(i).padStart(3, "0");
                await ctx.insertPlugin({ uid: `p-${n}`, name: `@rapidmx/plain-${n}`, packageVersion: "1.0.0", enabled: true, removed: false, settings: {}, manifest: MANIFEST });
            }
            await insertVault({ uid: "zz-last" });

            expect((await (await replica()).run()).migrated).toEqual([
                { name: "@rapidmx/vault", key: "mail:v:api_key" },
                { name: "@rapidmx/vault", key: "mail:v:pin" },
            ]);
        });

        it("never throws: rows that can't be read are logged and the next start tries again", async () => {
            const migrator: any = await replica();
            vi.spyOn(migrator.pluginRepo, "find").mockRejectedValueOnce(new Error("database unavailable"));
            expect(await migrator.run()).toEqual({ storeAvailable: true, migrated: [], dropped: [], remaining: [] });
        });
    });
}
