///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";

/** A plugin that is loaded in this server process. */
export interface LoadedPlugin {
    name: string;
    version: string;
}

const MAILBOX_SCOPED_METADATA_KEY = "rapidmx:mailboxScopedData";

/**
 * The plugins loaded into this process. The host sets it once, before any plugin class is instantiated, and
 * never changes it afterwards (a change to the installed set restarts the process). A plugin can read it to
 * adapt to its siblings - e.g. Autodiscover only advertises ActiveSync when the ActiveSync plugin is loaded.
 *
 * Module state rather than a DI token on purpose: the host refuses to load a plugin that resolves its own copy
 * of this library, so every plugin sees this same module instance, and nothing has to be registered for code
 * running without a plugin host (such as this library's own tests) to get a correct empty answer.
 */
export class PluginRegistry {
    private static plugins: LoadedPlugin[] = [];

    /** Replaces the loaded plugin list. Called by the host only. */
    public static setLoaded(plugins: LoadedPlugin[]): void {
        PluginRegistry.plugins = plugins.map((plugin) => ({ ...plugin }));
    }

    public static list(): LoadedPlugin[] {
        return PluginRegistry.plugins.map((plugin) => ({ ...plugin }));
    }

    public static isActive(name: string): boolean {
        return PluginRegistry.plugins.some((plugin) => plugin.name === name);
    }
}

/**
 * Marks a plugin's model as holding per-mailbox data in a `mailboxUid` field, so `ErasureExecutionJob` purges
 * its rows along with the rest of an erased mailbox's content. Without it, a plugin's data would outlive a
 * data-subject erasure.
 */
export function MailboxScopedData(): ClassDecorator {
    return (target: any) => {
        Reflect.defineMetadata(MAILBOX_SCOPED_METADATA_KEY, true, target);
    };
}

/** Whether `clazz` was decorated with `@MailboxScopedData()`. */
export function isMailboxScopedData(clazz: any): boolean {
    return typeof clazz === "function" && Reflect.getMetadata(MAILBOX_SCOPED_METADATA_KEY, clazz) === true;
}
