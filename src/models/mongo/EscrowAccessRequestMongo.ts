///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseMongoEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { EscrowAccessRequest, EscrowAccessRequestApproval, EscrowAccessRequestStatus } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `EscrowAccessRequest` interface for storage in a MongoDB database. If SQL is
 * desired, please use `models.sql.EscrowAccessRequestSQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@Description("One request by an escrow holder to access a mailbox's escrow-wrapped master key under a Matter.")
@Index("escrow_access_request_matter", ["matterId"])
@Index("escrow_access_request_status", ["status"])
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
export class EscrowAccessRequestMongo extends BaseMongoEntity implements EscrowAccessRequest {
    @Column()
    @Description("The Matter this request is exercised against.")
    public matterId: string = "";

    @Column()
    @Description("The mailbox whose escrow-wrapped key material is being requested.")
    public mailboxUid: string = "";

    @Column()
    @Description("The holder who created this request.")
    public requestedByUserUid: string = "";

    @Column()
    @Description("Holders who have approved this request so far - the creator's own creation counts as the first.")
    public approvals: EscrowAccessRequestApproval[] = [];

    @Column()
    @Description("Snapshot of EscrowScope.requiredHolders at creation time.")
    public requiredHoldersAtCreation: number = 1;

    @Column()
    @Description("The current status of this request.")
    public status: EscrowAccessRequestStatus = "pending";

    @Column()
    @Description("Set the first time material() is successfully read.")
    @Nullable
    public fulfilledAt?: Date;

    @Column()
    @Description("The holder who denied this request, if it was denied.")
    @Nullable
    public deniedByUserUid?: string;

    @Column()
    @Description("When this request was denied, if it was.")
    @Nullable
    public deniedAt?: Date;

    constructor(other?: Partial<EscrowAccessRequestMongo>) {
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
