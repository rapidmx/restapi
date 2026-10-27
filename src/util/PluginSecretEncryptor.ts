///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ApiErrors, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { AuditAction, ConfigKeyState, Plugin, PluginSettingValue } from "../models/types.js";
import { PluginSecretKey, plaintextSecretKeys } from "../plugins/PluginSecretUtils.js";
import { resolveServerRolloutCheck, RolloutStatus, ServerRolloutCheck } from "../plugins/ServerRolloutCheck.js";
import { pluginSecretContext } from "../plugins/PluginUtils.js";
import type { ConfigCipher } from "../secrets/ConfigCipher.js";
import { ConfigKeyChannel, ConfigKeyLock, resolveConfigKeyChannel } from "../secrets/ConfigKeyChannel.js";
import { CONFIG_KEY_STATE_UID } from "../secrets/ConfigKeyring.js";
import { AuditLogUtils } from "./AuditLogUtils.js";
import { findAllRows } from "./DnsPublishingUtils.js";
import { asEntity } from "./EntityUtils.js";
import { isDuplicateKeyError } from "./RequestBodyUtils.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

/** How many times one row's (or the key state row's) write is tried when another write changes it meanwhile, before it is left for the next start. */
const MAX_ATTEMPTS = 3;

/** How long the lock lasts if its holder never releases it. A run that outlasts it is still safe: every write is version-checked. */
const LOCK_TTL_MS = 2 * 60 * 1000;

/** How often `runUntilEncrypted()` asks again while it waits (spec 5.7: every 30 s). */
export const DEFAULT_PLUGIN_SECRET_CHECK_INTERVAL_MS = 30_000;

/** How long a repeated "still waiting" answer is trusted before the key state row is rewritten with a fresh `checkedAt`. */
const WAITING_RECORD_REFRESH_MS = 5 * 60 * 1000;

/** What one `PluginSecretEncryptor.run()` did. Names plugins and settings only, never a value. */
export interface PluginSecretEncryptionResult {
    /** The secret settings encrypted in place, each audited `PLUGIN_SECRET_MIGRATED`. */
    encrypted: PluginSecretKey[];
    /** The plaintext secret settings of uninstalled plugins, removed from their rows rather than encrypted (adding a plugin again starts from its defaults). */
    dropped: PluginSecretKey[];
    /** The secret settings still in plaintext afterwards because their row could not be saved (tried again on the next start). */
    remaining: PluginSecretKey[];
    /** Whether `ConfigKeyState.pluginSecrets.encryptedAt` is set after this run: from then on every save encrypts. */
    completed: boolean;
    /** Why this run did nothing, when it waited: pods of an older release still running (or not listable), no cipher, or another server copy at work. */
    waiting?: string;
}

/** What `runUntilEncrypted()` takes. */
export interface PluginSecretEncryptionOptions {
    /** Milliseconds between two checks while it waits; 30 s by default. */
    intervalMs?: number;
    /** Stops the waiting. */
    signal?: AbortSignal;
}

/** Whether `err` is a write refused because the row's version moved on (`RepoUtils.update()`'s optimistic lock). */
function isStaleVersionError(err: any): boolean {
    return err instanceof ApiError && (err as any).code === ApiErrors.INVALID_OBJECT_VERSION;
}

/** Waits `ms`, or until `signal` aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const done = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener("abort", done);
    });
}

/**
 * The run that encrypts plugin secret settings saved in plaintext, in place on the plugin's own row (spec 5.7), started by the server in the background after
 * its datastores are connected: `await encryptor.run()`, which never throws, or `runUntilEncrypted()`, which also keeps asking while it has to wait. It replaces
 * the `$secretRef` migration of restapi's step 7.
 *
 * It waits for the rollout first: a server from before this release applies `Plugin.settings` raw, so it would hand a plugin an envelope as a setting's value.
 * Until `ConfigKeyState.pluginSecrets.encryptedAt` is set the injected `ServerRolloutCheck` must say that no pod of an older release is left (what it says when it
 * isn't, or can't tell, is recorded on the key state row as `pluginSecrets.reason`, for Diagnostics and the console), unless
 * `config_encryption:plugin_secrets:wait_for_rollout` is false. Its first completed run sets `encryptedAt`, from which point the plugin route encrypts every save
 * and every later start runs it at once, without asking about the rollout (any later release understands envelopes).
 *
 * For each installed plugin, every secret setting (`isSecretSetting()`) whose value is still on the row is encrypted for the row and the setting
 * (`pluginSecretContext()`), then one versioned update of the row puts the envelopes in place of the values, and each key is audited
 * `PLUGIN_SECRET_MIGRATED` (the plugin's name and the key, never the value, and no user). An uninstalled plugin's plaintext secrets are removed from its row
 * instead (audited with `dropped: true`): nothing reads them, and adding the plugin again starts from its defaults.
 *
 * It is idempotent: a row holding only envelopes has nothing to encrypt. Several replicas starting at once are safe: they take the key-rotation lock
 * (`ConfigKeyChannel`), so one copy works at a time, and a row's update is checked against the version it read, so a copy that loses reads the row again and
 * finds nothing left to do. Because the plugin-state hash counts decrypted values, the run rolls no plugin worker. A row or state write that fails leaves the row
 * as it was and is tried again on the next start.
 *
 * Concrete entity classes are supplied by the Mongo/SQL subclasses (`PluginSecretEncryptorMongo`/`PluginSecretEncryptorSQL`).
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class PluginSecretEncryptor<T extends Plugin, S extends ConfigKeyState = ConfigKeyState> {
    protected abstract pluginClass: any;

    /** Supplied by the Mongo/SQL subclasses so each encrypted key is recorded as an `AuditLogEntry`. */
    protected abstract auditLogClass: any;

    /** Supplied by the Mongo/SQL subclasses: the key state row records the run (`pluginSecrets`). */
    protected abstract configKeyStateClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    protected pluginRepo?: RepoUtils<T>;
    protected stateRepo?: RepoUtils<S>;
    protected auditLogUtils?: AuditLogUtils;

    /** Encrypts the values. None registered (a server without the configuration encryption) means nothing can be encrypted. */
    @Inject("ConfigCipher")
    protected cipher?: ConfigCipher;

    /** Whether every server copy runs this release. The server registers its Kubernetes check; the default says "rolled out". */
    protected rolloutCheck?: ServerRolloutCheck;

    /** How the server copies take turns; none in production without Redis, where the version checks keep the run safe. */
    protected channel?: ConfigKeyChannel;

    /** `config_encryption:plugin_secrets:wait_for_rollout` (default true): false skips the rollout check, for an operator who has checked the rollout. An
     * environment variable arrives as a string. */
    @Config("config_encryption:plugin_secrets:wait_for_rollout", true)
    protected waitForRollout: unknown = true;

    @Logger
    protected logger: any;

    /** The last failure to check the rollout that was logged, so a pod list that stays unreadable is logged once, not every 30 seconds. */
    private lastRolloutError?: string;

    @Init
    public async init(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.pluginRepo && this.pluginClass) {
            this.pluginRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.pluginClass.name, args: [this.pluginClass] });
        }
        if (!this.stateRepo && this.configKeyStateClass) {
            this.stateRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.configKeyStateClass.name, args: [this.configKeyStateClass] });
        }
        if (!this.auditLogUtils && this.auditLogClass) {
            const auditLogRepo: RepoUtils<any> = await this._objectFactory.newInstance(RepoUtils, { name: this.auditLogClass.name, args: [this.auditLogClass] });
            this.auditLogUtils = await this._objectFactory.newInstance(AuditLogUtils, { name: this.auditLogClass.name, args: [auditLogRepo] });
        }
        this.rolloutCheck ??= await resolveServerRolloutCheck(this._objectFactory, this.logger);
        this.channel ??= await resolveConfigKeyChannel(this._objectFactory, this.logger);
    }

    /** Whether the rollout check is wanted: `config_encryption:plugin_secrets:wait_for_rollout` isn't false (or `0`). */
    protected get rolloutWanted(): boolean {
        const value: string = String(this.waitForRollout).trim().toLowerCase();
        return value !== "false" && value !== "0";
    }

    /**
     * Encrypts every plaintext plugin secret setting once the server's rollout has finished, and records the first completed run. Never throws: what goes wrong
     * is logged, and the next start tries again.
     */
    public async run(): Promise<PluginSecretEncryptionResult> {
        const result: PluginSecretEncryptionResult = { encrypted: [], dropped: [], remaining: [], completed: false };
        try {
            await this.attempt(result);
        } catch (err: any) {
            this.logger?.warn(`PluginSecretEncryptor: the plugin secret settings are not encrypted on this start: ${err?.message}`);
            // A datastore that can't be read or written is likely to recover: the loop asks again rather than leave the secrets in plaintext until the next start.
            result.waiting = "The plugin secret settings could not be read or saved; it is tried again.";
        }
        return result;
    }

    /**
     * `run()`, repeated every `intervalMs` (30 s) while it waits - for the rollout, for another copy's lock, for a datastore that failed to answer - until a run
     * completes. Returns that run's result, or the last when aborted or when a run ends without waiting for anything (a row that couldn't be saved is for the
     * next start, not for a loop).
     */
    public async runUntilEncrypted(options: PluginSecretEncryptionOptions = {}): Promise<PluginSecretEncryptionResult> {
        for (;;) {
            const result: PluginSecretEncryptionResult = await this.run();
            if (result.completed || result.waiting === undefined || options.signal?.aborted) {
                return result;
            }
            await pause(options.intervalMs ?? DEFAULT_PLUGIN_SECRET_CHECK_INTERVAL_MS, options.signal);
            if (options.signal?.aborted) {
                return result;
            }
        }
    }

    private async attempt(result: PluginSecretEncryptionResult): Promise<void> {
        const cipher: ConfigCipher | undefined = this.cipher;
        if (!cipher) {
            result.waiting = "No configuration cipher is registered on this server, so plugin secret settings can't be encrypted.";
            return;
        }
        const state: S | undefined = await this.loadState();
        const done: boolean = !!state?.pluginSecrets?.encryptedAt;
        result.completed = done;
        if (!done && this.rolloutWanted) {
            const rollout: RolloutStatus = await this.checkRollout();
            if (!rollout.rolledOut) {
                result.waiting = rollout.reason ?? "Pods of an older release are still running.";
                await this.recordWaiting(state, result.waiting);
                return;
            }
        }
        let lock: ConfigKeyLock | undefined;
        if (this.channel) {
            try {
                lock = await this.channel.acquireLock(LOCK_TTL_MS);
            } catch (err: any) {
                this.logger?.warn(`PluginSecretEncryptor: the lock can't be taken (${err?.message}); the plugin secret settings wait.`);
                result.waiting = "The lock that lets one server copy work at a time can't be taken.";
                return;
            }
            if (!lock) {
                result.waiting = "Another server copy is encrypting the plugin secret settings.";
                return;
            }
        }
        try {
            await this.encryptRows(cipher, result);
            if (!done && result.remaining.length === 0) {
                result.completed = await this.recordEncrypted();
                if (result.completed) {
                    // A save that read the state row before `encryptedAt` was set stored its secret in plaintext, perhaps after this run passed its row: one more
                    // pass finds it. (Later saves see `encryptedAt` and encrypt.)
                    await this.encryptRows(cipher, result);
                } else {
                    result.waiting = "The key state could not be saved; it is tried again.";
                }
            }
        } finally {
            await lock?.release().catch(() => undefined);
        }
        if (result.encrypted.length + result.dropped.length > 0) {
            this.logger?.info(
                `PluginSecretEncryptor: encrypted ${result.encrypted.length} plugin secret setting(s), removed ${result.dropped.length} of uninstalled plugins.`,
            );
        }
    }

    /** Asks the rollout check. One that can't tell (rejects) counts as unfinished, logged once. */
    private async checkRollout(): Promise<RolloutStatus> {
        try {
            const status: RolloutStatus = await this.rolloutCheck!.check();
            this.lastRolloutError = undefined;
            return status;
        } catch (err: any) {
            if (err?.message !== this.lastRolloutError) {
                this.lastRolloutError = err?.message;
                this.logger?.warn(`PluginSecretEncryptor: the rollout can't be checked, so the plugin secret settings wait: ${err?.message}`);
            }
            return { rolledOut: false, reason: "The server's pods can't be listed, so the rollout isn't known to be finished." };
        }
    }

    private async loadState(): Promise<S | undefined> {
        return (await this.stateRepo!.findOne(CONFIG_KEY_STATE_UID, { ignoreACL: true, skipCache: true })) ?? undefined;
    }

    /**
     * Saves `build(state)` on the key state row, creating the row when there is none, in one versioned write; a write that lost to another is built again from
     * the row that won (at most `MAX_ATTEMPTS` times). `build` answers nothing when there is nothing to write. Returns whether the row holds what `build` wanted;
     * a failure is logged, not thrown.
     */
    private async saveState(build: (state: S | undefined) => Partial<ConfigKeyState> | undefined): Promise<boolean> {
        try {
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                const state: S | undefined = await this.loadState();
                const patch: Partial<ConfigKeyState> | undefined = build(state);
                if (!patch) {
                    return true;
                }
                try {
                    if (state) {
                        await this.stateRepo!.update({ uid: state.uid, version: state.version, ...patch } as any, asEntity(this.stateRepo!, state), { ignoreACL: true });
                    } else {
                        await this.stateRepo!.create(new this.configKeyStateClass({ uid: CONFIG_KEY_STATE_UID, ...patch }), { ignoreACL: true });
                    }
                    return true;
                } catch (err: any) {
                    if (!isStaleVersionError(err) && err?.status !== 409 && !isDuplicateKeyError(err)) {
                        throw err;
                    }
                }
            }
            this.logger?.warn("PluginSecretEncryptor: the key state could not be saved because other writes kept changing it; it is tried again on the next start.");
        } catch (err: any) {
            this.logger?.warn(`PluginSecretEncryptor: the key state could not be saved: ${err?.message}`);
        }
        return false;
    }

    /** Records on the key state row why the run waits, unless it already says so (checked within the last few minutes). */
    private async recordWaiting(known: S | undefined, reason: string): Promise<void> {
        const same = (state: S | undefined): boolean => {
            const recorded = state?.pluginSecrets;
            const checkedAt: number = recorded?.checkedAt ? new Date(recorded.checkedAt).getTime() : NaN;
            return recorded?.waitingForRollout === true && recorded.reason === reason && Date.now() - checkedAt < WAITING_RECORD_REFRESH_MS;
        };
        if (same(known)) {
            return;
        }
        // Never over an `encryptedAt` another copy recorded meanwhile: once set, it stays.
        await this.saveState((state) => (same(state) || state?.pluginSecrets?.encryptedAt ? undefined : { pluginSecrets: { waitingForRollout: true, checkedAt: new Date(), reason } }));
    }

    /** Records the first completed run (`encryptedAt`); a run another copy recorded meanwhile is left as it is. */
    private async recordEncrypted(): Promise<boolean> {
        return await this.saveState((state) =>
            state?.pluginSecrets?.encryptedAt ? undefined : { pluginSecrets: { encryptedAt: new Date(), waitingForRollout: false, checkedAt: new Date() } },
        );
    }

    /** Encrypts the plaintext secrets of every row. Throws when the rows can't be read. */
    private async encryptRows(cipher: ConfigCipher, result: PluginSecretEncryptionResult): Promise<void> {
        // Every row, page by page: a plugin past the first page would otherwise keep its secrets in plaintext.
        const rows: T[] = await findAllRows<T>(this.pluginRepo!);
        for (const row of rows) {
            if (plaintextSecretKeys(row).length > 0) {
                await this.encryptRow(cipher, row, result);
            }
        }
    }

    /** Encrypts one row's plaintext secrets, reading the row again after a write that lost to another (at most `MAX_ATTEMPTS` times). */
    private async encryptRow(cipher: ConfigCipher, first: T, result: PluginSecretEncryptionResult): Promise<void> {
        let row: T | undefined = first;
        for (let attempt = 1; row; attempt++) {
            const keys: string[] = plaintextSecretKeys(row);
            if (keys.length === 0) {
                return;
            }
            try {
                const settings: Record<string, PluginSettingValue> = { ...row.settings };
                for (const key of keys) {
                    if (row.removed) {
                        delete settings[key];
                    } else {
                        settings[key] = cipher.encrypt(settings[key] as string | number | boolean, pluginSecretContext(row.uid, key));
                    }
                }
                await this.pluginRepo!.update({ uid: row.uid, version: row.version, settings } as any, asEntity(this.pluginRepo!, row), { ignoreACL: true });
            } catch (err: any) {
                let reason: string | undefined = err?.message;
                if (isStaleVersionError(err) && attempt < MAX_ATTEMPTS) {
                    // Another replica (or an administrator) changed the row meanwhile: what it holds now decides what is left to encrypt.
                    try {
                        row = (await this.pluginRepo!.findOne(first.uid, { ignoreACL: true, skipCache: true })) ?? undefined;
                        continue;
                    } catch (readErr: any) {
                        reason = readErr?.message;
                    }
                }
                this.logger?.warn(`PluginSecretEncryptor: the secret settings of plugin '${first.name}' are not encrypted on this start: ${reason}`);
                result.remaining.push(...keys.map((key) => ({ name: first.name, key })));
                return;
            }
            for (const key of keys) {
                (row.removed ? result.dropped : result.encrypted).push({ name: row.name, key });
                await this.audit(row, key);
            }
            return;
        }
    }

    /** Records one encrypted (or, for an uninstalled plugin, dropped) key. The change is already saved, so a failure here is only logged. */
    private async audit(row: T, key: string): Promise<void> {
        const details: Record<string, unknown> = { name: row.name, key, ...(row.removed ? { dropped: true } : {}) };
        try {
            await this.auditLogUtils?.record({ action: AuditAction.PLUGIN_SECRET_MIGRATED, targetType: "Plugin", targetUid: row.uid, details });
        } catch (err: any) {
            this.logger?.warn(`PluginSecretEncryptor: the encryption of '${key}' of plugin '${row.name}' could not be audited: ${err?.message}`);
        }
    }
}
