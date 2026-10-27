///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { IntegrationSettings } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `IntegrationSettings` interface for storage in a SQL database. If MongoDB is desired, please use
 * `models.mongo.IntegrationSettingsMongo` instead. Each section is one JSON column, `null` while none of its fields is set.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description("The administrator's Integrations settings, overriding the deployment's configuration; secrets only as encrypted envelopes.")
@Protect(
    {
        uid: "IntegrationSettings",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class IntegrationSettingsSQL extends BaseEntity implements IntegrationSettings {
    @Column({ type: "simple-json", nullable: true })
    @Description("GIF search: whether it is on, and its API key as an encrypted envelope.")
    @Nullable
    public giphy?: IntegrationSettings["giphy"];

    @Column({ type: "simple-json", nullable: true })
    @Description("The STUN servers meetings use.")
    @Nullable
    public stun?: IntegrationSettings["stun"];

    @Column({ type: "simple-json", nullable: true })
    @Description("How S/MIME signing certificates are enrolled.")
    @Nullable
    public signingCa?: IntegrationSettings["signingCa"];

    @Column({ type: "simple-json", nullable: true })
    @Description("How the server resolves DNS.")
    @Nullable
    public dnsResolver?: IntegrationSettings["dnsResolver"];

    @Column({ type: "simple-json", nullable: true })
    @Description("Where plugins are installed from, with the tokens as encrypted envelopes.")
    @Nullable
    public pluginRegistry?: IntegrationSettings["pluginRegistry"];

    constructor(other?: Partial<IntegrationSettingsSQL>) {
        super(other);

        if (other) {
            this.giphy = "giphy" in other ? other.giphy : this.giphy;
            this.stun = "stun" in other ? other.stun : this.stun;
            this.signingCa = "signingCa" in other ? other.signingCa : this.signingCa;
            this.dnsResolver = "dnsResolver" in other ? other.dnsResolver : this.dnsResolver;
            this.pluginRegistry = "pluginRegistry" in other ? other.pluginRegistry : this.pluginRegistry;
        }
    }
}
