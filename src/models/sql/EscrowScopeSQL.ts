///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { EscrowScope, EscrowScopePublicKey } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `EscrowScope` interface for storage in a SQL database. If MongoDB is desired,
 * please use `models.mongo.EscrowScopeMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description("An eDiscovery/compliance escrow scope - a named key, its own role holders, and an optional M-of-N dual-control threshold.")
@Protect(
    {
        uid: "EscrowScope",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class EscrowScopeSQL extends BaseEntity implements EscrowScope {
    @Column()
    @Description("Admin-facing display name, e.g. 'legal', 'executive'.")
    public name: string = "";

    @Column({ type: "text", nullable: true })
    @Description("Optional free-text description of this scope's purpose.")
    @Nullable
    public description?: string;

    @Column({ type: "simple-json" })
    @Description("This scope's own public key - a mailbox assigned to this scope wraps its master key against this.")
    public publicKey: EscrowScopePublicKey = { publicKey: "", type: "", fingerprint: "", notBefore: 0, notAfter: 0 };

    @Column({ type: "simple-json" })
    @Description("Uids of every user in the eDiscovery/compliance role for this scope.")
    public holderUserUids: string[] = [];

    @Column()
    @Description("M in 'M-of-N dual control' - between 1 and holderUserUids.length inclusive.")
    public requiredHolders: number = 1;

    @Column()
    @Description("Whether the mailbox owner should be notified when this scope's escrow is used - stored/exposed only.")
    public notifySubjectOnAccess: boolean = false;

    constructor(other?: Partial<EscrowScopeSQL>) {
        super(other);

        if (other) {
            this.name = other.name !== undefined ? other.name : this.name;
            this.description = "description" in other ? other.description : this.description;
            this.publicKey = other.publicKey !== undefined ? other.publicKey : this.publicKey;
            this.holderUserUids = other.holderUserUids !== undefined ? other.holderUserUids : this.holderUserUids;
            this.requiredHolders = other.requiredHolders !== undefined ? other.requiredHolders : this.requiredHolders;
            this.notifySubjectOnAccess =
                other.notifySubjectOnAccess !== undefined ? other.notifySubjectOnAccess : this.notifySubjectOnAccess;
        }
    }
}
