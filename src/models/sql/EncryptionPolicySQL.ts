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
 * Implementation of the `EncryptionPolicy` interface for storage in a SQL database. If MongoDB is desired,
 * please use `models.mongo.EncryptionPolicyMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
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
export class EncryptionPolicySQL extends BaseEntity implements EncryptionPolicy {
    // `type: "varchar"` is required on every enum/string-literal-union-typed column - TypeScript's
    // `emitDecoratorMetadata` can't reflect a union type into a primitive constructor TypeORM/better-sqlite3
    // can resolve into a column type on its own (fails at `DataSource.initialize()` with "Data type 'Object'/
    // 'undefined' ... is not supported" otherwise) - see the identical note on `CalendarEventSQL.status`.
    @Column({ type: "varchar" })
    @Description("Encryption policy for same-organisation recipients.")
    public encryptSameOrg: PolicyState = "optional";

    @Column({ type: "varchar" })
    @Description("Encryption policy for federated-peer recipients.")
    public encryptFederated: PolicyState = "optional";

    @Column({ type: "varchar" })
    @Description("Encryption policy for external recipients.")
    public encryptExternal: PolicyState = "optional";

    constructor(other?: Partial<EncryptionPolicySQL>) {
        super(other);

        if (other) {
            this.encryptSameOrg = other.encryptSameOrg !== undefined ? other.encryptSameOrg : this.encryptSameOrg;
            this.encryptFederated = other.encryptFederated !== undefined ? other.encryptFederated : this.encryptFederated;
            this.encryptExternal = other.encryptExternal !== undefined ? other.encryptExternal : this.encryptExternal;
        }
    }
}
