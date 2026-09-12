///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseMongoEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { RetentionPolicy } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `RetentionPolicy` interface for storage in MongoDB. If a SQL database is
 * desired, please use `models.sql.RetentionPolicySQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@Description("This deployment's data-retention policy.")
@Protect(
    {
        uid: "RetentionPolicy",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class RetentionPolicyMongo extends BaseMongoEntity implements RetentionPolicy {
    @Column()
    @Description("Org-wide max age, in days, for any Message. Unset means no automatic purge.")
    @Nullable
    public messageRetentionDays?: number;

    @Column()
    @Description("Max age, in days, for AuditLogEntry rows. Unset means keep forever.")
    @Nullable
    public auditLogRetentionDays?: number;

    constructor(other?: Partial<RetentionPolicyMongo>) {
        super(other);

        if (other) {
            this.messageRetentionDays = "messageRetentionDays" in other ? other.messageRetentionDays : this.messageRetentionDays;
            this.auditLogRetentionDays = "auditLogRetentionDays" in other ? other.auditLogRetentionDays : this.auditLogRetentionDays;
        }
    }
}
