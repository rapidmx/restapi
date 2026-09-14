///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { BaseMongoEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { OofReplySuppression } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `OofReplySuppression` interface for storage in a MongoDB database. If SQL is desired,
 * please use `models.sql.OofReplySuppressionSQL` instead.
 *
 * Internal bookkeeping only - no CRUD route exists for this entity (see the interface's own doc comment).
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@Description(
    "Throttles automatic (out-of-office) replies to at most one per sender per mailbox within a rolling window.",
)
@Index("oofreplysuppression_mailbox_sender", ["mailboxUid", "senderAddress"])
@Index("oofreplysuppression_last_replied_at", ["lastRepliedAt"])
@Protect(
    {
        uid: "OofReplySuppression",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class OofReplySuppressionMongo extends BaseMongoEntity implements OofReplySuppression {
    @Column()
    @Description("The unique identifier of the `Mailbox` this suppression entry belongs to.")
    public mailboxUid: string = "";

    @Column()
    @Description("The sender address a reply was most recently sent to.")
    public senderAddress: string = "";

    @Column()
    @Description("When the most recent automatic reply to this sender was sent.")
    public lastRepliedAt: Date = new Date();

    constructor(other?: Partial<OofReplySuppressionMongo>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.senderAddress = other.senderAddress !== undefined ? other.senderAddress : this.senderAddress;
            this.lastRepliedAt = other.lastRepliedAt !== undefined ? other.lastRepliedAt : this.lastRepliedAt;
        }
    }
}
