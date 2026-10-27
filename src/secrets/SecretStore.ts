///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { SecretBackend, SecretRef } from "../models/types.js";

/**
 * Holds the credentials an administrator saves in the console outside the database: rows keep only the `SecretRef` a write returns. Only plugin secret settings
 * are still kept this way, until restapi's step R4 removes the store: DNS provider credentials and the Integrations secrets (the Giphy key, the registry
 * and namespace tokens) are encrypted on their own rows (`ConfigCipher`, spec 5).
 *
 * This library defines the abstraction and the server registers the implementation under the DI token `"SecretStore"` (OpenBao KV when the deployment has
 * OpenBao, else Kubernetes Secrets written through the DNS controller), the same split as `BlobStore` and `DkimKeyProvider`. `NullSecretStore` is the default
 * and refuses to save (400), so a deployment without a store refuses credentials rather than keeping them anywhere else - with one exception: plugin
 * secret settings, which a deployment without a store keeps on the plugin's row as it always has (the plugin route never writes them to `NullSecretStore`)
 * until a store is registered and `PluginSecretMigrator` moves them (spec 5.4).
 *
 * Plugin secret settings are at `plugins/<package>/<key>-<random>` (`pluginSecretPath()`, at most 253 characters), a new path for every write, never one
 * fixed path per setting, so a policy or a mapping for them covers the prefix.
 *
 * An implementation never puts a value in a log line or an error message.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface SecretStore {
    /** The backend new references are written to, or `"none"` for `NullSecretStore`: what code that can do without a store (the plugin-secret migration)
     * checks before using it. */
    readonly backend: SecretBackend | "none";

    /** Replaces the whole secret at `path` with `values`, returning the reference to persist. */
    write(path: string, values: Record<string, string>): Promise<SecretRef>;

    /** Merges `values` into the secret (keys not given are kept, `null` removes one): what a write-only form with some fields left alone sends
     * (`toSecretPatch()`). Returns the updated reference, `generation` bumped. */
    patch(ref: SecretRef, values: Record<string, string | null>): Promise<SecretRef>;

    /** Only for secrets the server itself consumes (the Giphy key, the registry token, plugin secrets). DNS credentials are never readable by the server. */
    read(ref: SecretRef): Promise<Record<string, string>>;

    /** Removes the secret. One that is already gone resolves, so a retried removal of the row that held the reference isn't blocked by it. */
    delete(ref: SecretRef): Promise<void>;
}
