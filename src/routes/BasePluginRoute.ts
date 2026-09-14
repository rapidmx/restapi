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
} from "../plugins/NpmRegistryClient.js";
import {
    computePluginStateHash,
    DEFAULT_ALLOWED_PLUGIN_PACKAGES,
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
    private allowedPackages: string[] = DEFAULT_ALLOWED_PLUGIN_PACKAGES;

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

    /** The registry client - overridable so tests can answer without a network. */
    protected createRegistryClient(): NpmRegistryClient {
        return new NpmRegistryClient(this.registryUrl, this.registryToken || undefined);
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
        let found: RegistryPackageVersion | undefined;
        try {
            found = await this.createRegistryClient().getVersion(name, packageVersion || "latest");
        } catch (err: any) {
            if (err instanceof RegistryRequestError) {
                throw new ApiError(ApiErrors.INTERNAL_ERROR, 502, err.message);
            }
            throw err;
        }
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

    @RequiresTrustedRole()
    @Get("/registry/:name")
    public async lookup(@Param("name") name: string, @Query("packageVersion") packageVersion?: string): Promise<PluginRegistryLookup> {
        this.assertAllowed(name);
        const selected = await this.lookupVersion(name, packageVersion);
        const pkg: RegistryPackage | undefined = await this.createRegistryClient().getPackage(name);
        return { package: pkg!, selected };
    }

    @RequiresTrustedRole()
    @Post()
    public async add(obj: AddPluginRequest | undefined, @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T> {
        const name: string = typeof obj?.name === "string" ? obj.name.trim() : "";
        if (!name) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'name' is required.");
        }
        this.assertAllowed(name);
        await this.init();
        const [existing]: T[] = await this.pluginRepo!.find({ name } as any, { ignoreACL: true, limit: 1 });
        if (existing && !existing.removed) {
            throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, `'${name}' is already installed.`);
        }
        const found = await this.lookupVersion(name, obj?.packageVersion);

        const fields: Partial<Plugin> = {
            name,
            packageVersion: found.version,
            integrity: found.integrity,
            enabled: true,
            removed: false,
            settings: defaultPluginSettings(found.manifest),
            manifest: found.manifest,
        };
        // A previously removed plugin's row is revived rather than duplicated - see `Plugin.removed`.
        const created: T = existing
            ? await this.pluginRepo!.update({ uid: existing.uid, version: existing.version, ...fields } as any, existing, {
                  user,
                  ignoreACL: true,
              })
            : await this.pluginRepo!.create(new this.pluginClass(fields), { user, ignoreACL: true });
        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, req, user, logger: this.logger },
            { action: AuditAction.PLUGIN_INSTALL, targetType: "Plugin", targetUid: created.uid, details: { name, packageVersion: found.version } },
        );
        await this.announce();
        return created;
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

        const updated: T = await this.pluginRepo!.update({ uid: existing.uid, version: obj?.version ?? existing.version, ...patch } as any, existing, {
            user,
            version: obj?.version,
            ignoreACL: true,
        });
        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, req, user, logger: this.logger },
            {
                action: AuditAction.PLUGIN_UPDATE,
                targetType: "Plugin",
                targetUid: updated.uid,
                details: {
                    name: updated.name,
                    packageVersion: updated.packageVersion,
                    enabled: updated.enabled,
                    settingsChanged: patch.settings !== undefined,
                },
            },
        );
        await this.announce();
        return updated;
    }

    @RequiresTrustedRole()
    @Delete("/:id")
    public async remove(@Param("id") id: string, @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<void> {
        const existing: T = await this.findInstalled(id);
        await this.pluginRepo!.update({ uid: existing.uid, version: existing.version, enabled: false, removed: true } as any, existing, {
            user,
            ignoreACL: true,
        });
        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, req, user, logger: this.logger },
            {
                action: AuditAction.PLUGIN_REMOVE,
                targetType: "Plugin",
                targetUid: existing.uid,
                details: { name: existing.name, packageVersion: existing.packageVersion },
            },
        );
        await this.announce();
    }
}
