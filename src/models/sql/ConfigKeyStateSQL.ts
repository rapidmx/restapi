///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { ConfigKeyState } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `ConfigKeyState` interface for storage in a SQL database. If MongoDB is desired, please use `models.mongo.ConfigKeyStateMongo`
 * instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description("The configuration keyring's progress: the active key, the current rotation and the encryption of plugin secret settings. Never key material.")
@Protect(
    {
        uid: "ConfigKeyState",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class ConfigKeyStateSQL extends BaseEntity implements ConfigKeyState {
    @Column({ type: "varchar", nullable: true })
    @Description("The key new values are encrypted with. Unset until a rotation activates one.")
    @Nullable
    public activeKid?: ConfigKeyState["activeKid"];

    @Column({ type: "simple-json", nullable: true })
    @Description("The current or last key rotation.")
    @Nullable
    public rotation?: ConfigKeyState["rotation"];

    @Column({ type: "simple-json", nullable: true })
    @Description("The envelopes per key id at the end of the last full re-encryption pass.")
    @Nullable
    public kidUsage?: ConfigKeyState["kidUsage"];

    @Column({ nullable: true })
    @Description("When the envelopes were last counted.")
    @Nullable
    public countedAt?: Date;

    @Column({ type: "simple-json", nullable: true })
    @Description("The re-encryption of every envelope to the active key.")
    @Nullable
    public reencryption?: ConfigKeyState["reencryption"];

    @Column({ type: "simple-json", nullable: true })
    @Description("The encryption of plugin secret settings: when it first completed, and why it is still waiting.")
    @Nullable
    public pluginSecrets?: ConfigKeyState["pluginSecrets"];

    constructor(other?: Partial<ConfigKeyStateSQL>) {
        super(other);

        if (other) {
            this.activeKid = "activeKid" in other ? other.activeKid : this.activeKid;
            this.rotation = "rotation" in other ? other.rotation : this.rotation;
            this.kidUsage = "kidUsage" in other ? other.kidUsage : this.kidUsage;
            this.countedAt = "countedAt" in other ? other.countedAt : this.countedAt;
            this.reencryption = "reencryption" in other ? other.reencryption : this.reencryption;
            this.pluginSecrets = "pluginSecrets" in other ? other.pluginSecrets : this.pluginSecrets;
        }
    }
}
