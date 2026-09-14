///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * The plugin contract shared by the server host and plugin packages: manifest parsing and validation, the
 * loaded-plugin registry, the `@MailboxScopedData()` erasure hook and the registry metadata client.
 */
export * from "./NpmRegistryClient.js";
export * from "./PluginRegistry.js";
export * from "./PluginUtils.js";
export * from "./PluginDependencies.js";
