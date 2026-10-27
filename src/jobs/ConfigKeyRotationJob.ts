///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import {
    AuditAction,
    ConfigEnvelope,
    ConfigKeyReencryption,
    ConfigKeyRotation,
    ConfigKeyState,
    ConfigKeyUnreadableEnvelope,
} from "../models/types.js";
import { ConfigCipher, ConfigSecretUnavailableError } from "../secrets/ConfigCipher.js";
import { ConfigEnvelopeSource, ConfigEnvelopeSourceRegistry } from "../secrets/ConfigEnvelopeSource.js";
import { ConfigKeyChannel, ConfigKeyHeartbeatEntry, ConfigKeyLock, resolveConfigKeyChannel } from "../secrets/ConfigKeyChannel.js";
import { CONFIG_KEY_STATE_UID, ConfigKeyEntry, ConfigKeyring, generateConfigKey } from "../secrets/ConfigKeyring.js";
import {
    ConfigKeyringConflictError,
    ConfigKeyringInvalidError,
    ConfigKeyringSnapshot,
    ConfigKeyringStore,
    resolveConfigKeyringStore,
} from "../secrets/ConfigKeyringStore.js";
import { AuditLogUtils } from "../util/AuditLogUtils.js";
import { configNumber, rotationDate } from "../util/DkimRotationUtils.js";
import { asEntity } from "../util/EntityUtils.js";
const { Config, Destroy, Inject, Init, Logger } = ObjectDecorators;

/** `config_encryption:rotation:schedule`'s default: every 30 seconds. A run with no rotation in progress reads one row and returns. */
export const DEFAULT_CONFIG_KEY_ROTATION_SCHEDULE = "*/30 * * * * *";
/** Rows per page of a re-encryption pass (`config_encryption:reencrypt:batch_size`). */
export const DEFAULT_CONFIG_REENCRYPT_BATCH_SIZE = 100;
/** How long a new key may wait for a server copy before the warning (`config_encryption:activation:warn_minutes`). */
export const DEFAULT_CONFIG_KEY_WARN_MINUTES = 15;
/** The most envelopes a pass names as unreadable in `ConfigKeyState.reencryption.unreadable`, so a restore with an older keyring can't make the row huge. */
export const MAX_UNREADABLE_LISTED = 50;
/** The most rows a stuck pass names in the rotation's `lastError`. */
const MAX_FAILED_LISTED = 5;

/** How long the lock lasts if its holder never releases it. A run that outlasts it is still safe: every write is version-checked. */
const LOCK_TTL_MS = 2 * 60 * 1000;
/** At most this many phase changes per run: adding, activating, re-encrypting and retiring can all happen in one, and nothing loops. */
const MAX_TRANSITIONS_PER_RUN = 6;
const MINUTE_MS = 60 * 1000;

/** The phases after which there is nothing left for the job to do. */
const FINISHED_PHASES: readonly string[] = ["done", "failed"];

/** What one pass over every registered record type found and did. */
interface ReencryptionPass {
    /** Envelopes per `kid` as the pass left them. */
    counts: Record<string, number>;
    /** Envelopes re-encrypted, per record type. */
    reencrypted: Record<string, number>;
    unreadable: ConfigKeyUnreadableEnvelope[];
    /** The rows whose update failed for a reason other than a lost race, as `<record> '<uid>'` (never a value), the first `MAX_FAILED_LISTED` of them. */
    failed: string[];
    /** Whether every row was seen and every change saved. */
    complete: boolean;
}

/** `value` when it is a positive number (or its text), else `fallback`. */
function positive(value: unknown, fallback: number): number {
    const parsed: number = configNumber(value, fallback);
    return parsed > 0 ? parsed : fallback;
}

/** Whether `a` and `b` hold the same names. */
function sameNames(a: readonly string[] | undefined, b: readonly string[]): boolean {
    return (a ?? []).length === b.length && (a ?? []).every((name, index) => name === b[index]);
}

/** `rotation` for its next state: what the step that follows has no use for - the last error, the copies waited on - is dropped, `changes` applied. */
function advance(rotation: ConfigKeyRotation, changes: Partial<ConfigKeyRotation>): ConfigKeyRotation {
    const { lastError: _error, waitingFor: _waiting, ...kept } = rotation;
    return { ...kept, ...changes };
}

/**
 * Rotates the configuration encryption key (spec 5.5), driving `ConfigKeyState.rotation` through its phases, every `config_encryption:rotation:schedule` (30 s)
 * and at once on the notice `rapidmx:config-keys:changed`, on every replica under a lock in Redis so one copy acts at a time. Each step is recorded before the
 * next, so another copy can take over after a restart, and every write is version-checked, so two copies that do act at once can't both win:
 *
 * 1. **adding.** Generates the key (32 random bytes, an 8-hex `kid`), reads the keyring with its version through the `ConfigKeyringStore`, adds it and writes it
 * back with that version (`CONFIG_KEY_ROTATED`). A key already in the ring that is newer than the request is the one a copy that crashed before recording it had
 * added, and is taken up instead of a second. A refused write is shown as `lastError` and retried; a ring that can't be parsed fails the rotation.
 * 2. **activating.** Waits until every live heartbeat (`ConfigKeyHeartbeat`) lists the new key, naming the copies that don't (`waitingFor`, a warning in the log
 * after `config_encryption:activation:warn_minutes`), and never activates on a timeout, on silence or when the heartbeats can't be read. Then sets
 * `ConfigKeyState.activeKid` (`CONFIG_KEY_ACTIVATED`). An administrator's "Activate anyway" does the same by hand (`BaseConfigKeyRoute`).
 * 3. **reencrypting.** Once every live heartbeat also reports encrypting with it (after "Activate anyway" that waits for the stale copies to go or load the key),
 * goes through every row of every registered record type (`sources`) page by page, re-encrypting each envelope on another key in one version-checked update of
 * its row; a row changed meanwhile is left for the next run, and an envelope that can't be decrypted stays as it is, counted under its key and named. A pass
 * records the counts per key on `ConfigKeyState` and audits `CONFIG_REENCRYPTED` when it changed anything.
 * 4. **retiring.** As soon as a complete pass left no envelope on a key but the active one, removes those from the ring with the same version-checked write
 * (`CONFIG_KEY_RETIRED`), for a compromised rotation exactly as for a normal one. A key an envelope still uses, the active key, and the last key are never
 * removed. Then `done`.
 *
 * A pass is one run, however many pages: a compromised rotation differs only in what it records and audits.
 *
 * Concrete entity classes are supplied by the Mongo/SQL subclasses (`ConfigKeyRotationJobMongo`/`ConfigKeyRotationJobSQL`), which register the record types'
 * envelope sources.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class ConfigKeyRotationJob<S extends ConfigKeyState> extends BackgroundService {
    protected abstract configKeyStateClass: any;

    /** Supplied by the Mongo/SQL subclasses so each step is recorded as an `AuditLogEntry`. */
    protected abstract auditLogClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    /** The record types whose rows hold envelopes (`ConfigEnvelopeSource`), which a pass re-encrypts and counts. */
    public sources: ConfigEnvelopeSourceRegistry = new ConfigEnvelopeSourceRegistry();

    protected stateRepo?: RepoUtils<S>;
    protected auditLogRepo?: RepoUtils<any>;
    protected auditLogUtils?: AuditLogUtils;
    protected keyringStore?: ConfigKeyringStore;
    protected channel?: ConfigKeyChannel;

    @Inject("ConfigCipher")
    protected cipher?: ConfigCipher;

    @Config("config_encryption:rotation:schedule", DEFAULT_CONFIG_KEY_ROTATION_SCHEDULE)
    private scheduleExpr: string = DEFAULT_CONFIG_KEY_ROTATION_SCHEDULE;

    /** Where a new ring is written (`config_encryption:keyring_store:backend`, spec 5.3): with `none` nothing rotates. */
    @Config("config_encryption:keyring_store:backend", "none")
    protected keyringBackend: string = "none";

    @Config("config_encryption:reencrypt:batch_size", DEFAULT_CONFIG_REENCRYPT_BATCH_SIZE)
    protected batchSize: unknown = DEFAULT_CONFIG_REENCRYPT_BATCH_SIZE;

    @Config("config_encryption:activation:warn_minutes", DEFAULT_CONFIG_KEY_WARN_MINUTES)
    protected warnMinutes: unknown = DEFAULT_CONFIG_KEY_WARN_MINUTES;

    @Logger
    protected logger: any;

    /** Whether a run is under way in this process, so a notice that arrives meanwhile doesn't start a second. */
    private running: boolean = false;
    private stopListening?: () => Promise<void>;
    /** The key a late-activation warning was already logged for. */
    private warnedKid?: string;
    private readonly sourceRepos: Map<string, RepoUtils<any>> = new Map();

    public get schedule(): string | undefined {
        return this.scheduleExpr;
    }

    /** Where the Mongo/SQL subclasses register the record types' envelope sources (`registry.register()`): the DNS provider configs' since restapi's step R2,
     * the integration settings' since R3, the plugins' since R4 (`pluginEnvelopeSource()`). */
    protected registerSources(_registry: ConfigEnvelopeSourceRegistry): void {
        // A job over no record type that holds an envelope has nothing to count or re-encrypt.
    }

    @Init
    public async init(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.stateRepo && this.configKeyStateClass) {
            this.stateRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.configKeyStateClass.name, args: [this.configKeyStateClass] });
        }
        if (!this.auditLogRepo && this.auditLogClass) {
            this.auditLogRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.auditLogClass.name, args: [this.auditLogClass] });
        }
        if (!this.auditLogUtils && this.auditLogClass) {
            this.auditLogUtils = await this._objectFactory.newInstance(AuditLogUtils, { name: this.auditLogClass.name, args: [this.auditLogRepo] });
        }
        this.keyringStore ??= await resolveConfigKeyringStore(this._objectFactory, this.keyringBackend, this.logger);
        this.channel ??= await resolveConfigKeyChannel(this._objectFactory, this.logger);
        this.registerSources(this.sources);
        await this.subscribe();
    }

    /** Runs the job as soon as a rotation notice arrives, instead of at the next schedule. Replaces an earlier subscription. */
    public async subscribe(): Promise<void> {
        await this.stopListening?.().catch(() => undefined);
        if (!this.channel) {
            return;
        }
        this.stopListening = await this.channel.onChanged(() => void this.run()).catch((err: any) => {
            this.logger?.warn(`ConfigKeyRotationJob: the rotation notice can't be heard (${err?.message}); the schedule picks up a rotation instead.`);
            return undefined;
        });
    }

    /** Stops listening for notices. Also run by the ObjectFactory when it destroys this instance. */
    @Destroy
    public async dispose(): Promise<void> {
        const stop: (() => Promise<void>) | undefined = this.stopListening;
        this.stopListening = undefined;
        await stop?.().catch(() => undefined);
    }

    public async start(): Promise<void> {
        // Nothing to do at startup beyond `init()` above; processing happens entirely in `run()`.
    }

    public stop(): Promise<void> | void {
        // Do nothing
    }

    /**
     * One run: nothing unless a rotation is in progress and this copy gets the lock, then as many steps as can follow one another. Never throws: a failure is
     * logged and the schedule goes on.
     */
    public async run(): Promise<void> {
        if (this.running || !this.stateRepo || !this.cipher || !this.keyringStore || !this.channel) {
            return;
        }
        this.running = true;
        try {
            const state: S | undefined = await this.loadState();
            if (!state?.rotation || FINISHED_PHASES.includes(state.rotation.phase)) {
                return;
            }
            let lock: ConfigKeyLock | undefined;
            try {
                lock = await this.channel.acquireLock(LOCK_TTL_MS);
            } catch (err: any) {
                this.logger?.warn(`ConfigKeyRotationJob: the lock can't be taken (${err?.message}); the rotation waits.`);
                return;
            }
            if (!lock) {
                return;
            }
            try {
                await this.advanceRotation();
            } finally {
                await lock.release().catch(() => undefined);
            }
        } catch (err: any) {
            this.logger?.warn(`ConfigKeyRotationJob: the configuration key rotation could not move on: ${err?.message}`);
        } finally {
            this.running = false;
        }
    }

    private async loadState(): Promise<S | undefined> {
        return (await this.stateRepo!.findOne(CONFIG_KEY_STATE_UID, { ignoreACL: true, skipCache: true })) ?? undefined;
    }

    /** Takes the rotation as far as it can go now, one phase at a time from a fresh read. A lost race is another copy having moved it. */
    private async advanceRotation(): Promise<void> {
        try {
            for (let i = 0; i < MAX_TRANSITIONS_PER_RUN; i++) {
                const state: S | undefined = await this.loadState();
                if (!state?.rotation || !(await this.step(state, state.rotation))) {
                    return;
                }
            }
        } catch (err: any) {
            if (err?.status === 409) {
                this.logger?.debug(`ConfigKeyRotationJob: the key state was changed by another writer; it is looked at again on the next run.`);
                return;
            }
            throw err;
        }
    }

    /** One transition, `true` when another may follow at once. */
    private async step(state: S, rotation: ConfigKeyRotation): Promise<boolean> {
        switch (rotation.phase) {
            case "adding":
                return await this.stepAdding(state, rotation);
            case "activating":
                return await this.stepActivating(state, rotation);
            case "reencrypting":
                return await this.stepReencrypting(state, rotation);
            case "retiring":
                return await this.stepRetiring(state, rotation);
            default:
                return false;
        }
    }

    /** Saves `patch` on the state as one versioned update: a write racing another fails with a 409. */
    private async saveState(state: S, patch: Partial<ConfigKeyState>): Promise<S> {
        return await this.stateRepo!.update({ uid: state.uid, version: state.version, ...patch } as any, asEntity(this.stateRepo!, state), {
            version: state.version,
            ignoreACL: true,
        });
    }

    private async audit(action: AuditAction, details: Record<string, unknown>): Promise<void> {
        await this.auditLogUtils?.record({ action, targetType: "ConfigKeyState", targetUid: CONFIG_KEY_STATE_UID, details });
    }

    /** Tells every copy to look again. Never throws: the rotation is saved, and every copy looks again within a minute anyway. */
    private async announce(): Promise<void> {
        try {
            await this.channel!.notifyChanged();
        } catch (err: any) {
            this.logger?.warn(`ConfigKeyRotationJob: the rotation notice can't be sent (${err?.message}); copies pick the change up within a minute.`);
        }
    }

    /** Shows `message` as the rotation's `lastError`, once: the step is retried on the next run. Returns `false`, the step's "nothing more now". */
    private async recordError(state: S, rotation: ConfigKeyRotation, message: string): Promise<false> {
        if (rotation.lastError !== message) {
            this.logger?.warn(`ConfigKeyRotationJob: ${message}`);
            await this.saveState(state, { rotation: { ...rotation, lastError: message } });
        }
        return false;
    }

    /** Ends the rotation as failed: a keyring that can't be parsed is not something retrying fixes. */
    private async fail(state: S, rotation: ConfigKeyRotation, message: string): Promise<false> {
        this.logger?.warn(`ConfigKeyRotationJob: the rotation failed: ${message}`);
        await this.saveState(state, { rotation: advance(rotation, { phase: "failed", lastError: message, finishedAt: new Date() }) });
        return false;
    }

    /** The keyring with its version, or `undefined` after recording why not (a keyring that can't be read is retried; one that can't be parsed fails the rotation). */
    private async readRing(state: S, rotation: ConfigKeyRotation): Promise<ConfigKeyringSnapshot | undefined> {
        try {
            return await this.keyringStore!.read();
        } catch (err: any) {
            if (err instanceof ConfigKeyringInvalidError) {
                await this.fail(state, rotation, err.message);
            } else {
                await this.recordError(state, rotation, `The keyring can't be read: ${err?.message}`);
            }
            return undefined;
        }
    }

    /** Writes `keyring` over the ring read at `version`. `true` when it was written; otherwise why not is recorded and the step is retried. */
    private async writeRing(state: S, rotation: ConfigKeyRotation, keyring: ConfigKeyring, version: string): Promise<boolean> {
        try {
            await this.keyringStore!.write(keyring, version);
            return true;
        } catch (err: any) {
            await this.recordError(state, rotation, err instanceof ConfigKeyringConflictError ? err.message : `The keyring can't be updated: ${err?.message}`);
            return false;
        }
    }

    /** Step 1: puts the new key in the keyring and records it. */
    private async stepAdding(state: S, rotation: ConfigKeyRotation): Promise<boolean> {
        const snapshot: ConfigKeyringSnapshot | undefined = await this.readRing(state, rotation);
        if (!snapshot) {
            return false;
        }
        const requestedAt: number = rotationDate(rotation.requestedAt)?.getTime() ?? Date.now();
        // A key made after the request is this rotation's own: a copy wrote it and stopped before recording it.
        const own: ConfigKeyEntry | undefined = snapshot.keyring.keys.filter((key) => Date.parse(key.createdAt) >= requestedAt).pop();
        let added: ConfigKeyEntry;
        if (own) {
            added = own;
        } else {
            // A kid the ring already has (one in four billion) makes the store refuse the ring, and the next run makes another.
            added = generateConfigKey(new Date(Math.max(Date.now(), requestedAt)));
            if (!(await this.writeRing(state, rotation, { keys: [...snapshot.keyring.keys, added] }, snapshot.version))) {
                return false;
            }
        }
        await this.saveState(state, {
            rotation: advance(rotation, {
                kid: added.kid,
                previousKids: snapshot.keyring.keys.filter((key) => key.kid !== added.kid).map((key) => key.kid),
                phase: "activating",
                activationStartedAt: new Date(),
            }),
        });
        await this.audit(AuditAction.CONFIG_KEY_ROTATED, { kid: added.kid, reason: rotation.compromised ? "compromised" : "manual" });
        await this.announce();
        return true;
    }

    /** The live heartbeats, or `undefined` after recording why a rotation can't go on without them. Never an empty list: no report is not a yes. */
    private async liveCopies(state: S, rotation: ConfigKeyRotation, goingOn: string): Promise<ConfigKeyHeartbeatEntry[] | undefined> {
        let beats: ConfigKeyHeartbeatEntry[];
        try {
            beats = await this.channel!.heartbeats();
        } catch (err: any) {
            await this.recordError(state, rotation, `The server copies' heartbeats can't be read (${err?.message}); ${goingOn}`);
            return undefined;
        }
        if (beats.length === 0) {
            await this.recordError(state, rotation, `No server copy is reporting the keys it has loaded yet; ${goingOn}`);
            return undefined;
        }
        return beats;
    }

    /** Shows the copies still to load or use the key, writing only when the list changed. Returns `false`. */
    private async setWaiting(state: S, rotation: ConfigKeyRotation, waiting: string[]): Promise<false> {
        if (!sameNames(rotation.waitingFor, waiting) || rotation.lastError) {
            await this.saveState(state, { rotation: advance(rotation, { waitingFor: waiting }) });
        }
        return false;
    }

    /** Warns once, in the log, that the new key has waited past `warn_minutes` for `waiting` (the console shows the same from the state). */
    private warnIfLate(rotation: ConfigKeyRotation, waiting: string[]): void {
        const started: Date | undefined = rotationDate(rotation.activationStartedAt);
        const limit: number = positive(this.warnMinutes, DEFAULT_CONFIG_KEY_WARN_MINUTES);
        if (!started || !rotation.kid || this.warnedKid === rotation.kid || Date.now() - started.getTime() < limit * MINUTE_MS) {
            return;
        }
        this.warnedKid = rotation.kid;
        this.logger?.warn(
            `ConfigKeyRotationJob: the new configuration key ${rotation.kid} has waited more than ${limit} minutes for ${waiting.join(", ")} to load it. ` +
                "The usual cause is a node whose kubelet hasn't refreshed the keyring Secret (or, with OpenBao, External Secrets not syncing); restarting these pods resolves it.",
        );
    }

    /** Step 2: activates the new key once every live copy has loaded it. */
    private async stepActivating(state: S, rotation: ConfigKeyRotation): Promise<boolean> {
        const kid: string | undefined = rotation.kid;
        if (!kid) {
            return await this.fail(state, rotation, "The rotation has no new key recorded.");
        }
        const beats: ConfigKeyHeartbeatEntry[] | undefined = await this.liveCopies(state, rotation, "the new key isn't activated until they are.");
        if (!beats) {
            return false;
        }
        const waiting: string[] = beats.filter((beat) => !beat.kids.includes(kid)).map((beat) => beat.copy).sort();
        if (waiting.length > 0) {
            this.warnIfLate(rotation, waiting);
            return await this.setWaiting(state, rotation, waiting);
        }
        await this.saveState(state, {
            activeKid: kid,
            rotation: advance(rotation, {
                phase: "reencrypting",
                activatedAt: new Date(),
                waitingFor: beats.filter((beat) => beat.encrypting !== kid).map((beat) => beat.copy).sort(),
            }),
        });
        await this.audit(AuditAction.CONFIG_KEY_ACTIVATED, { kid, copies: beats.length });
        await this.announce();
        return true;
    }

    /** Step 3: re-encrypts every envelope to the active key, once no live copy can still write with another or fail to read it. */
    private async stepReencrypting(state: S, rotation: ConfigKeyRotation): Promise<boolean> {
        const kid: string | undefined = rotation.kid;
        if (!kid || state.activeKid !== kid) {
            return await this.fail(state, rotation, "The rotation's new key isn't the active key.");
        }
        const beats: ConfigKeyHeartbeatEntry[] | undefined = await this.liveCopies(state, rotation, "no value is re-encrypted until they are.");
        if (!beats) {
            return false;
        }
        const waiting: string[] = beats.filter((beat) => !beat.kids.includes(kid) || beat.encrypting !== kid).map((beat) => beat.copy).sort();
        if (waiting.length > 0) {
            return await this.setWaiting(state, rotation, waiting);
        }
        // This process's own cipher must have the new ring and active kid before it writes with them.
        await this.cipher!.reload();
        if (this.cipher!.currentKid() !== kid) {
            return await this.recordError(state, rotation, "This server copy can't encrypt with the new key yet; no value is re-encrypted until it can.");
        }

        const startedAt: Date = new Date();
        let pass: ReencryptionPass;
        try {
            pass = await this.reencryptAll(kid);
        } catch (err: any) {
            // Shown to the administrator too: a rotation that stays in 're-encrypting' with no word is one nobody can act on.
            return await this.recordError(state, rotation, `A re-encryption pass could not finish and is retried: ${err?.message}`);
        }
        const previous: ConfigKeyReencryption | null | undefined = state.reencryption;
        const reencryption: ConfigKeyReencryption = {
            targetKid: kid,
            complete: pass.complete,
            startedAt: previous && previous.targetKid === kid && previous.complete === false ? previous.startedAt : startedAt,
            ...(pass.complete ? { finishedAt: new Date() } : {}),
            ...(pass.unreadable.length > 0 ? { unreadable: pass.unreadable } : {}),
        };
        await this.saveState(state, {
            kidUsage: pass.counts,
            countedAt: new Date(),
            reencryption,
            rotation: advance(rotation, {
                phase: pass.complete ? "retiring" : "reencrypting",
                ...(pass.failed.length > 0
                    ? {
                          lastError:
                              `Re-encryption could not save ${pass.failed.join(", ")}${pass.failed.length >= MAX_FAILED_LISTED ? " and maybe more" : ""}; ` +
                              "it is retried on every run, and the pod log says why.",
                      }
                    : {}),
            }),
        });
        if (Object.values(pass.reencrypted).some((count) => count > 0)) {
            await this.audit(AuditAction.CONFIG_REENCRYPTED, { targetKid: kid, counts: pass.reencrypted });
        }
        return pass.complete;
    }

    /** The repository of `source`'s model, built once. Public to the tests only through the cast they make. */
    protected async repoFor(source: ConfigEnvelopeSource): Promise<RepoUtils<any>> {
        let repo: RepoUtils<any> | undefined = this.sourceRepos.get(source.record);
        if (!repo) {
            repo = await this._objectFactory!.newInstance(RepoUtils, { name: source.modelClass.name, args: [source.modelClass] });
            this.sourceRepos.set(source.record, repo!);
        }
        return repo!;
    }

    /**
     * One pass over every row of every registered record type, page by page. The pages follow the `uid` after the last row of the one before, not an offset: a
     * row deleted or added meanwhile would shift an offset and skip a row, which would then be neither re-encrypted nor counted, and the old key it still uses
     * would be retired with the pass complete.
     */
    private async reencryptAll(target: string): Promise<ReencryptionPass> {
        const pass: ReencryptionPass = { counts: {}, reencrypted: {}, unreadable: [], failed: [], complete: true };
        const limit: number = Math.floor(positive(this.batchSize, DEFAULT_CONFIG_REENCRYPT_BATCH_SIZE));
        for (const source of this.sources.list()) {
            const repo: RepoUtils<any> = await this.repoFor(source);
            let last: string | undefined;
            for (;;) {
                const query: Record<string, unknown> = { sort: { uid: "ASC" }, limit, ...(last !== undefined ? { uid: `gt(${last})` } : {}) };
                const rows: any[] = await repo.find(query as any, { ignoreACL: true, limit, skipCache: true });
                for (const row of rows) {
                    await this.reencryptRow(source, repo, row, target, pass);
                }
                if (rows.length < limit) {
                    break;
                }
                last = rows[rows.length - 1].uid;
            }
        }
        return pass;
    }

    /** Re-encrypts the envelopes of `row` that aren't on `target`, in one version-checked update, and adds what it found to `pass`. */
    private async reencryptRow(source: ConfigEnvelopeSource, repo: RepoUtils<any>, row: any, target: string, pass: ReencryptionPass): Promise<void> {
        const count = (kid: string): void => {
            pass.counts[kid] = (pass.counts[kid] ?? 0) + 1;
        };
        const replacements: Record<string, ConfigEnvelope> = {};
        const replaced: string[] = [];
        for (const { field, envelope } of source.envelopes(row)) {
            if (envelope.kid === target) {
                count(target);
                continue;
            }
            const context = { record: source.record, uid: row.uid, field };
            let fresh: ConfigEnvelope | undefined;
            try {
                fresh = this.cipher!.encrypt(this.cipher!.decrypt(envelope, context), context);
            } catch (err: any) {
                if (!(err instanceof ConfigSecretUnavailableError)) {
                    throw err;
                }
                if (pass.unreadable.length < MAX_UNREADABLE_LISTED) {
                    pass.unreadable.push({ record: source.record, uid: row.uid, field, kid: envelope.kid });
                }
            }
            if (fresh && fresh.kid === target) {
                replacements[field] = fresh;
                replaced.push(envelope.kid);
            } else {
                count(envelope.kid);
            }
        }
        if (replaced.length === 0) {
            return;
        }
        try {
            await repo.update({ uid: row.uid, version: row.version, ...source.replace(row, replacements) } as any, asEntity(repo, row), {
                version: row.version,
                ignoreACL: true,
            });
        } catch (err: any) {
            // Left for the next run, counted under the key it still has: a row changed meanwhile is another writer's to win.
            pass.complete = false;
            replaced.forEach(count);
            if (err?.status === 409) {
                this.logger?.debug(`ConfigKeyRotationJob: ${source.record} '${row.uid}' was changed by another writer; it is re-encrypted on the next run.`);
            } else {
                if (pass.failed.length < MAX_FAILED_LISTED) {
                    pass.failed.push(`${source.record} '${row.uid}'`);
                }
                this.logger?.warn(`ConfigKeyRotationJob: ${source.record} '${row.uid}' could not be re-encrypted: ${err?.message}`);
            }
            return;
        }
        replaced.forEach(() => count(target));
        pass.reencrypted[source.record] = (pass.reencrypted[source.record] ?? 0) + replaced.length;
    }

    /** Step 4: removes the keys no envelope uses any more. */
    private async stepRetiring(state: S, rotation: ConfigKeyRotation): Promise<boolean> {
        const snapshot: ConfigKeyringSnapshot | undefined = await this.readRing(state, rotation);
        if (!snapshot) {
            return false;
        }
        const active: string | undefined = state.activeKid ?? undefined;
        const ring: string[] = snapshot.keyring.keys.map((key) => key.kid);
        if (!active || !ring.includes(active)) {
            return await this.recordError(state, rotation, `The active key ${active ? `'${active}' isn't in the keyring` : "isn't recorded"}, so no key was removed.`);
        }
        if (!state.kidUsage) {
            return await this.recordError(state, rotation, "The envelopes haven't been counted yet, so no key was removed.");
        }
        const usage: Record<string, number> = state.kidUsage;
        const others: string[] = ring.filter((kid) => kid !== active);
        const removable: string[] = others.filter((kid) => !(usage[kid] > 0));
        const retained: string[] = others.filter((kid) => usage[kid] > 0);
        if (removable.length > 0) {
            // The active key stays, so the ring is never left empty.
            if (!(await this.writeRing(state, rotation, { keys: snapshot.keyring.keys.filter((key) => !removable.includes(key.kid)) }, snapshot.version))) {
                return false;
            }
            for (const kid of removable) {
                await this.audit(AuditAction.CONFIG_KEY_RETIRED, { kid });
            }
            await this.announce();
        }
        await this.saveState(state, {
            rotation: advance(rotation, {
                phase: "done",
                finishedAt: new Date(),
                ...(retained.length > 0
                    ? {
                          lastError:
                              `${retained.length === 1 ? "The key" : "The keys"} ${retained.join(", ")} still encrypt${retained.length === 1 ? "s" : ""} secrets that can't be ` +
                              "decrypted, so they stay in the keyring; enter those secrets again to retire them.",
                      }
                    : {}),
            }),
        });
        return false;
    }
}
