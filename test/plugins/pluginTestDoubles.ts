///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Shared by the Mongo and SQL Plugin route harnesses: an in-memory registry and recorders for the Redis side
// effects, so the route tests need neither a network nor Redis.
import {
    NpmRegistryClient,
    RegistryPackage,
    RegistryPackageVersion,
    RegistryRequestError,
    RegistrySearchResult,
} from "../../src/plugins/NpmRegistryClient.js";
import { parsePluginManifest, PluginInstanceStatus } from "../../src/plugins/PluginUtils.js";

/** Package name -> version -> package.json, in publish order. `latest` is the last version listed. */
export const fakeRegistryPackages: Map<string, Map<string, any>> = new Map();

/** Registry clients the route asked for, by the package or namespace it passed. */
export const registryClientRequests: (string | undefined)[] = [];

/** Makes `searchPlugins()` fail for these namespaces. */
export const failingSearchNamespaces: Set<string> = new Set();

/** Makes `getPackage()` fail for these packages. */
export const brokenPackages: Set<string> = new Set();

/** Every hash the route announced, in order. */
export const publishedHashes: string[] = [];

/** What `GET /status` reads back. */
export const instanceStatuses: PluginInstanceStatus[] = [];

export function resetPluginTestDoubles(): void {
    fakeRegistryPackages.clear();
    publishedHashes.length = 0;
    registryClientRequests.length = 0;
    failingSearchNamespaces.clear();
    brokenPackages.clear();
    instanceStatuses.length = 0;
}

/** Publishes a package version to the fake registry. */
export function publishFakePackage(name: string, version: string, rapidmx?: any, extra: Record<string, any> = {}): void {
    const versions: Map<string, any> = fakeRegistryPackages.get(name) ?? new Map();
    versions.set(version, { name, version, rapidmx, dist: { integrity: `sha512-${name}@${version}` }, ...extra });
    fakeRegistryPackages.set(name, versions);
}

export class FakeRegistryClient extends NpmRegistryClient {
    public async searchPlugins(namespace: string): Promise<RegistrySearchResult[]> {
        const scope: string = namespace.startsWith("@") ? namespace : `@${namespace}`;
        if (failingSearchNamespaces.has(scope)) {
            throw new RegistryRequestError("The plugin registry responded with HTTP 503.", 503);
        }
        return [...fakeRegistryPackages.entries()]
            .filter(([name]) => name.startsWith(`${scope}/`) && name.endsWith("-plugin"))
            .map(([name, versions]) => {
                const version: string = [...versions.keys()].pop()!;
                return { name, version, description: versions.get(version).description };
            });
    }

    public async getPackage(name: string): Promise<RegistryPackage | undefined> {
        if (brokenPackages.has(name)) {
            throw new RegistryRequestError("registry offline");
        }
        const versions = fakeRegistryPackages.get(name);
        if (!versions) {
            return undefined;
        }
        const list: string[] = [...versions.keys()];
        return { name, latest: list[list.length - 1], versions: list.reverse() };
    }

    public async getVersion(name: string, version: string = "latest"): Promise<RegistryPackageVersion | undefined> {
        const versions = fakeRegistryPackages.get(name);
        if (!versions) {
            return undefined;
        }
        const resolved: string = version === "latest" ? [...versions.keys()].pop()! : version;
        const pkg: any = versions.get(resolved);
        if (!pkg) {
            return undefined;
        }
        if (pkg.fail) {
            throw pkg.fail;
        }
        return {
            name,
            version: resolved,
            description: pkg.description,
            integrity: pkg.dist.integrity,
            peerDependencies: {},
            manifest: parsePluginManifest(pkg),
        };
    }
}
