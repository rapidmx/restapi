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

    private async fetchPackument(name: string): Promise<any | undefined> {
        // Scoped names keep their `@` but encode the `/`, per the registry API.
        const url: string = `${this.registryUrl.replace(/\/+$/, "")}/${name.replace("/", "%2f")}`;
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
