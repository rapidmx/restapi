///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { Plugin, PluginManifest } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `Plugin` interface for storage in a SQL database. If MongoDB is desired, please use
 * `models.mongo.PluginMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Index("plugin_name", ["name"], { unique: true })
@Description("A plugin package installed on this deployment.")
@Protect(
    {
        uid: "Plugin",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class PluginSQL extends BaseEntity implements Plugin {
    @Column()
    @Description("The npm package name.")
    public name: string = "";

    @Column()
    @Description("The exact npm version to install.")
    public packageVersion: string = "";

    @Column({ nullable: true })
    @Description("The registry's integrity hash for this version.")
    @Nullable
    public integrity?: string;

    @Column()
    @Description("Whether server copies load this plugin.")
    public enabled: boolean = true;

    @Column({ nullable: true })
    @Description("Whether an administrator removed this plugin.")
    @Nullable
    public removed?: boolean;

    @Column({ type: "simple-json" })
    @Description("Saved setting values, keyed by config key.")
    public settings: Record<string, string | number | boolean> = {};

    @Column({ type: "simple-json" })
    @Description("A snapshot of the package's plugin manifest for this version.")
    public manifest: PluginManifest = { apiVersion: 0, displayName: "" };

    constructor(other?: Partial<PluginSQL>) {
        super(other);

        if (other) {
            this.name = other.name !== undefined ? other.name : this.name;
            this.packageVersion = other.packageVersion !== undefined ? other.packageVersion : this.packageVersion;
            this.integrity = "integrity" in other ? other.integrity : this.integrity;
            this.enabled = other.enabled !== undefined ? other.enabled : this.enabled;
            this.removed = "removed" in other ? other.removed : this.removed;
            this.settings = other.settings !== undefined ? other.settings : this.settings;
            this.manifest = other.manifest !== undefined ? other.manifest : this.manifest;
        }
    }
}
