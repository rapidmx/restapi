///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, HttpRequest, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { createClient } from "redis";
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

/** The body of `POST /` - `packageVersion` defaults to the registry's `latest`. */
export interface AddPluginRequest {
    name?: string;
    packageVersion?: string;
}

/** The body of `PUT /:id`. `version` is the row's optimistic-lock counter, as everywhere else. */
export interface UpdatePluginRequest {
    version?: number;
    packageVersion?: string;
    enabled?: boolean;
    settings?: Record<string, unknown>;
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
    updateAvailable: boolean;
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
    private allowedPackagesConfig: string[] = DEFAULT_ALLOWED_PLUGIN_PACKAGES;

    @Config("system:plugins:namespaces", DEFAULT_PLUGIN_NAMESPACES)
    private namespacesConfig: unknown = DEFAULT_PLUGIN_NAMESPACES;

    @Config("datastores:events", null)
    private eventsConfig: any;

    @Config("datastores:cache", null)
    private cacheConfig: any;

    @Logger
    private logger: any;

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
        return normalizePluginNamespaces(this.namespacesConfig);
    }

    /** `system:plugins:allowed_packages` plus every package in a configured namespace. */
    protected get allowedPackages(): string[] {
        return [...this.allowedPackagesConfig, ...this.namespaces.map((namespace) => `${namespace.name}/*`)];
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
        if (!matchesAllowedPackage(name, this.allowedPackages)) {
            throw new ApiError(
                ApiErrors.INVALID_REQUEST,
                400,
                `'${name}' is not an allowed plugin package. Allowed: ${this.allowedPackages.join(", ")}.`,
            );
        }
    }

    /** Resolves a package version from the registry, turning its failure modes into API errors. */
    private async lookupVersion(name: string, packageVersion?: string): Promise<RegistryPackageVersion & { manifest: PluginManifest }> {
        const found: RegistryPackageVersion | undefined = await this.registryCall(() =>
            this.createRegistryClient(name).getVersion(name, packageVersion || "latest"),
        );
        if (!found) {
            throw new ApiError(
                ApiErrors.NOT_FOUND,
                404,
                packageVersion ? `'${name}@${packageVersion}' was not found in the plugin registry.` : `'${name}' was not found in the plugin registry.`,
            );
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

    /** The registry as the dependency planner reads it, with each package read from its namespace's registry. */
    private get plannerRegistry(): PlannerRegistry {
        return {
            versions: async (name) => (await this.registryCall(() => this.createRegistryClient(name).getPackage(name)))?.versions,
            version: (name, version) => this.registryCall(() => this.createRegistryClient(name).getVersion(name, version)),
        };
    }

    /** Plans a change, refusing it with a `409` that explains every conflict. */
    private async planOrRefuse(installed: T[], name: string, version: string, manifest: PluginManifest): Promise<PluginChangePlan> {
        const plan: PluginChangePlan = await planPluginChange(installed, { name, version, manifest }, this.plannerRegistry, {
            allowed: (dependency) => matchesAllowedPackage(dependency, this.allowedPackages),
        });
        if (plan.conflicts.length > 0) {
            throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, plan.conflicts.join(" "));
        }
        return plan;
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

    /** Creates, or revives the removed row of, a plugin at a resolved version. */
    private async installRow(install: PlannedPluginInstall, user: JWTUser | undefined): Promise<T> {
        const [existing]: T[] = await this.pluginRepo!.find({ name: install.name } as any, { ignoreACL: true, limit: 1 });
        const fields: Partial<Plugin> = {
            name: install.name,
            packageVersion: install.version,
            integrity: install.integrity,
            enabled: true,
            removed: false,
            settings: defaultPluginSettings(install.manifest),
            manifest: install.manifest,
        };
        // A previously removed plugin's row is revived rather than duplicated - see `Plugin.removed`.
        return existing
            ? this.pluginRepo!.update({ uid: existing.uid, version: existing.version, ...fields } as any, existing, { user, ignoreACL: true })
            : this.pluginRepo!.create(new this.pluginClass(fields), { user, ignoreACL: true });
    }

    /** Installs and enables what a plan needs, dependencies first, and returns the rows it changed. */
    private async applyPlan(plan: PluginChangePlan, installed: T[], req: HttpRequest, user: JWTUser | undefined): Promise<T[]> {
        const changed: T[] = [];
        for (const install of plan.install) {
            const row: T = await this.installRow(install, user);
            await this.audit(req, user, AuditAction.PLUGIN_INSTALL, row, { packageVersion: row.packageVersion });
            changed.push(row);
        }
        for (const name of plan.enable) {
            const existing: T = installed.find((row) => row.name === name)!;
            const row: T = await this.pluginRepo!.update({ uid: existing.uid, version: existing.version, enabled: true } as any, existing, {
                user,
                ignoreACL: true,
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
     * version and marked with whether it may be added, whether it's installed, and whether that install is outdated. */
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
        const found: RegistrySearchResult[] = pages.flat().sort((a, b) => a.name.localeCompare(b.name));
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
     * the registry can't be checked for reports an `error` rather than failing the whole request. */
    @RequiresTrustedRole()
    @Get("/updates")
    public async updates(): Promise<PluginUpdateInfo[]> {
        const plugins: T[] = (await this.installedPlugins()).sort((a, b) => a.name.localeCompare(b.name));
        return Promise.all(
            plugins.map(async (plugin): Promise<PluginUpdateInfo> => {
                const base = { uid: plugin.uid, name: plugin.name, installedVersion: plugin.packageVersion };
                try {
                    const latestVersion: string | undefined = (await this.createRegistryClient(plugin.name).getPackage(plugin.name))?.latest;
                    return { ...base, latestVersion, updateAvailable: !!latestVersion && isNewerVersion(latestVersion, plugin.packageVersion) };
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
        const selected = await this.lookupVersion(name, packageVersion);
        const pkg: RegistryPackage | undefined = await this.createRegistryClient(name).getPackage(name);
        return { package: pkg!, selected };
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
        const found = await this.lookupVersion(trimmed, packageVersion);
        const installed: T[] = await this.installedPlugins();
        const plan: PluginChangePlan = await planPluginChange(installed, { name: trimmed, version: found.version, manifest: found.manifest }, this.plannerRegistry, {
            allowed: (dependency) => matchesAllowedPackage(dependency, this.allowedPackages),
        });
        return { plugin: { name: trimmed, version: found.version, manifest: found.manifest }, ...plan };
    }

    /** Adds a plugin, installing and enabling the plugins it requires first. Refused with a `409` when a requirement
     * can't be met without changing the version of an installed plugin. */
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
        const found = await this.lookupVersion(name, obj?.packageVersion);
        const plan: PluginChangePlan = await this.planOrRefuse(installed, name, found.version, found.manifest);

        const dependencies: T[] = await this.applyPlan(plan, installed, req, user);
        const created: T = await this.installRow({ name, version: found.version, integrity: found.integrity, manifest: found.manifest }, user);
        await this.audit(req, user, AuditAction.PLUGIN_INSTALL, created, { packageVersion: found.version });
        await this.announce();
        return { plugin: created, dependencies };
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

        if (obj?.packageVersion !== undefined && obj.packageVersion !== existing.packageVersion) {
            const found = await this.lookupVersion(existing.name, obj.packageVersion);
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
            dependencyPlan = await this.planOrRefuse(installed, existing.name, patch.packageVersion ?? existing.packageVersion, manifest);
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

        if (dependencyPlan && obj?.version !== undefined && obj.version !== existing.version) {
            // Checked before any dependency is touched, so a stale edit changes nothing.
            throw new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, ApiErrorMessages.INVALID_OBJECT_VERSION);
        }
        if (dependencyPlan) {
            await this.applyPlan(dependencyPlan, installed, req, user);
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
        await this.announce();
        return updated;
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
