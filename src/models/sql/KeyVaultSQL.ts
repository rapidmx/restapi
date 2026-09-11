///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { KeyVault, MasterKeyWrap, WrappedPrivateKey } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `KeyVault` interface for storage in a SQL database. If MongoDB is desired, please use
 * `models.mongo.KeyVaultMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description(
    "Holds a mailbox's private key material, wrapped under its own master key - returned only from the " +
        "authenticated GET /mailbox/:id/keyvault.",
)
@Index("keyvault_mailbox", ["mailboxUid"], { unique: true })
@Protect(
    {
        uid: "KeyVault",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class KeyVaultSQL extends BaseEntity implements KeyVault {
    @Column()
    @Description("The unique identifier of the `Mailbox` this key vault belongs to.")
    public mailboxUid: string = "";

    @Column({ type: "simple-json" })
    @Description("This mailbox's private keys, each encrypted under its master key.")
    public wrappedKeys: WrappedPrivateKey[] = [];

    @Column({ type: "simple-json" })
    @Description("Wrapped copies of this mailbox's master key, one per unlock method.")
    public masterKeyWraps: MasterKeyWrap[] = [];

    constructor(other?: Partial<KeyVaultSQL>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.wrappedKeys = other.wrappedKeys !== undefined ? other.wrappedKeys : this.wrappedKeys;
            this.masterKeyWraps = other.masterKeyWraps !== undefined ? other.masterKeyWraps : this.masterKeyWraps;
        }
    }
}
