///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { BaseMongoEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { ZeroAccessIndexEntry } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `ZeroAccessIndexEntry` interface for storage in a MongoDB database. If SQL is desired, please use
 * `models.sql.ZeroAccessIndexEntrySQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@Description("A zero-access message's search index entry, encrypted to the mailbox's zero-access key.")
@Index("zero_access_index_entry_mailbox_week", ["mailboxUid", "weekId"])
@Index("zero_access_index_entry_message", ["messageUid"])
@Protect(
    {
        uid: "ZeroAccessIndexEntry",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class ZeroAccessIndexEntryMongo extends BaseMongoEntity implements ZeroAccessIndexEntry {
    @Column()
    @Description("The unique identifier of the `Mailbox` this entry belongs to.")
    public mailboxUid: string = "";

    @Column()
    @Description("The unique identifier of the `Message` this entry indexes.")
    public messageUid: string = "";

    @Column()
    @Description("ISO week (UTC) of receivedAt, e.g. 2026-W43.")
    public weekId: string = "";

    @Column()
    @Description("When the message was received, or its original date for backfilled and imported mail.")
    public receivedAt: Date = new Date();

    @Column()
    @Description("Fingerprint of the zero-access key `sealed` is encrypted to.")
    public keyFingerprint: string = "";

    @Column()
    @Description("Base64 DER CMS EnvelopedData of the gzipped JSON index document.")
    public sealed: string = "";

    constructor(other?: Partial<ZeroAccessIndexEntryMongo>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.messageUid = other.messageUid !== undefined ? other.messageUid : this.messageUid;
            this.weekId = other.weekId !== undefined ? other.weekId : this.weekId;
            this.receivedAt = other.receivedAt !== undefined ? other.receivedAt : this.receivedAt;
            this.keyFingerprint = other.keyFingerprint !== undefined ? other.keyFingerprint : this.keyFingerprint;
            this.sealed = other.sealed !== undefined ? other.sealed : this.sealed;
        }
    }
}
