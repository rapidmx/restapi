///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseMongoEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { EscrowAuditHashAlgorithm, EscrowAuditHead } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `EscrowAuditHead` interface for storage in a MongoDB database. If SQL is desired,
 * please use `models.sql.EscrowAuditHeadSQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@Description("The escrow audit chain's latest sequence/hash, stored separately so tail truncation is detectable.")
@Index("escrow_audit_head_chain", ["chainId"], { unique: true })
@Protect(
    {
        uid: "EscrowAuditHead",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class EscrowAuditHeadMongo extends BaseMongoEntity implements EscrowAuditHead {
    @Column()
    @Description("Identifies which chain this head belongs to.")
    public chainId: string = "";

    @Column()
    @Description("The sequence of the latest entry appended to the chain.")
    public sequence: number = 0;

    @Column()
    @Description("The hash of the latest entry appended to the chain.")
    public hash: string = "";

    @Column()
    @Description("The scheme mac was computed with - absent when written without an HMAC key.")
    @Nullable
    public hashAlgorithm?: EscrowAuditHashAlgorithm;

    @Column()
    @Description("HMAC-SHA256 over chainId/sequence/hash - absent when written without an HMAC key.")
    @Nullable
    public mac?: string;

    constructor(other?: Partial<EscrowAuditHeadMongo>) {
        super(other);

        if (other) {
            this.chainId = other.chainId !== undefined ? other.chainId : this.chainId;
            this.sequence = other.sequence !== undefined ? other.sequence : this.sequence;
            this.hash = other.hash !== undefined ? other.hash : this.hash;
            this.hashAlgorithm = "hashAlgorithm" in other ? other.hashAlgorithm : this.hashAlgorithm;
            this.mac = "mac" in other ? other.mac : this.mac;
        }
    }
}
