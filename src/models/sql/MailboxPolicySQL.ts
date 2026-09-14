///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { MailboxPolicy } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `MailboxPolicy` interface for storage in a SQL database.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description("This deployment's default mailbox settings.")
@Protect(
    {
        uid: "MailboxPolicy",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class MailboxPolicySQL extends BaseEntity implements MailboxPolicy {
    // `type: "double precision"` for both quotas, for the same reason as `ContactSQL.keysFirstSeen`: an untyped `number`
    // column is a 32-bit integer on Postgres/MySQL (max ~2.1 GB), below the 5 GB default quota.
    @Column({ type: "double precision", nullable: true })
    @Description("The quota a newly created mailbox starts with, in bytes.")
    @Nullable
    public defaultQuotaBytes?: number;

    @Column({ nullable: true })
    @Description("Whether a signed-in user may create their own mailbox on first sign-in.")
    @Nullable
    public autoProvisionEnabled?: boolean;

    @Column({ type: "double precision", nullable: true })
    @Description("The quota of a mailbox a user creates for themselves, in bytes.")
    @Nullable
    public autoProvisionQuotaBytes?: number;

    constructor(other?: Partial<MailboxPolicySQL>) {
        super(other);

        if (other) {
            this.defaultQuotaBytes = "defaultQuotaBytes" in other ? other.defaultQuotaBytes : this.defaultQuotaBytes;
            this.autoProvisionEnabled = "autoProvisionEnabled" in other ? other.autoProvisionEnabled : this.autoProvisionEnabled;
            this.autoProvisionQuotaBytes = "autoProvisionQuotaBytes" in other ? other.autoProvisionQuotaBytes : this.autoProvisionQuotaBytes;
        }
    }
}
