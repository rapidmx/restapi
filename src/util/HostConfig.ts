///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** What `HostConfig.install()` takes: the server's live `nconf` instance, or anything else that reads a value by `nconf` key (`a:b:c`). */
export interface HostConfigSource {
    get(key: string): unknown;
}

/** What `HostConfig.install()` returns: the only way to remove that installation (it does nothing once that installation is gone). */
export type HostConfigUninstall = () => void;

// Module-scoped rather than a static field: a `private` static is still `HostConfig["source"]` at run time, and this must be out of everyone's reach.
let installed: HostConfigSource | undefined;

/**
 * Read-only access to the host server's live configuration at use time.
 *
 * `@Config` fields are a startup snapshot (`ObjectFactory` assigns them once, and its `config` is protected), so a value the server changes while running -
 * the integrations layer an administrator edits in the console, such as `integrations:stun:urls` or `giphy:api_key` - is only seen by code that reads it
 * here, per use. The server installs its `nconf` instance at startup, before it loads any plugin (`HostConfig.install(config)`); before that, and in a
 * process with no host (this library's own tests, a plugin run outside the server), every read is `undefined`, so a caller keeps a fallback (the meet
 * plugin's built-in STUN list).
 *
 * Reading isn't restricted (plugins may already read core keys with `@Config`), but nothing can write through it or change what it reads. Plugins share
 * this class with the server (restapi is their peer dependency), so: there is no setter; an object or array value is returned as a copy; a configuration is
 * installed once (a later `install()` throws), and only the handle that installation returned removes it; and the class is frozen, so `get` can't be
 * replaced.
 *
 * @author Jean-Philippe Steinmetz
 */
export class HostConfig {
    /**
     * Makes `source` the configuration every later read sees. Called once by the host server, when its configuration is built; throws when one is already
     * installed. Returns the handle that removes it again (for tests and shutdown).
     */
    public static install(source: HostConfigSource): HostConfigUninstall {
        if (typeof source?.get !== "function") {
            throw new TypeError("HostConfig.install() needs a configuration with a get(key) method.");
        }
        if (installed !== undefined) {
            throw new Error("HostConfig already has a configuration installed: only the host installs one, once.");
        }
        installed = source;
        return () => {
            if (installed === source) {
                installed = undefined;
            }
        };
    }

    /** Whether a host has installed its configuration. */
    public static isInstalled(): boolean {
        return installed !== undefined;
    }

    /**
     * The current value of `key` (an `nconf` key, `:`-separated), or `undefined` when it isn't set or no configuration is installed. An object or array
     * value is a deep copy.
     */
    public static get<T = unknown>(key: string): T | undefined {
        if (typeof key !== "string" || key.length === 0) {
            throw new TypeError("HostConfig.get() needs a configuration key.");
        }
        const value: unknown = installed?.get(key);
        return (typeof value === "object" && value !== null ? structuredClone(value) : value) as T | undefined;
    }
}
Object.freeze(HostConfig);
