///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ApiErrors, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { AuditAction, Plugin, PluginSettingValue, SecretRef } from "../models/types.js";
import { PluginSecretKey, plaintextPluginSecrets, plaintextSecretKeys, writePluginSecretSetting } from "../plugins/PluginSecretUtils.js";
import type { SecretStore } from "../secrets/SecretStore.js";
import { AuditLogUtils } from "./AuditLogUtils.js";
import { findAllRows } from "./DnsPublishingUtils.js";
import { asEntity } from "./EntityUtils.js";
const { Init, Inject, Logger } = ObjectDecorators;

/** How many times one row's migration is tried when another write changes the row meanwhile, before it is left for the next start. */
const MAX_ATTEMPTS = 3;

/** What one `PluginSecretMigrator.run()` did. Names plugins and settings only, never a value. */
export interface PluginSecretMigrationResult {
    /** Whether a secret store is registered (`backend` other than `"none"`). Without one nothing moves. */
    storeAvailable: boolean;
    /** The secret settings moved into the store, each audited `PLUGIN_SECRET_MIGRATED`. */
    migrated: PluginSecretKey[];
    /** The plaintext secret settings of uninstalled plugins, removed from their rows rather than stored (adding a plugin again starts from its defaults). */
    dropped: PluginSecretKey[];
    /** The secret settings still in plaintext afterwards: all of them without a store, else those whose move failed (tried again on the next start).
     * What the server's Diagnostics warns about. */
    remaining: PluginSecretKey[];
}

/** Whether `err` is a write refused because the row's version moved on (`RepoUtils.update()`'s optimistic lock). */
function isStaleVersionError(err: any): boolean {
    return err instanceof ApiError && (err as any).code === ApiErrors.INVALID_OBJECT_VERSION;
}

/**
 * The one-time move of plugin secret settings saved in plaintext (before secret settings were kept in the `SecretStore`) into the store (spec 5.4), run
 * by the server at startup, after its datastores are connected and before its plugin host reads the rows: `await migrator.run()`, which never throws.
 *
 * For each installed plugin, every secret setting (`isSecretSetting()`) whose value is still on the row is written to the store at a path of its own
 * (`pluginSecretPath()`), then one versioned update of the row puts the references in place of the values, and each key is audited
 * `PLUGIN_SECRET_MIGRATED` (the plugin's name and the key, never the value, and no user). An uninstalled plugin's plaintext secrets are removed from its
 * row instead (audited with `dropped: true`): nothing reads them, and adding the plugin again starts from its defaults.
 *
 * It is idempotent: a row holding only references has nothing to move. It runs only with a store registered; without one nothing changes, and the result's
 * `remaining` lists what stays in plaintext. Several replicas starting at once are safe: a row's update is checked against the version it read, the loser
 * removes what it wrote and reads the row again (finding nothing left to move), so each value is stored and audited once. A store or row write that fails
 * leaves the row as it was, removes what was written for it, and is tried again on the next start.
 *
 * Concrete entity classes are supplied by the Mongo/SQL subclasses (`PluginSecretMigratorMongo`/`PluginSecretMigratorSQL`).
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class PluginSecretMigrator<T extends Plugin> {
    protected abstract pluginClass: any;

    /** Supplied by the Mongo/SQL subclasses so each moved key is recorded as an `AuditLogEntry`. */
    protected abstract auditLogClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    protected pluginRepo?: RepoUtils<T>;
    protected auditLogUtils?: AuditLogUtils;

    /** Where the values go: the server's OpenBao or Kubernetes Secrets. `NullSecretStore` (or none registered) means there is no store. */
    @Inject("SecretStore")
    protected secretStore?: SecretStore;

    @Logger
    protected logger: any;

    @Init
    public async init(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.pluginRepo && this.pluginClass) {
            this.pluginRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.pluginClass.name, args: [this.pluginClass] });
        }
        if (!this.auditLogUtils && this.auditLogClass) {
            const auditLogRepo: RepoUtils<any> = await this._objectFactory.newInstance(RepoUtils, { name: this.auditLogClass.name, args: [this.auditLogClass] });
            this.auditLogUtils = await this._objectFactory.newInstance(AuditLogUtils, { name: this.auditLogClass.name, args: [auditLogRepo] });
        }
    }

    /** Moves every plaintext plugin secret setting into the secret store. Never throws: what goes wrong is logged, and the next start tries again. */
    public async run(): Promise<PluginSecretMigrationResult> {
        const store: SecretStore | undefined = this.secretStore?.backend === "none" ? undefined : this.secretStore;
        const result: PluginSecretMigrationResult = { storeAvailable: !!store, migrated: [], dropped: [], remaining: [] };
        let rows: T[];
        try {
            // Every row, page by page: a plugin past the first page would otherwise keep its secrets in plaintext.
            rows = await findAllRows<T>(this.pluginRepo!);
        } catch (err: any) {
            this.logger?.error(`PluginSecretMigrator: the plugins can't be read, so no secret setting is moved on this start: ${err?.message}`);
            return result;
        }
        if (!store) {
            result.remaining = plaintextPluginSecrets(rows);
            if (result.remaining.length > 0) {
                this.logger?.warn(
                    `PluginSecretMigrator: ${result.remaining.length} plugin secret setting(s) are kept in plaintext in the database: no secret store is configured.`,
                );
            }
            return result;
        }
        for (const row of rows) {
            if (plaintextSecretKeys(row).length > 0) {
                await this.migrateRow(store, row, result);
            }
        }
        if (result.migrated.length + result.dropped.length > 0) {
            this.logger?.info(
                `PluginSecretMigrator: moved ${result.migrated.length} plugin secret setting(s) into the secret store, removed ${result.dropped.length} of uninstalled plugins.`,
            );
        }
        return result;
    }

    /** Moves one row's plaintext secrets, reading the row again after a write that lost to another (at most `MAX_ATTEMPTS` times). */
    private async migrateRow(store: SecretStore, first: T, result: PluginSecretMigrationResult): Promise<void> {
        let row: T | undefined = first;
        for (let attempt = 1; row; attempt++) {
            const keys: string[] = plaintextSecretKeys(row);
            if (keys.length === 0) {
                return;
            }
            const written: SecretRef[] = [];
            try {
                const settings: Record<string, PluginSettingValue> = { ...row.settings };
                for (const key of keys) {
                    if (row.removed) {
                        delete settings[key];
                    } else {
                        const ref = await writePluginSecretSetting(store, row.name, key, settings[key] as string | number | boolean);
                        written.push(ref.$secretRef);
                        settings[key] = ref;
                    }
                }
                await this.pluginRepo!.update({ uid: row.uid, version: row.version, settings } as any, asEntity(this.pluginRepo!, row), { ignoreACL: true });
            } catch (err: any) {
                await this.removeWritten(store, written);
                let reason: string | undefined = err?.message;
                if (isStaleVersionError(err) && attempt < MAX_ATTEMPTS) {
                    // Another replica (or an administrator) changed the row meanwhile: what it holds now decides what is left to move.
                    try {
                        row = (await this.pluginRepo!.findOne(first.uid, { ignoreACL: true, skipCache: true })) ?? undefined;
                        continue;
                    } catch (readErr: any) {
                        reason = readErr?.message;
                    }
                }
                this.logger?.warn(`PluginSecretMigrator: the secret settings of plugin '${first.name}' are not moved on this start: ${reason}`);
                result.remaining.push(...keys.map((key) => ({ name: first.name, key })));
                return;
            }
            for (const key of keys) {
                (row.removed ? result.dropped : result.migrated).push({ name: row.name, key });
                await this.audit(row, key);
            }
            return;
        }
    }

    /** Records one moved (or, for an uninstalled plugin, dropped) key. The move is already saved, so a failure here is only logged. */
    private async audit(row: T, key: string): Promise<void> {
        const details: Record<string, unknown> = { name: row.name, key, ...(row.removed ? { dropped: true } : {}) };
        try {
            await this.auditLogUtils?.record({ action: AuditAction.PLUGIN_SECRET_MIGRATED, targetType: "Plugin", targetUid: row.uid, details });
        } catch (err: any) {
            this.logger?.warn(`PluginSecretMigrator: the move of '${key}' of plugin '${row.name}' could not be audited: ${err?.message}`);
        }
    }

    /** Removes the secrets written for a row that wasn't saved: no row names them. One the store can't remove is logged and left (nothing reads it). */
    private async removeWritten(store: SecretStore, written: SecretRef[]): Promise<void> {
        for (const ref of written) {
            try {
                await store.delete(ref);
            } catch (err: any) {
                this.logger?.warn(`PluginSecretMigrator: a secret written for a plugin row that wasn't saved could not be removed and was left there: ${err?.message}`);
            }
        }
    }
}
