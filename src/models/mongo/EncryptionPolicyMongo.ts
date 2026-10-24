///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseMongoEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { EncryptionPolicy, PolicyState } from "../types.js";
const { Nullable } = ObjectDecorators;
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
export class EncryptionPolicyMongo extends BaseMongoEntity implements EncryptionPolicy {
    @Column()
    @Description("Encryption policy for same-organisation recipients.")
    public encryptSameOrg: PolicyState = "optional";

    @Column()
    @Description("Encryption policy for federated-peer recipients.")
    public encryptFederated: PolicyState = "optional";

    @Column()
    @Description("Encryption policy for external recipients.")
    public encryptExternal: PolicyState = "optional";

    // `nullable: true` so `synchronize` can add the column to an existing row; unset falls back to `mail:zero_access:allowed`.
    @Column()
    @Description("Whether mailboxes on this server may store mail encrypted at rest (zero-access). Unset uses the server default.")
    @Nullable
    public allowZeroAccess?: boolean = undefined;

    // Unset falls back to `mail:encryption:openpgp_allowed`.
    @Column()
    @Description("Whether mailboxes on this server may enroll and publish OpenPGP keys. Unset uses the server default.")
    @Nullable
    public allowOpenPgp?: boolean = undefined;

    constructor(other?: Partial<EncryptionPolicyMongo>) {
        super(other);

        if (other) {
            this.encryptSameOrg = other.encryptSameOrg !== undefined ? other.encryptSameOrg : this.encryptSameOrg;
            this.encryptFederated = other.encryptFederated !== undefined ? other.encryptFederated : this.encryptFederated;
            this.encryptExternal = other.encryptExternal !== undefined ? other.encryptExternal : this.encryptExternal;
            this.allowZeroAccess = "allowZeroAccess" in other ? other.allowZeroAccess : this.allowZeroAccess;
            this.allowOpenPgp = "allowOpenPgp" in other ? other.allowOpenPgp : this.allowOpenPgp;
        }
    }
}
