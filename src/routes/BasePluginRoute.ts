///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, HttpRequest, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { createClient } from "redis";
import semver from "semver";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { AuditAction, Plugin, PluginManifest } from "../models/types.js";
import {
    DEFAULT_PLUGIN_REGISTRY,
    NpmRegistryClient,
    RegistryPackage,
    RegistryPackageVersion,
    RegistryRequestError,
    RegistrySearchResult,
} from "../plugins/NpmRegistryClient.js";
import { findDependents, PluginChangePlan, planPluginChange, PlannerRegistry, PlannedPluginInstall } from "../plugins/PluginDependencies.js";
import {
    computePluginStateHash,
    DEFAULT_ALLOWED_PLUGIN_PACKAGES,
    DEFAULT_PLUGIN_NAMESPACES,
    findPluginNamespace,
    isNewerVersion,
    isValidPackageName,
    normalizeAllowedPackages,
    normalizePluginNamespaces,
    PluginNamespace,
    defaultPluginSettings,
    matchesAllowedPackage,
    PLUGIN_CHANGED_EVENT,
    PLUGIN_EVENTS_CHANNEL,
    PLUGIN_STATUS_KEY,
    PLUGIN_STATUS_MAX_AGE_MS,
    PluginInstanceStatus,
    validatePluginSettings,
} from "../plugins/PluginUtils.js";
const { Config, Logger } = ObjectDecorators;
const { Delete, Get, Param, Post, Put, Query, Request, RequiresTrustedRole, User: AuthUser } = RouteDecorators;

/** What an administrator saw a change would also install and enable when they confirmed it (from `GET /plan`). */
export interface PluginExpectedPlan {
    install: { name: string; version: string }[];
    enable: string[];
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
    /** Whether a newer version than the installed one is published. */
    updateAvailable: boolean;
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

    @Config()
    private config: any;

    @Config("system:plugins:registry", DEFAULT_PLUGIN_REGISTRY)
    private registryUrl: string = DEFAULT_PLUGIN_REGISTRY;

    @Config("system:plugins:registry_token", "")
    private registryToken: string = "";

    @Config("system:plugins:allowed_packages", DEFAULT_ALLOWED_PLUGIN_PACKAGES)
    private allowedPackagesConfig: unknown = DEFAULT_ALLOWED_PLUGIN_PACKAGES;

    @Config("system:plugins:namespaces", DEFAULT_PLUGIN_NAMESPACES)
    private namespacesConfig: unknown = DEFAULT_PLUGIN_NAMESPACES;

    @Config("datastores:events", null)
    private eventsConfig: any;

    @Config("datastores:cache", null)
    private cacheConfig: any;

    @Logger
    private logger: any;

    /** Normalized on first use, so a malformed config entry is warned about once rather than on every request. */
    private normalizedNamespaces?: PluginNamespace[];

    private normalizedAllowedPackages?: string[];

    private async init(): Promise<void> {
        if (!this.pluginRepo) {
            this.pluginRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.pluginClass.name,
                args: [this.pluginClass],
            });
        }
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
        return namespace?.registry
            ? new NpmRegistryClient(namespace.registry, namespace.token)
            : new NpmRegistryClient(this.registryUrl, this.registryToken || undefined);
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
        await this.init();
        return (await this.pluginRepo!.find({} as any, { ignoreACL: true })).filter((plugin) => !plugin.removed);
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

    /** Resolves a package version from the registry, turning its failure modes into API errors. */
    private async lookupVersion(
        session: RegistrySession,
        name: string,
        packageVersion?: string,
    ): Promise<RegistryPackageVersion & { manifest: PluginManifest }> {
        const requested: string = packageVersion || "latest";
        const found: RegistryPackageVersion | undefined = await this.registryCall(() => session.getVersion(name, requested));
        if (!found) {
            throw new ApiError(
                ApiErrors.NOT_FOUND,
                404,
                packageVersion ? `'${name}@${packageVersion}' was not found in the plugin registry.` : `'${name}' was not found in the plugin registry.`,
            );
        }
        if (semver.valid(found.version) === null) {
            // A dist-tag can point at something other than a published version, such as a git or file reference.
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'${name}@${requested}' resolves to '${found.version}', which isn't a published version.`);
        }
        if (typeof found.manifest === "string") {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, found.manifest);
        }
        return found as RegistryPackageVersion & { manifest: PluginManifest };
    }

    /** The plugin row `id`, unless it doesn't exist or was removed. */
    private async findInstalled(id: string): Promise<T> {
        await this.init();
        const existing: T | undefined = await this.pluginRepo!.findOne(id, { ignoreACL: true });
        if (!existing || existing.removed) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        return existing;
    }

    private async announce(): Promise<void> {
        const all: T[] = await this.pluginRepo!.find({} as any, { ignoreACL: true });
        await this.publishChange(computePluginStateHash(all));
    }

    /**
     * Runs a change that may write several rows. When it fails part way, what it wrote (recorded in `undo`) is undone,
     * best-effort and newest first, before the error is passed on. Every server copy is told about the result whenever
     * anything was written, so a copy never keeps running a half-applied change that its undo couldn't reverse.
     */
    private async applyChange<R>(change: (undo: PluginUndo[]) => Promise<R>): Promise<R> {
        const undo: PluginUndo[] = [];
        let succeeded = false;
        try {
            const result: R = await change(undo);
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

    /**
     * Refuses, with a `409` and without changing anything, a change whose plan is no longer the one the administrator
     * confirmed - the registry can change between the preview and the change. No `expected` plan means no check.
     */
    private assertExpectedPlan(expected: unknown, plan: Pick<PluginChangePlan, "install" | "enable">): void {
        if (expected === undefined) {
            return;
        }
        const given: any = expected;
        if (!given || typeof given !== "object" || !Array.isArray(given.install) || !Array.isArray(given.enable)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'expectedPlan' must list the plugins the change installs and enables.");
        }
        const sameSet = (a: unknown[], b: unknown[]): boolean => JSON.stringify(a.map(String).sort()) === JSON.stringify(b.map(String).sort());
        const installKey = (install: any): string => JSON.stringify([install?.name, install?.version]);
        if (!sameSet(given.install.map(installKey), plan.install.map(installKey)) || !sameSet(given.enable, plan.enable)) {
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
        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, req, user, logger: this.logger },
            { action, targetType: "Plugin", targetUid: plugin.uid, details: { name: plugin.name, ...details } },
        );
    }

    /** Creates, or revives the removed row of, a plugin at a resolved version, recording how to undo that. */
    private async installRow(install: PlannedPluginInstall, user: JWTUser | undefined, undo: PluginUndo[]): Promise<T> {
        const [existing]: T[] = await this.pluginRepo!.find({ name: install.name } as any, { ignoreACL: true, limit: 1 });
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
            settings: defaultPluginSettings(install.manifest),
            manifest: install.manifest,
        };
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
            };
            undo.push(async () => {
                await this.pluginRepo!.update({ uid: revived.uid, version: revived.version, ...previous } as any, revived, options);
            });
            return revived;
        }
        const created: T = await this.pluginRepo!.create(new this.pluginClass(fields), options);
        undo.push(async () => {
            await this.pluginRepo!.update({ uid: created.uid, version: created.version, enabled: false, removed: true } as any, created, options);
        });
        return created;
    }

    /** Installs and enables what a plan needs, dependencies first, and returns the rows it changed. */
    private async applyPlan(plan: PluginChangePlan, installed: T[], req: HttpRequest, user: JWTUser | undefined, undo: PluginUndo[]): Promise<T[]> {
        const changed: T[] = [];
        for (const install of plan.install) {
            const row: T = await this.installRow(install, user, undo);
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
        await this.init();
        const plugins: T[] = await this.pluginRepo!.find({} as any, { ignoreACL: true });
        return plugins.filter((plugin) => !plugin.removed).sort((a, b) => a.name.localeCompare(b.name));
    }

    @RequiresTrustedRole()
    @Get("/status")
    public async status(): Promise<PluginStatusResponse> {
        await this.init();
        const plugins: T[] = await this.pluginRepo!.find({} as any, { ignoreACL: true });
        const cutoff: number = Date.now() - PLUGIN_STATUS_MAX_AGE_MS;
        const instances: PluginInstanceStatus[] = (await this.readInstanceStatuses())
            .filter((instance) => Date.parse(instance.updatedAt) >= cutoff)
            .sort((a, b) => a.instance.localeCompare(b.instance));
        return { hash: computePluginStateHash(plugins), instances };
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
    public async search(@Query("namespace") namespace?: string): Promise<PluginSearchResult[]> {
        let scopes: string[];
        if (namespace === undefined || namespace.trim() === "") {
            scopes = this.namespaces.map((ns) => ns.name);
        } else {
            const [requested] = normalizePluginNamespaces([namespace]);
            if (!requested) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'namespace' must be an npm scope, for example @rapidmx.");
            }
            scopes = [requested.name];
        }
        const pages: RegistrySearchResult[][] = await this.registryCall(() =>
            Promise.all(scopes.map((scope) => this.createRegistryClient(scope).searchPlugins(scope))),
        );
        const found: RegistrySearchResult[] = pages
            .flat()
            .filter((result) => typeof result?.name === "string" && typeof result.version === "string")
            .sort((a, b) => a.name.localeCompare(b.name));
        const installed: Map<string, T> = new Map((await this.installedPlugins()).map((plugin) => [plugin.name, plugin]));
        return found.map((result) => {
            const plugin: T | undefined = installed.get(result.name);
            return {
                ...result,
                allowed: matchesAllowedPackage(result.name, this.allowedPackages),
                installedUid: plugin?.uid,
                installedVersion: plugin?.packageVersion,
                updateAvailable: !!plugin && isNewerVersion(result.version, plugin.packageVersion),
            };
        });
    }

    /** For each installed plugin, the registry's latest version and whether it's newer than the installed one. A plugin
     * the registry can't be checked for reports an `error` rather than failing the whole request, and one outside the
     * allow-list never reports an update, since upgrading it would be refused. */
    @RequiresTrustedRole()
    @Get("/updates")
    public async updates(): Promise<PluginUpdateInfo[]> {
        const plugins: T[] = (await this.installedPlugins()).sort((a, b) => a.name.localeCompare(b.name));
        return Promise.all(
            plugins.map(async (plugin): Promise<PluginUpdateInfo> => {
                const allowed: boolean = matchesAllowedPackage(plugin.name, this.allowedPackages);
                const base = { uid: plugin.uid, name: plugin.name, installedVersion: plugin.packageVersion, allowed };
                try {
                    const latestVersion: string | undefined = (await this.createRegistryClient(plugin.name).getPackage(plugin.name))?.latest;
                    const newer: boolean = !!latestVersion && isNewerVersion(latestVersion, plugin.packageVersion);
                    return { ...base, latestVersion, updateAvailable: allowed && newer };
                } catch (err: any) {
                    return { ...base, updateAvailable: false, error: err.message };
                }
            }),
        );
    }

    @RequiresTrustedRole()
    @Get("/registry/:name")
    public async lookup(@Param("name") name: string, @Query("packageVersion") packageVersion?: string): Promise<PluginRegistryLookup> {
        this.assertAllowed(name);
        const session: RegistrySession = this.registrySession();
        const pkg: RegistryPackage | undefined = await this.registryCall(() => session.getPackage(name));
        if (!pkg) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, `'${name}' was not found in the plugin registry.`);
        }
        const selected = await this.lookupVersion(session, name, packageVersion);
        return { package: pkg, selected };
    }

    /** What adding `name` (or changing it, when installed) at `packageVersion` - default the registry's `latest` - would
     * also install and enable, and any conflicts that would refuse it. Nothing is changed. */
    @RequiresTrustedRole()
    @Get("/plan")
    public async plan(@Query("name") name?: string, @Query("packageVersion") packageVersion?: string): Promise<PluginPlanResponse> {
        const trimmed: string = typeof name === "string" ? name.trim() : "";
        if (!trimmed) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'name' is required.");
        }
        this.assertAllowed(trimmed);
        const session: RegistrySession = this.registrySession();
        const found = await this.lookupVersion(session, trimmed, packageVersion);
        const installed: T[] = await this.installedPlugins();
        const plan: PluginChangePlan = await planPluginChange(
            installed,
            { name: trimmed, version: found.version, manifest: found.manifest },
            this.plannerRegistry(session),
            { allowed: (dependency) => matchesAllowedPackage(dependency, this.allowedPackages) },
        );
        return { plugin: { name: trimmed, version: found.version, manifest: found.manifest }, ...plan };
    }

    /** Adds a plugin, installing and enabling the plugins it requires first. Refused with a `409` when a requirement
     * can't be met without changing the version of an installed plugin, or when `expectedPlan` no longer matches. */
    @RequiresTrustedRole()
    @Post()
    public async add(obj: AddPluginRequest | undefined, @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<AddPluginResponse<T>> {
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
        const plan: PluginChangePlan = await this.planOrRefuse(session, installed, name, found.version, found.manifest);
        this.assertExpectedPlan(obj?.expectedPlan, plan);

        return this.applyChange(async (undo) => {
            const dependencies: T[] = await this.applyPlan(plan, installed, req, user, undo);
            const created: T = await this.installRow({ name, version: found.version, integrity: found.integrity, manifest: found.manifest }, user, undo);
            await this.audit(req, user, AuditAction.PLUGIN_INSTALL, created, { packageVersion: found.version });
            return { plugin: created, dependencies };
        });
    }

    @RequiresTrustedRole()
    @Put("/:id")
    public async update(
        @Param("id") id: string,
        obj: UpdatePluginRequest | undefined,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        await this.init();
        const existing: T = await this.findInstalled(id);
        const patch: Partial<Plugin> = {};
        let manifest: PluginManifest = existing.manifest;
        let dependencyPlan: PluginChangePlan | undefined;
        const session: RegistrySession = this.registrySession();

        const changingVersion: boolean = obj?.packageVersion !== undefined && obj.packageVersion !== existing.packageVersion;
        if (changingVersion || (obj?.enabled === true && !existing.enabled)) {
            // An allow-list narrowed since the plugin was added also stops it being re-enabled or moved to another version.
            this.assertAllowed(existing.name);
        }
        if (changingVersion) {
            const found = await this.lookupVersion(session, existing.name, obj!.packageVersion);
            manifest = found.manifest;
            patch.packageVersion = found.version;
            patch.integrity = found.integrity ?? (null as any);
            patch.manifest = found.manifest;
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
            const known: Set<string> = new Set(manifest.settings!.map((setting) => setting.key));
            const candidate: Record<string, unknown> =
                obj?.settings ?? Object.fromEntries(Object.entries(existing.settings).filter(([key]) => known.has(key)));
            try {
                patch.settings = validatePluginSettings(manifest, candidate);
            } catch (err: any) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, err.message);
            }
        }
        this.assertExpectedPlan(obj?.expectedPlan, dependencyPlan ?? { install: [], enable: [] });

        if (dependencyPlan && obj?.version !== undefined && obj.version !== existing.version) {
            // Checked before any dependency is touched, so a stale edit changes nothing.
            throw new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, ApiErrorMessages.INVALID_OBJECT_VERSION);
        }
        return this.applyChange(async (undo) => {
            if (dependencyPlan) {
                await this.applyPlan(dependencyPlan, installed, req, user, undo);
            }
            const updated: T = await this.pluginRepo!.update({ uid: existing.uid, version: obj?.version ?? existing.version, ...patch } as any, existing, {
                user,
                version: obj?.version,
                ignoreACL: true,
            });
            await this.audit(req, user, AuditAction.PLUGIN_UPDATE, updated, {
                packageVersion: updated.packageVersion,
                enabled: updated.enabled,
                settingsChanged: patch.settings !== undefined,
            });
            return updated;
        });
    }

    @RequiresTrustedRole()
    @Delete("/:id")
    public async remove(@Param("id") id: string, @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<void> {
        const existing: T = await this.findInstalled(id);
        this.assertNoDependents(await this.installedPlugins(), existing, "uninstalled");
        await this.pluginRepo!.update({ uid: existing.uid, version: existing.version, enabled: false, removed: true } as any, existing, {
            user,
            ignoreACL: true,
        });
        await this.audit(req, user, AuditAction.PLUGIN_REMOVE, existing, { packageVersion: existing.packageVersion });
        await this.announce();
    }
}
