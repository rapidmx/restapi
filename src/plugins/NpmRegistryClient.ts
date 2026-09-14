///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { PluginManifest } from "../models/types.js";
import { parsePluginManifest } from "./PluginUtils.js";

/** The npm registry used when `system:plugins:registry` isn't configured. */
export const DEFAULT_PLUGIN_REGISTRY = "https://registry.npmjs.org";

/** One published version of a package, as far as the plugin system cares. */
export interface RegistryPackageVersion {
    name: string;
    version: string;
    description?: string;
    /** The registry's `dist.integrity` (SRI) for the version's tarball. */
    integrity?: string;
    peerDependencies: Record<string, string>;
    /** The parsed plugin manifest, or the reason the version isn't a loadable plugin. */
    manifest: PluginManifest | string;
}

/** A package's published versions, newest first, plus its `latest` tag. */
export interface RegistryPackage {
    name: string;
    latest?: string;
    versions: string[];
}

/** A package found by `NpmRegistryClient.searchPlugins()`. */
export interface RegistrySearchResult {
    name: string;
    /** The latest published version. */
    version: string;
    description?: string;
    /** When `version` was published (ISO 8601), if the registry reports it. */
    date?: string;
}

/** The naming convention a plugin package follows, which registry search relies on. */
export const PLUGIN_PACKAGE_SUFFIX = "-plugin";

/** Registry search pages this many results at a time (npm's own maximum). */
const SEARCH_PAGE_SIZE = 250;

/** Stops paging after this many results, so a misbehaving registry can't make a search run forever. */
const SEARCH_MAX_RESULTS = 1000;

/** Thrown when the registry can't answer - `status` is the HTTP status, or `undefined` for a network error. */
export class RegistryRequestError extends Error {
    constructor(
        message: string,
        public readonly status?: number,
    ) {
        super(message);
    }
}

/**
 * Reads package metadata from an npm-compatible registry, so an administrator can see a plugin's versions and
 * manifest before adding it. It never downloads a tarball - installing is the server host's job.
 *
 * @author Jean-Philippe Steinmetz
 */
export class NpmRegistryClient {
    constructor(
        private readonly registryUrl: string = DEFAULT_PLUGIN_REGISTRY,
        private readonly authToken?: string,
    ) {}

    /** The package's versions, newest first. Resolves `undefined` when the registry has no such package. */
    public async getPackage(name: string): Promise<RegistryPackage | undefined> {
        const packument: any = await this.fetchPackument(name);
        if (!packument) {
            return undefined;
        }
        const versions: string[] = Object.keys(packument.versions ?? {});
        const times: Record<string, string> = packument.time ?? {};
        versions.sort((a, b) => (times[b] ?? "").localeCompare(times[a] ?? "") || b.localeCompare(a));
        return { name: packument.name ?? name, latest: packument["dist-tags"]?.latest, versions };
    }

    /** One version of the package - `version` may be an exact version or a dist-tag such as `latest`.
     * Resolves `undefined` when the package or version doesn't exist. */
    public async getVersion(name: string, version: string = "latest"): Promise<RegistryPackageVersion | undefined> {
        const packument: any = await this.fetchPackument(name);
        if (!packument) {
            return undefined;
        }
        const resolved: string = packument["dist-tags"]?.[version] ?? version;
        const pkg: any = packument.versions?.[resolved];
        if (!pkg) {
            return undefined;
        }
        return {
            name: pkg.name ?? name,
            version: resolved,
            description: pkg.description,
            integrity: pkg.dist?.integrity,
            peerDependencies: pkg.peerDependencies ?? {},
            manifest: parsePluginManifest(pkg),
        };
    }

    /**
     * Every package in `namespace` (an npm scope such as `@rapidmx`) whose name ends in `-plugin`, sorted by name.
     * Uses the registry's search API (`/-/v1/search`, which npm and Verdaccio both serve); a name match only - whether a
     * package really is a plugin is still checked from its manifest when it's added.
     */
    public async searchPlugins(namespace: string): Promise<RegistrySearchResult[]> {
        const scope: string = namespace.replace(/^@/, "");
        const results: Map<string, RegistrySearchResult> = new Map();
        for (let from = 0; from < SEARCH_MAX_RESULTS; from += SEARCH_PAGE_SIZE) {
            const query = new URLSearchParams({ text: `scope:${scope}`, size: String(SEARCH_PAGE_SIZE), from: String(from) });
            const page: any = await this.request(`/-/v1/search?${query.toString()}`);
            const objects: any[] = Array.isArray(page?.objects) ? page.objects : [];
            for (const object of objects) {
                const pkg: any = object?.package;
                if (typeof pkg?.name === "string" && pkg.name.startsWith(`@${scope}/`) && pkg.name.endsWith(PLUGIN_PACKAGE_SUFFIX)) {
                    results.set(pkg.name, { name: pkg.name, version: pkg.version, description: pkg.description, date: pkg.date });
                }
            }
            if (objects.length < SEARCH_PAGE_SIZE) {
                break;
            }
        }
        return [...results.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    private async fetchPackument(name: string): Promise<any | undefined> {
        // Scoped names keep their `@` but encode the `/`, per the registry API.
        return this.request(`/${name.replace("/", "%2f")}`);
    }

    /** GETs `path` from the registry as JSON. Resolves `undefined` for a 404. */
    private async request(path: string): Promise<any | undefined> {
        const url: string = `${this.registryUrl.replace(/\/+$/, "")}${path}`;
        const headers: Record<string, string> = { Accept: "application/json" };
        if (this.authToken) {
            headers.Authorization = `Bearer ${this.authToken}`;
        }
        let response: Response;
        try {
            response = await fetch(url, { headers });
        } catch (err: any) {
            throw new RegistryRequestError(`Could not reach the plugin registry: ${err.message}`);
        }
        if (response.status === 404) {
            return undefined;
        }
        if (!response.ok) {
            throw new RegistryRequestError(`The plugin registry responded with HTTP ${response.status}.`, response.status);
        }
        return response.json();
    }
}
