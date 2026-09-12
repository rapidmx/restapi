///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseMongoEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { Matter } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `Matter` interface for storage in a MongoDB database. If SQL is desired, please
 * use `models.sql.MatterSQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@Description("A named investigation or legal hold with an explicit custodian list and date range, exercised against one EscrowScope.")
@Protect(
    {
        uid: "Matter",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class MatterMongo extends BaseMongoEntity implements Matter {
    @Column()
    @Description("Admin-facing display name for this matter.")
    public name: string = "";

    @Column()
    @Description("Optional free-text description of this matter's purpose.")
    @Nullable
    public description?: string;

    @Column()
    @Description("The one EscrowScope whose holders may open an EscrowAccessRequest against this matter.")
    public escrowScopeId: string = "";

    @Column()
    @Description("Mailboxes in scope for this matter.")
    public custodianMailboxUids: string[] = [];

    @Column()
    @Description("Start of the date range this matter's access is scoped to.")
    public dateRangeStart: Date = new Date();

    @Column()
    @Description("End of the date range this matter's access is scoped to.")
    public dateRangeEnd: Date = new Date();

    @Column()
    @Description("Once set, this matter is permanently closed.")
    @Nullable
    public closedAt?: Date;

    constructor(other?: Partial<MatterMongo>) {
        super(other);

        if (other) {
            this.name = other.name !== undefined ? other.name : this.name;
            this.description = "description" in other ? other.description : this.description;
            this.escrowScopeId = other.escrowScopeId !== undefined ? other.escrowScopeId : this.escrowScopeId;
            this.custodianMailboxUids =
                other.custodianMailboxUids !== undefined ? other.custodianMailboxUids : this.custodianMailboxUids;
            this.dateRangeStart = other.dateRangeStart !== undefined ? other.dateRangeStart : this.dateRangeStart;
            this.dateRangeEnd = other.dateRangeEnd !== undefined ? other.dateRangeEnd : this.dateRangeEnd;
            this.closedAt = "closedAt" in other ? other.closedAt : this.closedAt;
        }
    }
}
