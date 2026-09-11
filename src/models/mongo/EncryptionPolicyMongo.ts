///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { EncryptionPolicy, PolicyState } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity } = PersistenceDecorators;

/**
 * Implementation of the `EncryptionPolicy` interface for storage in MongoDB. If a SQL database is desired,
 * please use `models.sql.EncryptionPolicySQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@Description("This deployment's system-wide encryption policy, per recipient tier.")
@Protect(
    {
        uid: "EncryptionPolicy",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class EncryptionPolicyMongo extends BaseEntity implements EncryptionPolicy {
    @Column()
    @Description("Encryption policy for same-organisation recipients.")
    public encryptSameOrg: PolicyState = "optional";

    @Column()
    @Description("Encryption policy for federated-peer recipients.")
    public encryptFederated: PolicyState = "optional";

    @Column()
    @Description("Encryption policy for external recipients.")
    public encryptExternal: PolicyState = "optional";

    constructor(other?: Partial<EncryptionPolicyMongo>) {
        super(other);

        if (other) {
            this.encryptSameOrg = other.encryptSameOrg !== undefined ? other.encryptSameOrg : this.encryptSameOrg;
            this.encryptFederated = other.encryptFederated !== undefined ? other.encryptFederated : this.encryptFederated;
            this.encryptExternal = other.encryptExternal !== undefined ? other.encryptExternal : this.encryptExternal;
        }
    }
}
