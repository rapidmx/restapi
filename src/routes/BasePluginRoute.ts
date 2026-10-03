///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { Readable } from "stream";
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, HttpRequest, HttpResponse, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { createClient } from "redis";
import { BlobStore } from "../blob/BlobStore.js";
import { AuditLogUtils } from "../util/AuditLogUtils.js";
import { asEntity } from "../util/EntityUtils.js";
import { AuditAction, Plugin, PluginManifest, PluginSettingDefinition, PluginSource } from "../models/types.js";
import { inspectPack, PackInspection, PackInspectionError } from "../plugins/PackInspector.js";
import { discardSmallBody, parseContentLength } from "./BaseMailboxImportRoute.js";
import {
    DEFAULT_PLUGIN_REGISTRY,
    NpmRegistryClient,
    RegistryPackage,
    RegistryPackageVersion,
    RegistryRequestError,
    RegistrySearchResult,
} from "../plugins/NpmRegistryClient.js";
import {
    findDependents,
    findUnmetRequirements,
    PluginChangePlan,
    planPluginChange,
    PlannerRegistry,
    PlannedPluginChange,
    PlannedPluginInstall,
} from "../plugins/PluginDependencies.js";
import { findPluginUiMountConflicts } from "../plugins/PluginUiUtils.js";
import {
    computePluginStateHash,
    configuredPluginSettings,
    CORE_CONFIG_NAMESPACES,
    DEFAULT_ALLOWED_PLUGIN_PACKAGES,
    DEFAULT_PLUGIN_NAMESPACES,
    findPluginNamespace,
    isExactVersion,
    isNewerVersion,
    isPluginSettingKeyAllowed,
    isPrereleaseVersion,
    isValidPackageName,
    normalizeAllowedPackages,
    normalizePluginNamespaces,
    PluginNamespace,
    defaultPluginSettings,
    matchesAllowedPackage,
    parsePluginManifest,
    PLUGIN_CHANGED_EVENT,
    PLUGIN_EVENTS_CHANNEL,
    PLUGIN_STATUS_KEY,
    PLUGIN_STATUS_MAX_AGE_MS,
    PluginInstanceStatus,
    isSecretSettingKey,
    packIntegrity,
    pluginHostOfRequest,
    pluginUploadBlobKey,
    pickLatestVersion,
    resolveHostDefault,
    validatePluginSettings,
} from "../plugins/PluginUtils.js";
import { assertAdminScope, DEFAULT_ELEVATION_MAX_AGE_SECONDS } from "../util/MailAccessUtils.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;
const { Delete, Get, Param, Post, Put, Query, RateLimit, Request, RequiresTrustedRole, Response, StreamingBody, User: AuthUser } = RouteDecorators;

/** `system:plugins:uploads:max_bytes` default: the largest pack `POST /upload` accepts, 50 MiB (413 beyond). */
export const DEFAULT_MAX_PLUGIN_UPLOAD_BYTES: number = 50 * 1024 * 1024;

/** `upload()` is limited per user: each one is code every server copy loads, and up to `maxBytes` of memory while it is checked. */
const UPLOAD_MAX_ATTEMPTS: number = 10;
const UPLOAD_WINDOW_SECONDS: number = 3600;

/** The longest upload file name kept for display. */
const MAX_UPLOAD_FILENAME_LENGTH: number = 255;

/** What a row's upload fields are once it is a registry plugin again (a `null` clears the column in both databases). */
const REGISTRY_SOURCE_FIELDS: any = { source: "registry", uploadBlobKey: null, uploadFilename: null, uploadedAt: null, uploadedByUserUid: null };

/** A row's upload fields as they are now, for the undo of a change that clears or replaces them. */
function uploadFieldsOf(row: Plugin): any {
    return {
        source: row.source ?? null,
        uploadBlobKey: row.uploadBlobKey ?? null,
        uploadFilename: row.uploadFilename ?? null,
        uploadedAt: row.uploadedAt ?? null,
        uploadedByUserUid: row.uploadedByUserUid ?? null,
    };
}

/** What a row of a plugin uploaded as a pack is stored with. */
type UploadFields = Required<Pick<Plugin, "source" | "uploadBlobKey" | "uploadFilename" | "uploadedAt">> & Pick<Plugin, "uploadedByUserUid">;

/**
 * Reads a request body into one buffer, giving up with a `413` the moment more than `maxBytes` have arrived - never after the
 * whole body is in memory - and destroying the stream so the rest isn't read.
 */
async function readCapped(stream: Readable, maxBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
        const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > maxBytes) {
            stream.destroy();
            throw new ApiError(ApiErrors.INVALID_REQUEST, 413, `The uploaded pack is larger than the ${maxBytes} bytes allowed.`);
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}

/** The display name for an uploaded pack: its `filename` without any directory, control characters or excess length, or `undefined` when nothing is left. */
function sanitizeUploadFilename(filename: string): string | undefined {
    // eslint-disable-next-line no-control-regex
    const cleaned: string = (filename.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
    return cleaned.slice(0, MAX_UPLOAD_FILENAME_LENGTH) || undefined;
}

/** What an administrator saw a change would also install and enable when they confirmed it (from `GET /plan`). */
export interface PluginExpectedPlan {
    install: { name: string; version: string }[];
    enable: string[];
    /** The version of the plugin being changed that the preview showed (`GET /plan`'s `plugin.version`). */
    version?: string;
}

/** The body of `POST /` - `packageVersion` defaults to the registry's `latest`. */
export interface AddPluginRequest {
    name?: string;
    packageVersion?: string;
    /** When given, the add is refused with a `409` (changing nothing) unless it still installs and enables exactly
     * these other plugins. */
    expectedPlan?: PluginExpectedPlan;
}

/** The body of `PUT /:id`. `version` is the row's optimistic-lock counter, as everywhere else. */
export interface UpdatePluginRequest {
    version?: number;
    packageVersion?: string;
    enabled?: boolean;
    settings?: Record<string, unknown>;
    /** As `AddPluginRequest.expectedPlan`. */
    expectedPlan?: PluginExpectedPlan;
}

/** `GET /registry/:name` - a package's versions plus one version's details. */
export interface PluginRegistryLookup {
    package: RegistryPackage;
    selected: RegistryPackageVersion;
}

/** One result of `GET /search`. `version` is the latest published version. */
export interface PluginSearchResult extends RegistrySearchResult {
    /** Whether `system:plugins:allowed_packages` lets an administrator add this package. */
    allowed: boolean;
    /** The installed row's uid, when this package is already installed. */
    installedUid?: string;
    /** The installed version, when this package is already installed. */
    installedVersion?: string;
    /** Whether a newer version than the installed one is published. Never for a plugin installed from an uploaded pack. */
    updateAvailable: boolean;
    /** `"upload"` when the installed copy is an uploaded pack. */
    installedSource?: PluginSource;
}

/** One entry of `GET /updates`. */
export interface PluginUpdateInfo {
    uid: string;
    name: string;
    installedVersion: string;
    /** The registry's `latest` version, or `undefined` if the registry doesn't know the package. */
    latestVersion?: string;
    /** Whether a newer version is published that this plugin may be upgraded to. */
    updateAvailable: boolean;
    /** Whether `system:plugins:allowed_packages` still allows this plugin. One it doesn't can't be upgraded or
     * re-enabled, so it never reports `updateAvailable`. */
    allowed: boolean;
    /** Why the registry couldn't be checked for this plugin, if it couldn't. */
    error?: string;
    /** `"upload"` for a plugin installed from an uploaded pack: the registry isn't asked about it and it never reports an update. */
    source?: PluginSource;
}

/** `GET /plan` - what adding a package, or changing an installed plugin to a version, also installs and enables.
 * The change can't be made while `conflicts` isn't empty. */
export interface PluginPlanResponse extends PluginChangePlan {
    plugin: { name: string; version: string; manifest: PluginManifest };
}

/** The response of `POST /`: the added plugin, and the dependencies installed or enabled along with it. */
export interface AddPluginResponse<T extends Plugin = Plugin> {
    plugin: T;
    dependencies: T[];
}

/** `GET /status` - the hash every server copy should reach, and what each copy last reported. */
export interface PluginStatusResponse {
    hash: string;
    instances: PluginInstanceStatus[];
    /** Whether `POST /upload` is switched on (`system:plugins:uploads:enabled`) and the largest pack it accepts (`system:plugins:uploads:max_bytes`). */
    uploads: { enabled: boolean; maxBytes: number };
}

/** Undoes one write of a plugin change that failed part way. */
type PluginUndo = () => Promise<void>;

/**
 * The registry as one request reads it: each package's client is created once, and since a client keeps the packuments
 * it fetched, reading a package's versions and then one of them (as planning does) is a single registry request.
 */
class RegistrySession {
    private readonly clients: Map<string, NpmRegistryClient> = new Map();

    constructor(private readonly createClient: (name: string) => NpmRegistryClient) {}

    public getPackage(name: string): Promise<RegistryPackage | undefined> {
        return this.client(name).getPackage(name);
    }

    public getVersion(name: string, version: string): Promise<RegistryPackageVersion | undefined> {
        return this.client(name).getVersion(name, version);
    }

    private client(name: string): NpmRegistryClient {
        let client: NpmRegistryClient | undefined = this.clients.get(name);
        if (!client) {
            client = this.createClient(name);
            this.clients.set(name, client);
        }
        return client;
    }
}

/** Whether a setting is a secret, whose saved value is never sent to the browser: its key names one (`isSecretSettingKey()`), or the plugin's manifest
 * says so (`secret: true`, or a `password` type) - the manifest is the plugin's own word for it, which a key like `private_key` or `dsn` can't give. */
export function isSecretSetting(key: string, manifest?: Pick<PluginManifest, "settings">): boolean {
    if (isSecretSettingKey(key)) {
        return true;
    }
    const definition: PluginSettingDefinition | undefined = manifest?.settings?.find((setting) => setting.key === key);
    return definition?.secret === true || (definition?.type as string | undefined) === "password";
}

/**
 * What a response says of a saved setting that is a secret (`isSecretSetting()`: a key naming a secret, password, credential, token or api key, or
 * one the manifest marks secret): the object `{ "secret": true }` in place of its value, so a stored API key or shared secret is never sent back to the
 * console - the row keeps the value, and the server's own configuration loads it from there. A setting with no saved value has no entry.
 */
export function maskSecretSettings(settings: Record<string, unknown> | undefined, manifest?: Pick<PluginManifest, "settings">): Record<string, unknown> {
    const masked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(settings ?? {})) {
        masked[key] = isSecretSetting(key, manifest) && value !== undefined && value !== null ? { secret: true } : value;
    }
    return masked;
}

/** Whether `value` is what `maskSecretSettings()` shows in place of a secret: a form that left the setting alone sends it back as it was given. */
function isMaskedSecret(value: unknown): boolean {
    return typeof value === "object" && value !== null && !Array.isArray(value) && (value as any).secret === true && Object.keys(value).length === 1;
}

/**
 * The core configuration namespaces a plugin's settings may never write (the one list, `CORE_CONFIG_NAMESPACES` of `plugins/PluginUtils.ts`, which the server's
 * plugin host applies when it loads the saved settings): a plugin's saved settings are loaded into the server's own configuration (the first layer, which wins
 * over the environment), so a setting whose key lies in one of these would let a plugin manifest (or whoever edits its settings) overwrite the server's trust,
 * authentication, session, transport, escrow or PKI configuration. Kept under its old name.
 */
export const PROTECTED_SETTING_NAMESPACES: readonly string[] = CORE_CONFIG_NAMESPACES;

/** Whether `key` is a core configuration key or lies under a core namespace - what a plugin setting may never be (`isPluginSettingKeyAllowed()` is the
 * allow side of the same rule: a saved setting must be declared by the plugin's manifest AND be allowed). */
export function isProtectedSettingKey(key: string): boolean {
    return !isPluginSettingKeyAllowed(key);
}

/** Refuses (400) a plugin version the registry published without an integrity hash (`dist.integrity`): nothing would be left to check the downloaded package against. */
function assertHasIntegrity(name: string, version: string, integrity: string | undefined): void {
    if (typeof integrity !== "string" || integrity.length === 0) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'${name}@${version}' has no integrity hash in the plugin registry, so it can't be installed.`);
    }
}

/**
 * Administers the plugins this deployment runs. Every endpoint is trusted-role only: a plugin runs arbitrary
 * code inside every server copy. Which packages may be added at all is limited by `system:plugins:allowed_packages`,
 * which only the operator's configuration can widen.
 *
 * This route only records the desired plugin set and announces changes on the `plugins` channel; each server
 * copy's plugin host does the installing, loading and restarting.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BasePluginRoute<T extends Plugin> {
    protected abstract pluginClass: any;

    protected abstract auditLogClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private pluginRepo?: RepoUtils<T>;

    /** The roles that may manage plugins - with an elevated token (`assertAdminScope()`): a plugin is code every replica of the server loads. */
    @Config("trusted_roles", ["admin"])
    protected trustedRoles: string[] = ["admin"];

    /** How old an elevated token may be before it has to be elevated again, in seconds (`mail:security:elevation_max_age_seconds`, 0 = no limit). */
    @Config("mail:security:elevation_max_age_seconds", DEFAULT_ELEVATION_MAX_AGE_SECONDS)
    protected elevationMaxAgeSeconds: number = DEFAULT_ELEVATION_MAX_AGE_SECONDS;

    @Config("system:plugins:registry", DEFAULT_PLUGIN_REGISTRY)
    private registryUrl: string = DEFAULT_PLUGIN_REGISTRY;

    @Config("system:plugins:registry_token", "")
    private registryToken: string = "";

    @Config("system:plugins:allowed_packages", DEFAULT_ALLOWED_PLUGIN_PACKAGES)
    private allowedPackagesConfig: unknown = DEFAULT_ALLOWED_PLUGIN_PACKAGES;

    @Config("system:plugins:namespaces", DEFAULT_PLUGIN_NAMESPACES)
    private namespacesConfig: unknown = DEFAULT_PLUGIN_NAMESPACES;

    /** Whether `POST /upload` is switched on (`system:plugins:uploads:enabled`, default true) - an operator who allows only registry plugins turns it off. */
    @Config("system:plugins:uploads:enabled", true)
    private uploadsEnabledConfig: unknown = true;

    /** The largest pack `POST /upload` accepts, in bytes (`system:plugins:uploads:max_bytes`). */
    @Config("system:plugins:uploads:max_bytes", DEFAULT_MAX_PLUGIN_UPLOAD_BYTES)
    private uploadMaxBytesConfig: unknown = DEFAULT_MAX_PLUGIN_UPLOAD_BYTES;

    /** Where uploaded packs are stored (`plugins/uploads/<sha256>.tgz`), for the server copies to install from. */
    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Config("datastores:events", null)
    private eventsConfig: any;

    @Config("datastores:cache", null)
    private cacheConfig: any;

    @Logger
    private logger: any;

    /** Normalized on first use, so a malformed config entry is warned about once rather than on every request. */
    private normalizedNamespaces?: PluginNamespace[];

    private normalizedAllowedPackages?: string[];

    @Config()
    private config: any;

    /** The `AuditLogEntry` repository, built once by `initialize()`. */
    protected auditLogRepo?: RepoUtils<any>;

    /** Records the audit entries, built once by `initialize()` from `auditLogRepo`. */
    protected auditLogUtils?: AuditLogUtils;

    @Init
    protected async initialize(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.pluginRepo && this.pluginClass) {
            this.pluginRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.pluginClass.name, args: [this.pluginClass] });
        }
        if (!this.auditLogRepo && this.auditLogClass) {
            this.auditLogRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.auditLogClass.name, args: [this.auditLogClass] });
        }
        if (!this.auditLogUtils && this.auditLogRepo) {
            this.auditLogUtils = await this._objectFactory.newInstance(AuditLogUtils, { name: this.auditLogClass.name, args: [this.auditLogRepo] });
        }
    }

    /** Whether uploading packs is switched on. An environment variable arrives as a string, where `false` and `0` mean off. */
    protected get uploadsEnabled(): boolean {
        const value: string = String(this.uploadsEnabledConfig).trim().toLowerCase();
        return value !== "false" && value !== "0";
    }

    /** The largest pack `POST /upload` accepts, in bytes: the configured limit, or the default when it isn't a positive number. */
    protected get uploadMaxBytes(): number {
        const value: number = Number(this.uploadMaxBytesConfig);
        return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_PLUGIN_UPLOAD_BYTES;
    }

    /** The configured plugin namespaces (`system:plugins:namespaces`). */
    protected get namespaces(): PluginNamespace[] {
        this.normalizedNamespaces ??= normalizePluginNamespaces(this.namespacesConfig, this.logger);
        return this.normalizedNamespaces;
    }

    /** `system:plugins:allowed_packages` plus every package in a configured namespace. */
    protected get allowedPackages(): string[] {
        this.normalizedAllowedPackages ??= normalizeAllowedPackages(this.allowedPackagesConfig, this.logger);
        return [...this.normalizedAllowedPackages, ...this.namespaces.map((namespace) => `${namespace.name}/*`)];
    }

    /**
     * The registry client for a package or namespace: the registry configured for its namespace, else the default
     * registry. Overridable so tests can answer without a network.
     */
    protected createRegistryClient(packageOrNamespace?: string): NpmRegistryClient {
        const namespace: PluginNamespace | undefined = packageOrNamespace
            ? this.namespaces.find((ns) => ns.name === packageOrNamespace) ?? findPluginNamespace(packageOrNamespace, this.namespaces)
            : undefined;
        // A namespace on its own registry never gets the default registry's token; one on the default registry uses its
        // own token when it has one.
        return namespace?.registry
            ? new NpmRegistryClient(namespace.registry, namespace.token)
            : new NpmRegistryClient(this.registryUrl, namespace?.token ?? (this.registryToken || undefined));
    }

    private registrySession(): RegistrySession {
        return new RegistrySession((name) => this.createRegistryClient(name));
    }

    /** Runs a registry call, turning a registry failure into a `502`. */
    private async registryCall<R>(call: () => Promise<R>): Promise<R> {
        try {
            return await call();
        } catch (err: any) {
            if (err instanceof RegistryRequestError) {
                throw new ApiError(ApiErrors.INTERNAL_ERROR, 502, err.message);
            }
            throw err;
        }
    }

    private async installedPlugins(): Promise<T[]> {
        // Entity instances (`asEntity()`), since `applyPlan()` updates these rows: MongoDB's `find()` returns plain
        // documents, which `RepoUtils.update()` writes without its version check.
        return (await this.pluginRepo!.find({} as any, { ignoreACL: true, skipCache: true }))
            .filter((plugin) => !plugin.removed)
            .map((plugin) => asEntity(this.pluginRepo!, plugin));
    }

    /** Announces a change to every server copy. A deployment without `datastores:events` has a single copy
     * whose own periodic check picks the change up, so a missing config (or a Redis error) is logged, not
     * thrown - the change itself is already saved. */
    protected async publishChange(hash: string): Promise<void> {
        const url: string | undefined = this.eventsConfig?.url;
        if (!url) {
            return;
        }
        const client = createClient({ url });
        try {
            await client.connect();
            await client.publish(PLUGIN_EVENTS_CHANNEL, JSON.stringify({ type: PLUGIN_CHANGED_EVENT, hash }));
        } catch (err: any) {
            this.logger?.warn(`Could not announce a plugin change: ${err.message}`);
        } finally {
            await client.disconnect().catch(() => undefined);
        }
    }

    /** Reads every server copy's last reported status. Overridable for tests. */
    protected async readInstanceStatuses(): Promise<PluginInstanceStatus[]> {
        const url: string | undefined = this.cacheConfig?.url;
        if (!url) {
            return [];
        }
        const client = createClient({ url });
        try {
            await client.connect();
            const entries: Record<string, string> = await client.hGetAll(PLUGIN_STATUS_KEY);
            return Object.values(entries).flatMap((raw) => {
                try {
                    return [JSON.parse(raw) as PluginInstanceStatus];
                } catch {
                    return [];
                }
            });
        } catch (err: any) {
            this.logger?.warn(`Could not read plugin status: ${err.message}`);
            return [];
        } finally {
            await client.disconnect().catch(() => undefined);
        }
    }

    private assertAllowed(name: string): void {
        if (!isValidPackageName(name)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `${JSON.stringify(name)} is not a valid npm package name.`);
        }
        if (!matchesAllowedPackage(name, this.allowedPackages)) {
            throw new ApiError(
                ApiErrors.INVALID_REQUEST,
                400,
                `'${name}' is not an allowed plugin package. Allowed: ${this.allowedPackages.join(", ")}.`,
            );
        }
    }

    /** A `packageVersion` query parameter: `undefined` when it's absent or empty, a `400` when it's repeated. */
    private queryVersion(packageVersion: unknown): string | undefined {
        if (packageVersion !== undefined && typeof packageVersion !== "string") {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'packageVersion' must be a single version.");
        }
        return packageVersion || undefined;
    }

    /** A `prerelease` query parameter: whether prerelease versions (`1.0.0-beta.2`) count. Absent or empty is `false`. */
    private queryPrerelease(prerelease: unknown): boolean {
        return this.queryFlag("prerelease", prerelease);
    }

    /** A true/false query parameter: absent or empty is `false`, anything but `true`, `1`, `false` or `0` a `400`. */
    private queryFlag(name: string, value: unknown): boolean {
        if (value === undefined || value === "" || value === "false" || value === "0") {
            return false;
        }
        if (value === "true" || value === "1") {
            return true;
        }
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'${name}' must be true or false.`);
    }

    /**
     * The version to use for a package when none was asked for: the newest one `pickLatestVersion()` allows. Resolves
     * `undefined` - meaning the registry's own `latest` - when that leaves nothing (a package with only prereleases,
     * asked without them) or the package can't be found, so a lookup that would fail still fails the way it always did.
     */
    private async defaultVersion(session: RegistrySession, name: string, prerelease: boolean): Promise<string | undefined> {
        const pkg: RegistryPackage | undefined = await this.registryCall(() => session.getPackage(name));
        return pkg ? pickLatestVersion(pkg.versions, { latest: pkg.latest, prerelease }) : undefined;
    }

    /** Resolves a package version from the registry, turning its failure modes into API errors. */
    private async lookupVersion(
        session: RegistrySession,
        name: string,
        requestedVersion?: unknown,
    ): Promise<RegistryPackageVersion & { manifest: PluginManifest }> {
        const packageVersion: string | undefined = this.queryVersion(requestedVersion);
        const requested: string = packageVersion ?? "latest";
        const found: RegistryPackageVersion | undefined = await this.registryCall(() => session.getVersion(name, requested));
        if (!found) {
            throw new ApiError(
                ApiErrors.NOT_FOUND,
                404,
                packageVersion ? `'${name}@${packageVersion}' was not found in the plugin registry.` : `'${name}' was not found in the plugin registry.`,
            );
        }
        if (!isExactVersion(found.version)) {
            // A dist-tag can point at something other than a published version, such as a git or file reference, and a
            // version such as `v1.0.0` would be installed as a different string than the one recorded.
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'${name}@${requested}' resolves to '${found.version}', which isn't a published version.`);
        }
        if (typeof found.manifest === "string") {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, found.manifest);
        }
        return found as RegistryPackageVersion & { manifest: PluginManifest };
    }

    /** The plugin row `id`, unless it doesn't exist or was removed. */
    private async findInstalled(id: string): Promise<T> {
        const existing: T | undefined = await this.pluginRepo!.findOne(id, { ignoreACL: true });
        if (!existing || existing.removed) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        return existing;
    }

    /** Tells every server copy about the current plugin set. A failure is logged rather than thrown, so it can't replace
     * the outcome of the change being announced - each copy's own periodic check still picks the change up. */
    private async announce(): Promise<void> {
        try {
            const all: T[] = await this.pluginRepo!.find({} as any, { ignoreACL: true });
            await this.publishChange(computePluginStateHash(all));
        } catch (err: any) {
            this.logger?.error(`Could not announce a plugin change: ${err.message}`);
        }
    }

    /**
     * Runs a change that may write several rows. When it fails part way, what it wrote (recorded in `undo`) is undone,
     * best-effort and newest first, before the error is passed on. Every server copy is told about the result whenever
     * anything was written, so a copy never keeps running a half-applied change that its undo couldn't reverse.
     *
     * Checks run before writing (dependents, requirements) read a snapshot that a concurrent change can invalidate - one
     * request disabling a plugin while another enables a plugin that requires it. So once written, the requirements
     * touching `involving` are checked again against a fresh read, and a change that left an enabled plugin without a
     * requirement is undone with a `409`, as is one that left two enabled plugins' UI apps mounted at overlapping paths.
     * A requirement that was already unmet, or an overlap that already existed, in `before` (the snapshot the change was
     * checked against) isn't this change's doing, so it doesn't refuse it.
     */
    private async applyChange<R>(before: T[], involving: string[], change: (undo: PluginUndo[]) => Promise<R>): Promise<R> {
        const undo: PluginUndo[] = [];
        let succeeded = false;
        try {
            const result: R = await change(undo);
            const after: T[] = await this.installedPlugins();
            const existing: Set<string> = new Set(findUnmetRequirements(before, involving));
            const problems: string[] = findUnmetRequirements(after, involving).filter((problem) => !existing.has(problem));
            const existingMounts: Set<string> = new Set(this.mountConflicts(before, involving));
            problems.push(...this.mountConflicts(after, involving).filter((problem) => !existingMounts.has(problem)));
            if (problems.length > 0) {
                throw new ApiError(
                    ApiErrors.IDENTIFIER_EXISTS,
                    409,
                    `Another plugin change made at the same time conflicts with this one: ${problems.join(" ")} Nothing was changed. Review the plugins and try again.`,
                );
            }
            succeeded = true;
            return result;
        } catch (err) {
            await this.rollback(undo);
            throw err;
        } finally {
            if (succeeded || undo.length > 0) {
                await this.announce();
            }
        }
    }

    /** The UI mount conflicts among the enabled plugins in `plugins` that involve one of `involving`. The plugins are
     * compared in name order, so the messages don't depend on the order the rows were read in. */
    private mountConflicts(plugins: T[], involving: string[]): string[] {
        const enabled: T[] = plugins.filter((row) => row.enabled).sort((a, b) => a.name.localeCompare(b.name));
        return findPluginUiMountConflicts(enabled)
            .filter((conflict) => involving.includes(conflict.name) || involving.includes(conflict.otherName))
            .map((conflict) => conflict.message);
    }

    private async rollback(undo: PluginUndo[]): Promise<void> {
        for (const step of [...undo].reverse()) {
            try {
                await step();
            } catch (err: any) {
                this.logger?.error(`Could not undo part of a failed plugin change: ${err.message}`);
            }
        }
    }

    /** The registry as the dependency planner reads it, with each package read from its namespace's registry. */
    private plannerRegistry(session: RegistrySession): PlannerRegistry {
        return {
            versions: async (name) => (await this.registryCall(() => session.getPackage(name)))?.versions,
            version: (name, version) => this.registryCall(() => session.getVersion(name, version)),
        };
    }

    /** Plans a change, refusing it with a `409` that explains every conflict. */
    private async planOrRefuse(session: RegistrySession, installed: T[], name: string, version: string, manifest: PluginManifest): Promise<PluginChangePlan> {
        const plan: PluginChangePlan = await planPluginChange(installed, { name, version, manifest }, this.plannerRegistry(session), {
            allowed: (dependency) => matchesAllowedPackage(dependency, this.allowedPackages),
        });
        if (plan.conflicts.length > 0) {
            throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, plan.conflicts.join(" "));
        }
        return plan;
    }

    /** Validates an `expectedPlan` body field, returning `undefined` when none was given. */
    private parseExpectedPlan(expected: unknown): PluginExpectedPlan | undefined {
        if (expected === undefined) {
            return undefined;
        }
        const given: any = expected;
        if (!given || typeof given !== "object" || !Array.isArray(given.install) || !Array.isArray(given.enable)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'expectedPlan' must list the plugins the change installs and enables.");
        }
        if (given.version !== undefined && typeof given.version !== "string") {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'expectedPlan.version' must be the previewed version.");
        }
        return given;
    }

    /**
     * Refuses, with a `409` and without changing anything, a change whose plan is no longer the one the administrator
     * confirmed - the registry can change between the preview and the change (including what `latest` points at, which
     * `version` catches). No `expected` plan means no check.
     */
    private assertExpectedPlan(expected: PluginExpectedPlan | undefined, plan: Pick<PluginChangePlan, "install" | "enable">, version: string): void {
        if (expected === undefined) {
            return;
        }
        const sameSet = (a: unknown[], b: unknown[]): boolean => JSON.stringify(a.map(String).sort()) === JSON.stringify(b.map(String).sort());
        const installKey = (install: any): string => JSON.stringify([install?.name, install?.version]);
        if (
            (expected.version !== undefined && expected.version !== version) ||
            !sameSet(expected.install.map(installKey), plan.install.map(installKey)) ||
            !sameSet(expected.enable, plan.enable)
        ) {
            throw new ApiError(
                ApiErrors.IDENTIFIER_EXISTS,
                409,
                "The plugins this change needs have changed since it was previewed. Review the change again.",
            );
        }
    }

    /** Refuses, with a `409`, to take away a plugin that enabled plugins require. */
    private assertNoDependents(installed: T[], plugin: T, action: string): void {
        const dependents: T[] = findDependents(installed, plugin.name);
        if (dependents.length > 0) {
            const names: string = dependents.map((row) => row.manifest.displayName).sort().join(", ");
            const verb: string = dependents.length === 1 ? "requires" : "require";
            throw new ApiError(
                ApiErrors.IDENTIFIER_EXISTS,
                409,
                `${names} ${verb} ${plugin.manifest.displayName}, so it can't be ${action}. Disable ${names} first.`,
            );
        }
    }

    private async audit(req: HttpRequest, user: JWTUser | undefined, action: AuditAction, plugin: T, details: Record<string, unknown>): Promise<void> {
        await this.auditLogUtils!.record(
            { action, targetType: "Plugin", targetUid: plugin.uid, details: { name: plugin.name, ...details } },
            { req, user },
        );
    }

    /** Creates, or revives the removed row of, a plugin at a resolved version, recording how to undo that. With `upload` the
     * package is an uploaded pack; without it a revived row that was one is a registry plugin again. */
    private async installRow(install: PlannedPluginInstall, user: JWTUser | undefined, undo: PluginUndo[], host?: string, upload?: UploadFields): Promise<T> {
        assertHasIntegrity(install.name, install.version, install.integrity);
        const [found]: T[] = await this.pluginRepo!.find({ name: install.name } as any, { ignoreACL: true, limit: 1, skipCache: true });
        // An entity instance, so reviving the row below is version-checked (see `installedPlugins()`).
        const existing: T | undefined = found ? asEntity(this.pluginRepo!, found) : undefined;
        if (existing && !existing.removed) {
            // Installed by someone else since this change was planned - never overwrite their version and settings.
            throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, `'${install.name}' changed while this change was being planned. Try again.`);
        }
        const fields: Partial<Plugin> = {
            name: install.name,
            packageVersion: install.version,
            integrity: install.integrity,
            enabled: true,
            removed: false,
            settings: defaultPluginSettings(install.manifest, host),
            manifest: install.manifest,
            ...(upload ?? {}),
        };
        // What a revived row that was an uploaded pack keeps of it, and gets back if the change is undone.
        const wasUpload: boolean = existing?.source === "upload";
        if (wasUpload && !upload) {
            Object.assign(fields, REGISTRY_SOURCE_FIELDS);
        }
        const options = { user, ignoreACL: true };
        if (existing) {
            // A previously removed plugin's row is revived rather than duplicated - see `Plugin.removed`.
            const revived: T = await this.pluginRepo!.update({ uid: existing.uid, version: existing.version, ...fields } as any, existing, options);
            const previous: Partial<Plugin> = {
                packageVersion: existing.packageVersion,
                // Read back from the database, so an unset integrity is already `null` (SQL) or absent, which Mongo
                // writes as `null` - either clears the integrity the revival set.
                integrity: existing.integrity,
                enabled: existing.enabled,
                removed: true,
                settings: existing.settings,
                manifest: existing.manifest,
                ...(wasUpload || upload ? uploadFieldsOf(existing) : {}),
            };
            undo.push(async () => {
                await this.pluginRepo!.update({ uid: revived.uid, version: revived.version, ...previous } as any, revived, options);
            });
            return revived;
        }
        const created: T = await this.pluginRepo!.create(new this.pluginClass(fields), options);
        undo.push(async () => {
            // Deleted outright: a removed row would read as an administrator's removal, which stops the server's
            // default plugin list from ever adding the package.
            await this.pluginRepo!.delete(created.uid, { ignoreACL: true, version: created.version });
        });
        return created;
    }

    /** The plugins a change to `name` writes: `name` and whatever its plan installs and enables. */
    private changedNames(name: string, plan?: PluginChangePlan): string[] {
        return [name, ...(plan?.install.map((install) => install.name) ?? []), ...(plan?.enable ?? [])];
    }

    /** Installs and enables what a plan needs, dependencies first, and returns the rows it changed. */
    private async applyPlan(plan: PluginChangePlan, installed: T[], req: HttpRequest, user: JWTUser | undefined, undo: PluginUndo[]): Promise<T[]> {
        const changed: T[] = [];
        for (const install of plan.install) {
            const row: T = await this.installRow(install, user, undo, pluginHostOfRequest(req.headers));
            await this.audit(req, user, AuditAction.PLUGIN_INSTALL, row, { packageVersion: row.packageVersion });
            changed.push(row);
        }
        for (const name of plan.enable) {
            const existing: T = installed.find((row) => row.name === name)!;
            const options = { user, ignoreACL: true };
            const row: T = await this.pluginRepo!.update({ uid: existing.uid, version: existing.version, enabled: true } as any, existing, options);
            undo.push(async () => {
                await this.pluginRepo!.update({ uid: row.uid, version: row.version, enabled: false } as any, row, options);
            });
            await this.audit(req, user, AuditAction.PLUGIN_UPDATE, row, { packageVersion: row.packageVersion, enabled: true, settingsChanged: false });
            changed.push(row);
        }
        return changed;
    }

    @RequiresTrustedRole()
    @Get()
    public async list(): Promise<T[]> {
        const plugins: T[] = await this.pluginRepo!.find({} as any, { ignoreACL: true });
        return plugins
            .filter((plugin) => !plugin.removed)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((plugin) => this.withConfigured(plugin));
    }

    /**
     * `plugin` with what the deployment's configuration says about its settings (`Plugin.configured`), so the admin
     * console shows a setting's value in effect and which ones a saved value can't change. Only in responses - the row
     * is stored without it.
     */
    private withConfigured(plugin: T): T {
        const shown: T = { ...plugin, settings: maskSecretSettings(plugin.settings, plugin.manifest), configured: configuredPluginSettings(this.config, plugin.manifest) };
        // Where the pack is stored is the server's own business - a response never carries it.
        delete shown.uploadBlobKey;
        return shown;
    }

    @RequiresTrustedRole()
    @Get("/status")
    public async status(): Promise<PluginStatusResponse> {
        const plugins: T[] = await this.pluginRepo!.find({} as any, { ignoreACL: true });
        const cutoff: number = Date.now() - PLUGIN_STATUS_MAX_AGE_MS;
        const instances: PluginInstanceStatus[] = (await this.readInstanceStatuses())
            .filter((instance) => Date.parse(instance.updatedAt) >= cutoff)
            .sort((a, b) => a.instance.localeCompare(b.instance));
        return { hash: computePluginStateHash(plugins), instances, uploads: { enabled: this.uploadsEnabled, maxBytes: this.uploadMaxBytes } };
    }

    /** The configured plugin namespaces, without their registry tokens. */
    @RequiresTrustedRole()
    @Get("/namespaces")
    public listNamespaces(): { name: string; registry?: string }[] {
        return this.namespaces.map(({ name, registry }) => ({ name, registry }));
    }

    /** Plugin packages (names ending in `-plugin`) published under `namespace`, e.g. `@rapidmx`, each with its latest
     * version and marked with whether it may be added, whether it's installed, and whether that install is outdated.
     * A registry result without a name and version is left out. */
    @RequiresTrustedRole()
    @Get("/search")
    public async search(@Query("namespace") namespace?: unknown, @Query("prerelease") prerelease?: unknown): Promise<PluginSearchResult[]> {
        const includePrerelease: boolean = this.queryPrerelease(prerelease);
        let scopes: string[];
        if (namespace === undefined || (typeof namespace === "string" && namespace.trim() === "")) {
            scopes = this.namespaces.map((ns) => ns.name);
        } else {
            // A repeated `?namespace=` arrives as a list, which is refused like any other invalid scope.
            const [requested] = typeof namespace === "string" ? normalizePluginNamespaces([namespace]) : [];
            if (!requested) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'namespace' must be an npm scope, for example @rapidmx.");
            }
            scopes = [requested.name];
        }
        const pages: RegistrySearchResult[][] = await this.registryCall(() =>
            Promise.all(scopes.map((scope) => this.createRegistryClient(scope).searchPlugins(scope))),
        );
        const session: RegistrySession = this.registrySession();
        const found: RegistrySearchResult[] = await Promise.all(
            pages
                .flat()
                .filter((result) => typeof result?.name === "string" && typeof result.version === "string")
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((result) => this.newestSearchResult(session, result, includePrerelease)),
        );
        const installed: Map<string, T> = new Map((await this.installedPlugins()).map((plugin) => [plugin.name, plugin]));
        return found.map((result) => {
            const plugin: T | undefined = installed.get(result.name);
            const allowed: boolean = matchesAllowedPackage(result.name, this.allowedPackages);
            return {
                ...result,
                allowed,
                installedUid: plugin?.uid,
                installedVersion: plugin?.packageVersion,
                ...(plugin?.source === "upload" ? { installedSource: "upload" as const } : {}),
                // As in `GET /updates`: upgrading a plugin outside the allow-list would be refused. An uploaded pack is never compared with the registry's versions.
                updateAvailable: allowed && !!plugin && plugin.source !== "upload" && isNewerVersion(result.version, plugin.packageVersion),
            };
        });
    }

    /**
     * `result` with its version replaced by the newest one `pickLatestVersion()` allows. The registry's search reports
     * a package's `latest` tag, which is enough unless prereleases count or the tag names one, so only then is the
     * package read. A package that can't be read keeps the version the search gave.
     */
    private async newestSearchResult(session: RegistrySession, result: RegistrySearchResult, prerelease: boolean): Promise<RegistrySearchResult> {
        if (!prerelease && !isPrereleaseVersion(result.version)) {
            return result;
        }
        try {
            const pkg: RegistryPackage | undefined = await session.getPackage(result.name);
            const newest: string | undefined = pkg ? pickLatestVersion(pkg.versions, { latest: pkg.latest, prerelease }) : undefined;
            return newest ? { ...result, version: newest } : result;
        } catch {
            return result;
        }
    }

    /** For each installed plugin, the newest published version and whether it's newer than the installed one. Only
     * releases count unless `prerelease` is `true` (see `pickLatestVersion()`). A plugin the registry can't be checked
     * for reports an `error` rather than failing the whole request, and one outside the allow-list never reports an
     * update, since upgrading it would be refused. */
    @RequiresTrustedRole()
    @Get("/updates")
    public async updates(@Query("prerelease") prerelease?: unknown): Promise<PluginUpdateInfo[]> {
        const includePrerelease: boolean = this.queryPrerelease(prerelease);
        const plugins: T[] = (await this.installedPlugins()).sort((a, b) => a.name.localeCompare(b.name));
        return Promise.all(
            plugins.map(async (plugin): Promise<PluginUpdateInfo> => {
                const allowed: boolean = matchesAllowedPackage(plugin.name, this.allowedPackages);
                const base = { uid: plugin.uid, name: plugin.name, installedVersion: plugin.packageVersion, allowed };
                if (plugin.source === "upload") {
                    // The registry knows nothing of an uploaded pack's version, so it isn't asked.
                    return { ...base, updateAvailable: false, source: "upload" };
                }
                try {
                    const pkg: RegistryPackage | undefined = await this.createRegistryClient(plugin.name).getPackage(plugin.name);
                    const latestVersion: string | undefined = pkg ? pickLatestVersion(pkg.versions, { latest: pkg.latest, prerelease: includePrerelease }) : undefined;
                    const newer: boolean = !!latestVersion && isNewerVersion(latestVersion, plugin.packageVersion);
                    return { ...base, latestVersion, updateAvailable: allowed && newer };
                } catch (err: any) {
                    return { ...base, updateAvailable: false, error: err.message };
                }
            }),
        );
    }

    /**
     * `GET /registry?name=<package>[&packageVersion=<version>]` - the same lookup as `GET /registry/:name`, for a
     * package name sent in the query string. A scoped name in the path needs its `/` escaped as `%2F`, which a proxy in
     * front of the server (Envoy Gateway's default) unescapes and redirects to a path that matches no route.
     */
    @RequiresTrustedRole()
    @Get("/registry")
    public async lookupByName(
        @Query("name") name?: unknown,
        @Query("packageVersion") packageVersion?: string,
        @Query("prerelease") prerelease?: unknown,
    ): Promise<PluginRegistryLookup> {
        if (typeof name !== "string" || !name.trim()) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'name' is required.");
        }
        return this.lookupPackage(name.trim(), packageVersion, this.queryPrerelease(prerelease));
    }

    @RequiresTrustedRole()
    @Get("/registry/:name")
    public async lookup(
        @Param("name") name: string,
        @Query("packageVersion") packageVersion?: string,
        @Query("prerelease") prerelease?: unknown,
    ): Promise<PluginRegistryLookup> {
        return this.lookupPackage(name, packageVersion, this.queryPrerelease(prerelease));
    }

    /**
     * A package's versions and one version's details. Without `prerelease` the versions leave out prereleases (except
     * the one installed, which the administrator has to be able to see), and `latest` is the newest allowed version
     * rather than the registry's tag - which is also the version selected when none was asked for.
     */
    private async lookupPackage(name: string, packageVersion: string | undefined, prerelease: boolean): Promise<PluginRegistryLookup> {
        this.assertAllowed(name);
        const session: RegistrySession = this.registrySession();
        const found: RegistryPackage | undefined = await this.registryCall(() => session.getPackage(name));
        if (!found) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, `'${name}' was not found in the plugin registry.`);
        }
        const newest: string | undefined = pickLatestVersion(found.versions, { latest: found.latest, prerelease });
        const installedVersion: string | undefined = (await this.installedPlugins()).find((row) => row.name === name)?.packageVersion;
        const pkg: RegistryPackage = {
            name: found.name,
            latest: newest ?? found.latest,
            versions: prerelease ? found.versions : found.versions.filter((version) => version === installedVersion || !isPrereleaseVersion(version)),
        };
        const selected = await this.lookupVersion(session, name, this.queryVersion(packageVersion) ?? newest);
        return { package: pkg, selected };
    }

    /**
     * What adding `name` (or changing it, when installed) at `packageVersion` - default the registry's `latest` - would
     * also install and enable, and any conflicts that would refuse it. Nothing is changed.
     *
     * For an installed plugin with `packageVersion` omitted or equal to its installed version, this is the plan for
     * enabling it: its stored manifest is used and the registry isn't asked about the plugin itself, exactly as
     * `PUT /:id` plans `{ enabled: true }`.
     */
    @RequiresTrustedRole()
    @Get("/plan")
    public async plan(
        @Query("name") name?: unknown,
        @Query("packageVersion") packageVersion?: unknown,
        @Query("prerelease") prerelease?: unknown,
        @AuthUser user?: JWTUser,
    ): Promise<PluginPlanResponse> {
        // Planning is the first half of a change (the plan is what `expectedPlan` confirms), and asks the registry on the server's behalf.
        assertAdminScope(user, this.trustedRoles, this.elevationMaxAgeSeconds);
        const trimmed: string = typeof name === "string" ? name.trim() : "";
        if (!trimmed) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'name' is required.");
        }
        const requested: string | undefined = this.queryVersion(packageVersion);
        const includePrerelease: boolean = this.queryPrerelease(prerelease);
        const session: RegistrySession = this.registrySession();
        const installed: T[] = await this.installedPlugins();
        const current: T | undefined = installed.find((row) => row.name === trimmed);
        const unchanged: boolean = !!current && (requested === undefined || requested === current.packageVersion);
        // An uploaded plugin was never checked against the allow-list, and enabling it as it is doesn't ask the registry.
        if (!(unchanged && current!.source === "upload")) {
            this.assertAllowed(trimmed);
        }
        let target: PlannedPluginChange;
        if (current && unchanged) {
            target = { name: trimmed, version: current.packageVersion, manifest: current.manifest };
        } else {
            const found = await this.lookupVersion(session, trimmed, requested ?? (await this.defaultVersion(session, trimmed, includePrerelease)));
            target = { name: trimmed, version: found.version, manifest: found.manifest };
        }
        const plan: PluginChangePlan = await planPluginChange(installed, target, this.plannerRegistry(session), {
            allowed: (dependency) => matchesAllowedPackage(dependency, this.allowedPackages),
        });
        return { plugin: target, ...plan };
    }

    /** Adds a plugin, installing and enabling the plugins it requires first. Refused with a `409` when a requirement
     * can't be met without changing the version of an installed plugin, or when `expectedPlan` no longer matches. */
    @RequiresTrustedRole()
    @Post()
    public async add(obj: AddPluginRequest | undefined, @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<AddPluginResponse<T>> {
        // Installing a plugin loads its code into every replica of the server: an elevated administrator only.
        assertAdminScope(user, this.trustedRoles, this.elevationMaxAgeSeconds);
        const name: string = typeof obj?.name === "string" ? obj.name.trim() : "";
        if (!name) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'name' is required.");
        }
        this.assertAllowed(name);
        const installed: T[] = await this.installedPlugins();
        if (installed.some((row) => row.name === name)) {
            throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, `'${name}' is already installed.`);
        }
        const session: RegistrySession = this.registrySession();
        const found = await this.lookupVersion(session, name, obj?.packageVersion);
        const expectedPlan: PluginExpectedPlan | undefined = this.parseExpectedPlan(obj?.expectedPlan);
        const plan: PluginChangePlan = await this.planOrRefuse(session, installed, name, found.version, found.manifest);
        this.assertExpectedPlan(expectedPlan, plan, found.version);

        return this.applyChange(installed, this.changedNames(name, plan), async (undo) => {
            const dependencies: T[] = await this.applyPlan(plan, installed, req, user, undo);
            const created: T = await this.installRow(
                { name, version: found.version, integrity: found.integrity, manifest: found.manifest },
                user,
                undo,
                pluginHostOfRequest(req.headers),
            );
            await this.audit(req, user, AuditAction.PLUGIN_INSTALL, created, { packageVersion: found.version });
            return { plugin: this.withConfigured(created), dependencies: dependencies.map((row) => this.withConfigured(row)) };
        });
    }

    /**
     * Deletes the uploaded pack stored under `key`, unless a plugin row still names it (the same bytes are the same key, so two
     * rows - or the row being replaced by the very same bytes - can share one). A removed row doesn't count: it was taken away
     * with its pack. A failure is logged, not thrown: the change that made the pack unused is already saved, and a pack left
     * behind is only disk.
     */
    private async dropUnreferencedBlob(key: string | undefined): Promise<void> {
        if (!key) {
            return;
        }
        try {
            const rows: T[] = await this.pluginRepo!.find({} as any, { ignoreACL: true, skipCache: true });
            if (!rows.some((row) => !row.removed && row.uploadBlobKey === key)) {
                await this.blobStore!.delete(key);
            }
        } catch (err: any) {
            this.logger?.warn(`Could not delete the unused plugin pack '${key}': ${err.message}`);
        }
    }

    /** Checks an uploaded pack's `package.json` the way `add()` checks a registry version - everything but the allow-list, which an uploaded pack
     * bypasses by design. */
    private validatePack(packageJson: Record<string, unknown>): { name: string; version: string; manifest: PluginManifest } {
        const { name, version } = packageJson;
        if (!isValidPackageName(name)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `The pack's package.json name ${JSON.stringify(name)} is not a valid npm package name.`);
        }
        if (!isExactVersion(version)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `The pack's package.json version ${JSON.stringify(version)} is not an exact version such as 1.2.3.`);
        }
        const manifest: PluginManifest | string = parsePluginManifest(packageJson);
        if (typeof manifest === "string") {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, manifest);
        }
        return { name, version, manifest };
    }

    /** The saved settings of a plugin that is moving to `manifest`'s version: the ones it still declares, with a new host-named default filled
     * in where there is no value, checked against it - as `update()` does for a new version. */
    private carriedSettings(manifest: PluginManifest, saved: Record<string, unknown> | undefined, host: string | undefined): Record<string, string | number | boolean> {
        const known: Set<string> = new Set(manifest.settings!.map((setting) => setting.key).filter(isPluginSettingKeyAllowed));
        const candidate: Record<string, unknown> = Object.fromEntries(Object.entries(saved ?? {}).filter(([key]) => known.has(key)));
        for (const setting of manifest.settings!) {
            const suggested: string | undefined = resolveHostDefault(setting, host);
            if (suggested !== undefined && (candidate[setting.key] === undefined || candidate[setting.key] === "")) {
                candidate[setting.key] = suggested;
            }
        }
        try {
            return validatePluginSettings(manifest, candidate);
        } catch (err: any) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, err.message);
        }
    }

    /**
     * Installs a plugin from an uploaded \`npm pack\` file (\`.tgz\`), the body of the request as raw bytes (not multipart; \`Content-Type\`
     * \`application/gzip\` or \`application/octet-stream\`). \`?filename=\` names it for display, \`?replace=true\` replaces an installed plugin of
     * the same name (a \`409\` naming the installed version and source without it). \`201\` with the plugin, \`200\` when it replaced one.
     *
     * An uploaded pack is code the administrator vouches for, so it skips the registry allow-list - and is held to everything else: the
     * route is for an elevated administrator only (\`assertAdminScope()\`), can be switched off (\`system:plugins:uploads:enabled\`), is rate
     * limited per user, is capped at \`system:plugins:uploads:max_bytes\` while it streams in (\`413\`), is read in memory without ever
     * being unpacked to disk (\`inspectPack()\`: only a plain \`package/\` tree, no links, no gzip bomb), must carry a valid manifest (the
     * same \`parsePluginManifest()\` check, including the server's protected settings), and is audited (\`plugin.upload\`). The pack is
     * stored in the blob store under \`plugins/uploads/<sha256>.tgz\` before the row is written (and taken out again if the write fails);
     * the row's \`integrity\` is \`sha512-<base64>\` of its bytes.
     *
     * Replacing keeps the row's saved settings (re-checked against the new manifest) and \`enabled\`. A plugin the manifest requires must
     * already be installed and enabled in range (\`409\` otherwise) - nothing is fetched from the registry.
     */
    @RequiresTrustedRole()
    @Post("/upload")
    @StreamingBody()
    @RateLimit({ perUser: true, maxAttempts: UPLOAD_MAX_ATTEMPTS, windowSeconds: UPLOAD_WINDOW_SECONDS })
    public async upload(
        @Request req: HttpRequest,
        @Response res: HttpResponse,
        @Query("filename") filename?: unknown,
        @Query("replace") replace?: unknown,
        @AuthUser user?: JWTUser,
    ): Promise<void> {
        const maxBytes: number = this.uploadMaxBytes;
        let replacing: boolean;
        let displayName: string | undefined;
        try {
            // A plugin is code every replica of the server loads: an elevated administrator only.
            assertAdminScope(user, this.trustedRoles, this.elevationMaxAgeSeconds);
            if (!this.uploadsEnabled) {
                throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, "Uploading plugins is turned off on this server (system:plugins:uploads:enabled).");
            }
            if (!this.blobStore) {
                throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
            }
            replacing = this.queryFlag("replace", replace);
            if (filename !== undefined && typeof filename !== "string") {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'filename' must be a single file name.");
            }
            displayName = filename === undefined ? undefined : sanitizeUploadFilename(filename);
            const declaredLength: number | undefined = parseContentLength(req.headers["content-length"]);
            if (declaredLength !== undefined && declaredLength > maxBytes) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 413, `The uploaded pack is larger than the ${maxBytes} bytes allowed.`);
            }
        } catch (err: any) {
            // A rejection that never touched the body must still let a small one finish, or the client sees a reset instead of the error.
            await discardSmallBody(req.bodyStream, parseContentLength(req.headers["content-length"]));
            throw err;
        }

        const bytes: Buffer = await readCapped(req.bodyStream!, maxBytes);
        if (bytes.length === 0) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The request body is empty. Send the .tgz file `npm pack` produced as the body.");
        }
        let inspected: PackInspection;
        try {
            inspected = await inspectPack(bytes);
        } catch (err: any) {
            if (err instanceof PackInspectionError) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, err.message);
            }
            /* v8 ignore next -- inspectPack() only refuses with a PackInspectionError */
            throw err;
        }
        const { name, version, manifest } = this.validatePack(inspected.packageJson);
        const integrity: string = packIntegrity(bytes);
        const blobKey: string = pluginUploadBlobKey(bytes);

        const installed: T[] = await this.installedPlugins();
        const live: T | undefined = installed.find((row) => row.name === name);
        if (live && !replacing) {
            const from: string = live.source === "upload" ? "uploaded pack" : "plugin registry";
            throw new ApiError(
                ApiErrors.IDENTIFIER_EXISTS,
                409,
                `${name} ${live.packageVersion} is already installed (${from}). Upload it again with replace=true to replace it.`,
            );
        }
        // What the plugin set would be, to refuse a pack whose requirements (or whose dependents' requirements, or UI mounts) wouldn't hold.
        const after: T[] = [...installed.filter((row) => row !== live), { ...live, name, packageVersion: version, enabled: live?.enabled ?? true, manifest } as T];
        const before: Set<string> = new Set([...findUnmetRequirements(installed, [name]), ...this.mountConflicts(installed, [name])]);
        const problems: string[] = [...findUnmetRequirements(after, [name]), ...this.mountConflicts(after, [name])].filter((problem) => !before.has(problem));
        if (problems.length > 0) {
            throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, `'${name}@${version}' can't be installed: ${problems.join(" ")}`);
        }
        const host: string | undefined = pluginHostOfRequest(req.headers);
        const settings: Record<string, string | number | boolean> | undefined = live ? this.carriedSettings(manifest, live.settings, host) : undefined;

        // The pack is stored before the row names it, so a row never points at a pack that isn't there.
        await this.blobStore.put(blobKey, bytes, { contentType: "application/gzip" });
        const upload: UploadFields = { source: "upload", uploadBlobKey: blobKey, uploadFilename: displayName ?? `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`, uploadedAt: new Date(), uploadedByUserUid: user?.uid };
        let row: T;
        try {
            row = await this.applyChange(installed, [name], async (undo) => {
                const options = { user, ignoreACL: true };
                let written: T;
                if (live) {
                    const patch: Partial<Plugin> = { packageVersion: version, integrity, manifest, settings, removed: false, ...upload };
                    written = await this.pluginRepo!.update({ uid: live.uid, version: live.version, ...patch } as any, live, options);
                    const previous: Partial<Plugin> = {
                        packageVersion: live.packageVersion,
                        integrity: live.integrity ?? (null as any),
                        settings: live.settings,
                        manifest: live.manifest,
                        ...uploadFieldsOf(live),
                    };
                    undo.push(async () => {
                        await this.pluginRepo!.update({ uid: written.uid, version: written.version, ...previous } as any, written, options);
                    });
                } else {
                    written = await this.installRow({ name, version, integrity, manifest }, user, undo, host, upload);
                }
                await this.audit(req, user, AuditAction.PLUGIN_UPLOAD, written, {
                    packageVersion: version,
                    integrity: integrity.slice(0, 19),
                    bytes: bytes.length,
                    filename: upload.uploadFilename,
                    replaced: live !== undefined,
                    previousVersion: live?.packageVersion,
                });
                return written;
            });
        } catch (err) {
            await this.dropUnreferencedBlob(blobKey);
            throw err;
        }
        if (live?.uploadBlobKey !== blobKey) {
            await this.dropUnreferencedBlob(live?.uploadBlobKey);
        }
        res.status(live ? 200 : 201);
        res.json(this.withConfigured(row));
    }

    @RequiresTrustedRole()
    @Put("/:id")
    public async update(
        @Param("id") id: string,
        obj: UpdatePluginRequest | undefined,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        // Enabling, upgrading (or downgrading) a plugin and changing its settings all change what code runs and where it sends data.
        assertAdminScope(user, this.trustedRoles, this.elevationMaxAgeSeconds);
        const existing: T = await this.findInstalled(id);
        const patch: Partial<Plugin> = {};
        let manifest: PluginManifest = existing.manifest;
        let dependencyPlan: PluginChangePlan | undefined;
        const session: RegistrySession = this.registrySession();

        if (obj?.packageVersion !== undefined && (typeof obj.packageVersion !== "string" || obj.packageVersion.trim() === "")) {
            // An empty version would otherwise read as a change to the registry's `latest`.
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'packageVersion' must be a version.");
        }
        const expectedPlan: PluginExpectedPlan | undefined = this.parseExpectedPlan(obj?.expectedPlan);
        // Naming a version of an uploaded plugin switches it back to the registry, whatever the version.
        const fromUpload: boolean = existing.source === "upload";
        const changingVersion: boolean = obj?.packageVersion !== undefined && (obj.packageVersion !== existing.packageVersion || fromUpload);
        if (changingVersion || (obj?.enabled === true && !existing.enabled && !fromUpload)) {
            // An allow-list narrowed since the plugin was added also stops it being re-enabled or moved to another version.
            // (An uploaded plugin bypassed it when it was added, so re-enabling it as it is doesn't need it.)
            this.assertAllowed(existing.name);
        }
        if (changingVersion) {
            const found = await this.lookupVersion(session, existing.name, obj!.packageVersion);
            manifest = found.manifest;
            assertHasIntegrity(existing.name, found.version, found.integrity);
            patch.packageVersion = found.version;
            patch.integrity = found.integrity;
            patch.manifest = found.manifest;
            if (fromUpload) {
                Object.assign(patch, REGISTRY_SOURCE_FIELDS);
            }
        }
        if (obj?.enabled !== undefined) {
            if (typeof obj.enabled !== "boolean") {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'enabled' must be true or false.");
            }
            patch.enabled = obj.enabled;
        }
        const installed: T[] = await this.installedPlugins();
        if (!(patch.enabled ?? existing.enabled)) {
            if (existing.enabled) {
                this.assertNoDependents(installed, existing, "disabled");
            }
        } else if (patch.packageVersion !== undefined || !existing.enabled) {
            // Enabling a plugin or changing its version needs its requirements met, and mustn't break its dependents'.
            dependencyPlan = await this.planOrRefuse(session, installed, existing.name, patch.packageVersion ?? existing.packageVersion, manifest);
        }
        if (obj?.settings !== undefined || patch.manifest) {
            // A new version may drop or retype settings, so saved values are re-checked against its manifest -
            // values for settings that no longer exist are dropped rather than failing the upgrade.
            // Stored manifests always come through `parsePluginManifest()`, which fills in `settings`.
            // A stored manifest older than the key check may declare one of the server's own keys: its value is never carried over.
            const known: Set<string> = new Set(manifest.settings!.map((setting) => setting.key).filter(isPluginSettingKeyAllowed));
            const candidate: Record<string, unknown> =
                obj?.settings ?? Object.fromEntries(Object.entries(existing.settings).filter(([key]) => known.has(key)));
            if (obj?.settings !== undefined) {
                for (const key of Object.keys(candidate)) {
                    if (!isPluginSettingKeyAllowed(key)) {
                        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'${key}' is part of the server's own configuration and can't be set as a plugin setting.`);
                    }
                }
                // The placeholder a secret setting was shown as means "left alone": the saved value stays.
                for (const [key, value] of Object.entries(candidate)) {
                    if (isMaskedSecret(value)) {
                        if (existing.settings?.[key] === undefined) {
                            delete candidate[key];
                        } else {
                            candidate[key] = existing.settings[key];
                        }
                    }
                }
            }
            if (obj?.settings === undefined) {
                // A version whose manifest names the host in a setting's default (`https://<host>/meet`) starts using it when the
                // setting has no value yet - the way a fresh install would.
                for (const setting of manifest.settings!) {
                    const suggested: string | undefined = resolveHostDefault(setting, pluginHostOfRequest(req.headers));
                    if (suggested !== undefined && (candidate[setting.key] === undefined || candidate[setting.key] === "")) {
                        candidate[setting.key] = suggested;
                    }
                }
            }
            try {
                patch.settings = validatePluginSettings(manifest, candidate);
            } catch (err: any) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, err.message);
            }
        }
        if (dependencyPlan) {
            // A change that plans nothing (the plugin stays or becomes disabled) has no preview to compare against.
            this.assertExpectedPlan(expectedPlan, dependencyPlan, patch.packageVersion ?? existing.packageVersion);
        }

        if (dependencyPlan && obj?.version !== undefined && obj.version !== existing.version) {
            // Checked before any dependency is touched, so a stale edit changes nothing.
            throw new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, ApiErrorMessages.INVALID_OBJECT_VERSION);
        }
        const result: T = await this.applyChange(installed, this.changedNames(existing.name, dependencyPlan), async (undo) => {
            if (dependencyPlan) {
                await this.applyPlan(dependencyPlan, installed, req, user, undo);
            }
            const options = { user, ignoreACL: true };
            const updated: T = await this.pluginRepo!.update({ uid: existing.uid, version: obj?.version ?? existing.version, ...patch } as any, existing, {
                ...options,
                version: obj?.version,
            });
            const previous: Partial<Plugin> = {
                packageVersion: existing.packageVersion,
                integrity: existing.integrity ?? (null as any),
                enabled: existing.enabled,
                settings: existing.settings,
                manifest: existing.manifest,
                ...(fromUpload && changingVersion ? uploadFieldsOf(existing) : {}),
            };
            undo.push(async () => {
                await this.pluginRepo!.update({ uid: updated.uid, version: updated.version, ...previous } as any, updated, options);
            });
            await this.audit(req, user, AuditAction.PLUGIN_UPDATE, updated, {
                packageVersion: updated.packageVersion,
                enabled: updated.enabled,
                settingsChanged: patch.settings !== undefined,
            });
            return this.withConfigured(updated);
        });
        if (fromUpload && changingVersion) {
            await this.dropUnreferencedBlob(existing.uploadBlobKey);
        }
        return result;
    }

    @RequiresTrustedRole()
    @Delete("/:id")
    public async remove(@Param("id") id: string, @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<void> {
        assertAdminScope(user, this.trustedRoles, this.elevationMaxAgeSeconds);
        const existing: T = await this.findInstalled(id);
        const installed: T[] = await this.installedPlugins();
        this.assertNoDependents(installed, existing, "uninstalled");
        await this.applyChange(installed, [existing.name], async (undo) => {
            const options = { user, ignoreACL: true };
            const removed: T = await this.pluginRepo!.update({ uid: existing.uid, version: existing.version, enabled: false, removed: true } as any, existing, options);
            undo.push(async () => {
                await this.pluginRepo!.update({ uid: removed.uid, version: removed.version, enabled: existing.enabled, removed: false } as any, removed, options);
            });
            await this.audit(req, user, AuditAction.PLUGIN_REMOVE, existing, { packageVersion: existing.packageVersion });
        });
        await this.dropUnreferencedBlob(existing.uploadBlobKey);
    }
}
