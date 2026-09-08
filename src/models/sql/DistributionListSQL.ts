///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { DocDecorators, ModelDecorators, PersistenceDecorators, RecoverableBaseEntity } from "@rapidrest/service-core";
import { DistributionList } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `DistributionList` interface for storage in a SQL database. If MongoDB is desired,
 * please use `models.mongo.DistributionListMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description(
    "A mail-enabled group: mail sent to `primarySmtpAddress`/`aliasAddresses` fans out to every address in " +
        "`memberAddresses`.",
)
@Index("distributionlist_primary_smtp", ["primarySmtpAddress"])
@Protect(
    {
        uid: "DistributionList",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            // Deny-all: list management is handled entirely by `BaseDistributionListRoute`, which bypasses this
            // class-level ACL for a trusted caller (see its doc comment) - there is no per-list delegated
            // ownership in v1.
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class DistributionListSQL extends RecoverableBaseEntity implements DistributionList {
    @Column()
    @Description("The primary SMTP address that mail addressed to this list is delivered/fanned-out under.")
    public primarySmtpAddress: string = "";

    @Column({ type: "simple-json", nullable: true })
    @Description("Additional SMTP addresses that also resolve to this list.")
    @Nullable
    public aliasAddresses?: string[] = [];

    @Column()
    @Description("The display name of the list.")
    public name: string = "";

    @Column({ type: "text", nullable: true })
    @Description("A free-form description of the list.")
    @Nullable
    public description?: string = undefined;

    @Column({ type: String, nullable: true })
    @Description(
        "Set only when a non-trusted caller could ever create one - kept for parity with `Mailbox.ownerUserUid`.",
    )
    @Nullable
    public ownerUserUid?: string = undefined;

    @Column({ type: "simple-json" })
    @Description("The email addresses of every member of this list.")
    public memberAddresses: string[] = [];

    @Column({ nullable: true })
    @Description(
        "When true, inbound mail whose envelope sender isn't one of `memberAddresses` is dropped rather than " +
            "fanned out.",
    )
    @Nullable
    public restrictSenders?: boolean = false;

    constructor(other?: Partial<DistributionListSQL>) {
        super(other);

        if (other) {
            this.primarySmtpAddress =
                other.primarySmtpAddress !== undefined ? other.primarySmtpAddress : this.primarySmtpAddress;
            this.aliasAddresses = "aliasAddresses" in other ? other.aliasAddresses : this.aliasAddresses;
            this.name = other.name !== undefined ? other.name : this.name;
            this.description = "description" in other ? other.description : this.description;
            this.ownerUserUid = "ownerUserUid" in other ? other.ownerUserUid : this.ownerUserUid;
            this.memberAddresses = other.memberAddresses !== undefined ? other.memberAddresses : this.memberAddresses;
            this.restrictSenders = "restrictSenders" in other ? other.restrictSenders : this.restrictSenders;
        }
    }
}
