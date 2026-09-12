///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseMongoEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { EscrowAuditAction, EscrowAuditLogEntry } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `EscrowAuditLogEntry` interface for storage in a MongoDB database. If SQL is
 * desired, please use `models.sql.EscrowAuditLogEntrySQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@Description("One hash-chained, tamper-evident record of an escrow access lifecycle event.")
@Index("escrow_audit_sequence", ["sequence"], { unique: true })
@Index("escrow_audit_matter", ["matterId"])
@Protect(
    {
        uid: "EscrowAuditLogEntry",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class EscrowAuditLogEntryMongo extends BaseMongoEntity implements EscrowAuditLogEntry {
    @Column()
    @Description("Monotonic, global sequence number.")
    public sequence: number = 0;

    @Column()
    @Description("The immediately-preceding entry's hash.")
    @Nullable
    public previousHash?: string;

    @Column()
    @Description("SHA-256 hex digest over this entry's own content plus previousHash.")
    public hash: string = "";

    @Column()
    @Description("The escrow access lifecycle event this entry records.")
    public action: EscrowAuditAction = EscrowAuditAction.REQUEST_CREATED;

    @Column()
    @Description("The holder who performed the action.")
    public holderUserUid: string = "";

    @Column()
    @Description("The Matter this event pertains to.")
    public matterId: string = "";

    @Column()
    @Description("The mailbox this event pertains to.")
    public mailboxUid: string = "";

    @Column()
    @Description("The EscrowAccessRequest this event pertains to.")
    public requestId: string = "";

    @Column()
    @Description("When this event occurred - captured explicitly and included in the hash.")
    public occurredAt: Date = new Date();

    @Column()
    @Description("A small, action-specific identifying snapshot - not a full field-level diff.")
    @Nullable
    public details?: Record<string, any>;

    constructor(other?: Partial<EscrowAuditLogEntryMongo>) {
        super(other);

        if (other) {
            this.sequence = other.sequence !== undefined ? other.sequence : this.sequence;
            this.previousHash = "previousHash" in other ? other.previousHash : this.previousHash;
            this.hash = other.hash !== undefined ? other.hash : this.hash;
            this.action = other.action !== undefined ? other.action : this.action;
            this.holderUserUid = other.holderUserUid !== undefined ? other.holderUserUid : this.holderUserUid;
            this.matterId = other.matterId !== undefined ? other.matterId : this.matterId;
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.requestId = other.requestId !== undefined ? other.requestId : this.requestId;
            this.occurredAt = other.occurredAt !== undefined ? other.occurredAt : this.occurredAt;
            this.details = "details" in other ? other.details : this.details;
        }
    }
}
