///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { EscrowAccessRequest, EscrowAccessRequestApproval, EscrowAccessRequestStatus } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `EscrowAccessRequest` interface for storage in a SQL database. If MongoDB is
 * desired, please use `models.mongo.EscrowAccessRequestMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description("One request by an escrow holder to access a mailbox's escrow-wrapped master key under a Matter.")
@Index("escrow_access_request_matter", ["matterId"])
@Protect(
    {
        uid: "EscrowAccessRequest",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class EscrowAccessRequestSQL extends BaseEntity implements EscrowAccessRequest {
    @Column()
    @Description("The Matter this request is exercised against.")
    public matterId: string = "";

    @Column()
    @Description("The mailbox whose escrow-wrapped key material is being requested.")
    public mailboxUid: string = "";

    @Column()
    @Description("The holder who created this request.")
    public requestedByUserUid: string = "";

    @Column({ type: "simple-json" })
    @Description("Holders who have approved this request so far - the creator's own creation counts as the first.")
    public approvals: EscrowAccessRequestApproval[] = [];

    @Column()
    @Description("Snapshot of EscrowScope.requiredHolders at creation time.")
    public requiredHoldersAtCreation: number = 1;

    // `type: "varchar"` is required on every string-literal-union column - see the identical note on
    // `DomainSQL.dmarcPolicy`.
    @Column({ type: "varchar" })
    @Description("The current status of this request.")
    public status: EscrowAccessRequestStatus = "pending";

    @Column({ nullable: true })
    @Description("Set the first time material() is successfully read.")
    @Nullable
    public fulfilledAt?: Date;

    @Column({ nullable: true })
    @Description("The holder who denied this request, if it was denied.")
    @Nullable
    public deniedByUserUid?: string;

    @Column({ nullable: true })
    @Description("When this request was denied, if it was.")
    @Nullable
    public deniedAt?: Date;

    constructor(other?: Partial<EscrowAccessRequestSQL>) {
        super(other);

        if (other) {
            this.matterId = other.matterId !== undefined ? other.matterId : this.matterId;
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.requestedByUserUid = other.requestedByUserUid !== undefined ? other.requestedByUserUid : this.requestedByUserUid;
            this.approvals = other.approvals !== undefined ? other.approvals : this.approvals;
            this.requiredHoldersAtCreation =
                other.requiredHoldersAtCreation !== undefined ? other.requiredHoldersAtCreation : this.requiredHoldersAtCreation;
            this.status = other.status !== undefined ? other.status : this.status;
            this.fulfilledAt = "fulfilledAt" in other ? other.fulfilledAt : this.fulfilledAt;
            this.deniedByUserUid = "deniedByUserUid" in other ? other.deniedByUserUid : this.deniedByUserUid;
            this.deniedAt = "deniedAt" in other ? other.deniedAt : this.deniedAt;
        }
    }
}
