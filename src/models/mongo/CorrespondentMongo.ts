///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { BaseMongoEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { Correspondent, CorrespondentSource } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `Correspondent` interface for storage in a MongoDB database. If SQL is desired,
 * please use `models.sql.CorrespondentSQL` instead.
 *
 * Internal bookkeeping only - no CRUD route exists for this entity (see the interface's own doc comment).
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@Description(
    "Someone a mailbox has encountered by e-mail or calendar, offered as a recipient suggestion in compose.",
)
@Index("correspondent_mailbox_address", ["mailboxUid", "address"], { unique: true })
@Index("correspondent_mailbox_last_seen", ["mailboxUid", "lastSeenAt"])
@Protect(
    {
        uid: "Correspondent",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class CorrespondentMongo extends BaseMongoEntity implements Correspondent {
    @Column()
    @Description("The unique identifier of the `Mailbox` that encountered this address.")
    public mailboxUid: string = "";

    @Column()
    @Description("The address, lowercased. Unique together with mailboxUid.")
    public address: string = "";

    @Column()
    @Description("The most recent non-empty display name seen with this address.")
    public displayName: string = "";

    @Column()
    @Description("When this address was last encountered.")
    public lastSeenAt: Date = new Date();

    @Column()
    @Description("How many times this address has been encountered.")
    public count: number = 0;

    // `type: "varchar"` is required on every enum-typed column - see `MessageSQL.importance`'s own comment
    // for the `emitDecoratorMetadata`/TypeORM reason.
    @Column()
    @Description("How the address was last encountered: received, sent or event.")
    public lastSource: CorrespondentSource = "received";

    constructor(other?: Partial<CorrespondentMongo>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.address = other.address !== undefined ? other.address : this.address;
            this.displayName = other.displayName !== undefined ? other.displayName : this.displayName;
            this.lastSeenAt = other.lastSeenAt !== undefined ? other.lastSeenAt : this.lastSeenAt;
            this.count = other.count !== undefined ? other.count : this.count;
            this.lastSource = other.lastSource !== undefined ? other.lastSource : this.lastSource;
        }
    }
}
