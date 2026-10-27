///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The consuming application must apply `@Route("system/config-keys")` to its own concrete subclass (see `BaseKeyVaultRoute`'s identical note) - every
// method here is defined relative to that.
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ApiErrors, HttpRequest, HttpResponse, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import {
    AuditAction,
    ConfigKeyReencryption,
    ConfigKeyRotation,
    ConfigKeyRotationPhase,
    ConfigKeyState,
} from "../models/types.js";
import type { ConfigCipher, ConfigKeyInfo } from "../secrets/ConfigCipher.js";
import { ConfigKeyChannel, ConfigKeyHeartbeatEntry, resolveConfigKeyChannel } from "../secrets/ConfigKeyChannel.js";
import { CONFIG_KEY_STATE_UID } from "../secrets/ConfigKeyring.js";
import { ConfigKeyringStore, resolveConfigKeyringStore } from "../secrets/ConfigKeyringStore.js";
import { AuditLogUtils } from "../util/AuditLogUtils.js";
import { rotationDate } from "../util/DkimRotationUtils.js";
import { asEntity } from "../util/EntityUtils.js";
import { assertAdminScope, DEFAULT_ELEVATION_MAX_AGE_SECONDS } from "../util/MailAccessUtils.js";
import { assertNoPathKeys, isDuplicateKeyError } from "../util/RequestBodyUtils.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;
const { Get, Post, Request, RequiresTrustedRole, Response, User: AuthUser } = RouteDecorators;

/** How often a write that lost a race to another write of the key state is looked at again before it gives up with a 409. */
const MAX_ATTEMPTS = 3;
const MINUTE_MS = 60 * 1000;
/** The warning's wait, in minutes, when `config_encryption:activation:warn_minutes` doesn't say (the job's default too). */
const DEFAULT_WARN_MINUTES = 15;

/** The phases after which a new rotation may start. */
const FINISHED_PHASES: readonly ConfigKeyRotationPhase[] = ["done", "failed"];

/** One key of the ring as the console shows it, never its material. */
export interface PublicConfigKey extends ConfigKeyInfo {
    /** The envelopes on this key at the end of the last re-encryption pass; left out until a pass has counted. */
    envelopes?: number;
}

/** A rotation as the console shows it: `ConfigKeyRotation` plus the warning once a new key has waited too long for a copy. */
export interface PublicConfigKeyRotation extends ConfigKeyRotation {
    /** Why the new key is still not active, and what resolves it: set once `config_encryption:activation:warn_minutes` have passed with copies still missing. */
    warning?: string;
}

/** What `GET /` answers (and what the writes answer with): the keyring's state for the console, never key material. */
export interface PublicConfigKeys {
    /** Whether a rotation can be started: `config_encryption:keyring_store:backend` isn't `none`, its store is registered and, in production, so is the Redis channel. */
    available: boolean;
    /** The key this server copy encrypts with. */
    activeKid: string | null;
    keys: PublicConfigKey[];
    /** When the envelopes were last counted. */
    countedAt: Date | null;
    rotation: PublicConfigKeyRotation | null;
    reencryption: ConfigKeyReencryption | null;
    /** The plugin secret settings' encryption (spec 5.7). */
    pluginSecrets: ConfigKeyState["pluginSecrets"] | null;
}

/** What `POST /rotate` takes. */
export interface ConfigKeyRotateRequest {
    compromised?: unknown;
}

/** What `POST /activate` takes. */
export interface ConfigKeyActivateRequest {
    kid?: unknown;
}

/** `body` as an object of fields (none for no body), or a 400. */
function asRequest(body: unknown): Record<string, unknown> {
    if (body === undefined || body === null) {
        return {};
    }
    if (typeof body !== "object" || Array.isArray(body)) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The request body must be a JSON object.");
    }
    assertNoPathKeys(body);
    return body as Record<string, unknown>;
}

/**
 * The configuration keyring's console (spec 5.5, 10.5), mounted by the server at `system/config-keys`:
 *
 * - `GET /` the keys by `kid` with their age and envelope counts, which one encrypts, whether rotation is available, the current or last rotation with the
 * copies it is waiting for (and the warning once that has taken too long) and the plugin secret settings' encryption. A trusted role. Never key material.
 * - `POST /rotate` (`{ compromised?: boolean }`) starts a rotation (202): it only records the request, `ConfigKeyRotationJob` does the rest on every copy, at
 * once because of the notice sent here. One rotation at a time: another request while one runs is a 409 with its progress, except that `compromised: true`
 * marks the running normal rotation compromised (200). 503 when `config_encryption:keyring_store:backend` is `none` (a keyring given inline can't be
 * changed), when the keyring can't be read from its store (a first read is the check that the rotation could ever write it) and, in production, when no Redis
 * channel is registered to coordinate the server copies. Audited `CONFIG_KEY_ROTATION_REQUESTED`.
 * - `POST /activate` (`{ kid }`) is "Activate anyway": it activates the rotation's new key at once, before every copy has loaded it, for an administrator who
 * knows a stale copy is being replaced. 409 unless that rotation is `activating` and `kid` is its key. Re-encryption still waits for the stale copies to go
 * or load the key. Audited `CONFIG_KEY_ACTIVATION_FORCED` with the copies that hadn't loaded it.
 *
 * **Access:** a trusted role for reads; a trusted role AND an elevated token (`assertAdminScope()`) for both writes.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseConfigKeyRoute<S extends ConfigKeyState> {
    protected abstract configKeyStateClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so this route can persist an `AuditLogEntry` without depending on either backend directly. */
    protected abstract auditLogClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    @Config("trusted_roles", ["admin"])
    protected trustedRoles: string[] = ["admin"];

    /** How old an elevated token may be before it has to be elevated again, in seconds (`mail:security:elevation_max_age_seconds`, 0 = no limit). */
    @Config("mail:security:elevation_max_age_seconds", DEFAULT_ELEVATION_MAX_AGE_SECONDS)
    protected elevationMaxAgeSeconds: number = DEFAULT_ELEVATION_MAX_AGE_SECONDS;

    @Config("config_encryption:keyring_store:backend", "none")
    protected keyringBackend: string = "none";

    @Config("config_encryption:activation:warn_minutes", DEFAULT_WARN_MINUTES)
    protected warnMinutes: unknown = DEFAULT_WARN_MINUTES;

    @Inject("ConfigCipher")
    protected cipher?: ConfigCipher;

    @Logger
    protected logger: any;

    protected stateRepo?: RepoUtils<S>;
    protected auditLogRepo?: RepoUtils<any>;
    protected auditLogUtils?: AuditLogUtils;
    /** Where a rotation writes the new ring; `undefined` when it can't (`none`): rotation is then refused with 503. */
    protected keyringStore?: ConfigKeyringStore;
    /** How the server copies are coordinated; `undefined` in production without a registered channel: rotation is then refused with 503. */
    protected channel?: ConfigKeyChannel;

    @Init
    protected async initialize(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.stateRepo && this.configKeyStateClass) {
            this.stateRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.configKeyStateClass.name, args: [this.configKeyStateClass] });
        }
        if (!this.auditLogRepo && this.auditLogClass) {
            this.auditLogRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.auditLogClass.name, args: [this.auditLogClass] });
        }
        if (!this.auditLogUtils && this.auditLogRepo) {
            this.auditLogUtils = await this._objectFactory.newInstance(AuditLogUtils, { name: this.auditLogClass.name, args: [this.auditLogRepo] });
        }
        this.keyringStore ??= await resolveConfigKeyringStore(this._objectFactory, this.keyringBackend, this.logger);
        this.channel ??= await resolveConfigKeyChannel(this._objectFactory, this.logger);
    }

    private async loadState(): Promise<S | undefined> {
        return (await this.stateRepo!.findOne(CONFIG_KEY_STATE_UID, { ignoreACL: true, skipCache: true })) ?? undefined;
    }

    /** Saves `patch` on `state` as one versioned update: a write racing another fails with a 409. */
    private async saveState(state: S, patch: Partial<ConfigKeyState>, user?: JWTUser): Promise<S> {
        return await this.stateRepo!.update({ uid: state.uid, version: state.version, ...patch } as any, asEntity(this.stateRepo!, state), {
            user,
            version: state.version,
            ignoreACL: true,
        });
    }

    /** Tells every server copy to look again at the keyring and the rotation. Never throws: the request is saved, and the schedule finds it anyway. */
    private async announce(): Promise<void> {
        try {
            await this.channel!.notifyChanged();
        } catch (err: any) {
            this.logger?.warn(`The configuration key notice can't be sent (${err?.message}); the server copies pick the change up within 30 seconds.`);
        }
    }

    /** The heartbeats of the copies that are running, or none when they can't be read: what a forced activation records is then empty. */
    private async liveCopies(): Promise<ConfigKeyHeartbeatEntry[]> {
        try {
            return await this.channel!.heartbeats();
        } catch (err: any) {
            this.logger?.warn(`The server copies' heartbeats can't be read (${err?.message}).`);
            return [];
        }
    }

    private warning(rotation: ConfigKeyRotation): string | undefined {
        const started: Date | undefined = rotationDate(rotation.activationStartedAt);
        const minutes: number = Number(this.warnMinutes) > 0 ? Number(this.warnMinutes) : DEFAULT_WARN_MINUTES;
        if (rotation.phase !== "activating" || !rotation.waitingFor?.length || !started || Date.now() - started.getTime() < minutes * MINUTE_MS) {
            return undefined;
        }
        return (
            `The new key has waited more than ${minutes} minutes for ${rotation.waitingFor.join(", ")} to load it. The usual cause is a node whose kubelet hasn't ` +
            "refreshed the keyring Secret (or, with OpenBao, External Secrets not syncing); restarting the named pods resolves it."
        );
    }

    /** The console's view of `state`. */
    private async view(): Promise<PublicConfigKeys> {
        const state: S | undefined = await this.loadState();
        const usage: Record<string, number> | null | undefined = state?.kidUsage;
        const rotation: ConfigKeyRotation | null | undefined = state?.rotation;
        const warning: string | undefined = rotation ? this.warning(rotation) : undefined;
        return {
            available: this.keyringStore !== undefined && this.channel !== undefined,
            activeKid: this.cipher?.currentKid() ?? null,
            keys: (this.cipher?.keyInfo() ?? []).map((key) => ({ ...key, ...(usage ? { envelopes: usage[key.kid] ?? 0 } : {}) })),
            countedAt: state?.countedAt ?? null,
            rotation: rotation ? { ...rotation, ...(warning ? { warning } : {}) } : null,
            reencryption: state?.reencryption ?? null,
            pluginSecrets: state?.pluginSecrets ?? null,
        };
    }

    /** A 409 with the progress, as the spec asks for a request that can't be taken while another rotation is running. */
    private async busy(res: HttpResponse): Promise<HttpResponse> {
        res.status(409).json(await this.view());
        return res;
    }

    @RequiresTrustedRole()
    @Get()
    public async get(): Promise<PublicConfigKeys> {
        return await this.view();
    }

    /**
     * Starts a rotation, or marks the running one compromised. A write that loses a race to another is looked at again on the row that won, at most
     * `MAX_ATTEMPTS` times, which leaves the second of two simultaneous requests a 409 with the progress of the first.
     */
    @RequiresTrustedRole()
    @Post("/rotate")
    public async rotate(obj: ConfigKeyRotateRequest | undefined, @Request req: HttpRequest, @Response res: HttpResponse, @AuthUser user?: JWTUser): Promise<PublicConfigKeys | HttpResponse> {
        assertAdminScope(user, this.trustedRoles, this.elevationMaxAgeSeconds);
        const body: Record<string, unknown> = asRequest(obj);
        if (body.compromised !== undefined && typeof body.compromised !== "boolean") {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'compromised' must be true or false.");
        }
        const compromised: boolean = body.compromised === true;
        if (!this.keyringStore) {
            throw new ApiError(
                ApiErrors.INTERNAL_ERROR,
                503,
                "The configuration keyring can't be changed here (config_encryption:keyring_store:backend is none), so keys can't be rotated.",
            );
        }
        if (!this.channel) {
            throw new ApiError(
                ApiErrors.INTERNAL_ERROR,
                503,
                "The server copies can't be coordinated (no Redis channel is registered), so keys can't be rotated.",
            );
        }
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const state: S | undefined = await this.loadState();
            const running: ConfigKeyRotation | null | undefined = state?.rotation;
            if (state && running && !FINISHED_PHASES.includes(running.phase)) {
                if (!compromised || running.compromised) {
                    return await this.busy(res);
                }
                try {
                    await this.saveState(state, { rotation: { ...running, compromised: true } }, user);
                } catch (err: any) {
                    if (err?.status === 409) {
                        continue;
                    }
                    throw err;
                }
                await this.audit(req, user, AuditAction.CONFIG_KEY_ROTATION_REQUESTED, { compromised: true });
                await this.announce();
                return await this.view();
            }
            await this.assertKeyringReadable();
            const requested: ConfigKeyRotation = { previousKids: [], compromised, requestedBy: user!.uid, requestedAt: new Date(), phase: "adding" };
            try {
                if (state) {
                    await this.saveState(state, { rotation: requested }, user);
                } else {
                    await this.stateRepo!.create(new this.configKeyStateClass({ uid: CONFIG_KEY_STATE_UID, rotation: requested }), { user, ignoreACL: true });
                }
            } catch (err: any) {
                if (err?.status === 409 || isDuplicateKeyError(err)) {
                    continue;
                }
                throw err;
            }
            await this.audit(req, user, AuditAction.CONFIG_KEY_ROTATION_REQUESTED, { compromised });
            await this.announce();
            res.status(202).json(await this.view());
            return res;
        }
        return await this.busy(res);
    }

    /** A 503 naming why when the store can't give the keyring: a rotation recorded now could never add its key. The message never repeats the keyring. */
    private async assertKeyringReadable(): Promise<void> {
        try {
            await this.keyringStore!.read();
        } catch (err: any) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 503, `The configuration keyring can't be read from its store, so keys can't be rotated: ${err?.message}`);
        }
    }

    /** "Activate anyway": see the class comment. */
    @RequiresTrustedRole()
    @Post("/activate")
    public async activate(obj: ConfigKeyActivateRequest | undefined, @Request req: HttpRequest, @Response res: HttpResponse, @AuthUser user?: JWTUser): Promise<PublicConfigKeys | HttpResponse> {
        assertAdminScope(user, this.trustedRoles, this.elevationMaxAgeSeconds);
        const body: Record<string, unknown> = asRequest(obj);
        if (typeof body.kid !== "string" || body.kid.length === 0) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'kid' must be the new key's id.");
        }
        const kid: string = body.kid;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const state: S | undefined = await this.loadState();
            const rotation: ConfigKeyRotation | null | undefined = state?.rotation;
            if (!state || !rotation || rotation.phase !== "activating" || rotation.kid !== kid) {
                return await this.busy(res);
            }
            const beats: ConfigKeyHeartbeatEntry[] = await this.liveCopies();
            const stale: string[] = beats.filter((beat) => !beat.kids.includes(kid)).map((beat) => beat.copy).sort();
            const now: Date = new Date();
            const { lastError: _error, waitingFor: _waiting, ...kept } = rotation;
            try {
                await this.saveState(
                    state,
                    {
                        activeKid: kid,
                        rotation: {
                            ...kept,
                            phase: "reencrypting",
                            activatedAt: now,
                            waitingFor: beats.filter((beat) => !beat.kids.includes(kid) || beat.encrypting !== kid).map((beat) => beat.copy).sort(),
                            activationForced: { by: user!.uid, at: now, staleCopies: stale },
                        },
                    },
                    user,
                );
            } catch (err: any) {
                if (err?.status === 409) {
                    continue;
                }
                throw err;
            }
            await this.audit(req, user, AuditAction.CONFIG_KEY_ACTIVATION_FORCED, { kid, staleCopies: stale });
            await this.announce();
            return await this.view();
        }
        return await this.busy(res);
    }

    private async audit(req: HttpRequest, user: JWTUser | undefined, action: AuditAction, details: Record<string, unknown>): Promise<void> {
        await this.auditLogUtils!.record({ action, targetType: "ConfigKeyState", targetUid: CONFIG_KEY_STATE_UID, details }, { req, user });
    }
}
