///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { FocusedInboxOverride, MessageClassification } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `FocusedInboxOverride` interface for storage in a SQL database. If MongoDB is
 * desired, please use `models.mongo.FocusedInboxOverrideMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description(
    "A user's explicit 'always put mail from this sender in Focused/Other' instruction, overriding whatever " +
        "the Focused Inbox heuristics would otherwise decide for that sender.",
)
@Index("focusedinboxoverride_mailbox", ["mailboxUid", "senderAddress"])
@Protect(
    {
        uid: "FocusedInboxOverride",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class FocusedInboxOverrideSQL extends BaseEntity implements FocusedInboxOverride {
    @Column()
    @Description("The unique identifier of the `Mailbox` this override belongs to.")
    public mailboxUid: string = "";

    @Column()
    @Description("The sender address this override matches, normalized to lowercase.")
    public senderAddress: string = "";

    // `type: "varchar"` is required on every enum-typed column - see `MessageSQL.importance`'s own comment
    // for the `emitDecoratorMetadata`/TypeORM reason.
    @Column({ type: "varchar" })
    @Description("Where mail from senderAddress should always go.")
    public classifyAs: MessageClassification = MessageClassification.FOCUSED;

    constructor(other?: Partial<FocusedInboxOverrideSQL>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.senderAddress = other.senderAddress !== undefined ? other.senderAddress : this.senderAddress;
            this.classifyAs = other.classifyAs !== undefined ? other.classifyAs : this.classifyAs;
        }
    }
}
