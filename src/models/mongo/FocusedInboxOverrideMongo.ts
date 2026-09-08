///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { BaseMongoEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { FocusedInboxOverride, MessageClassification } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `FocusedInboxOverride` interface for storage in a MongoDB database. If SQL is
 * desired, please use `models.sql.FocusedInboxOverrideSQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
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
export class FocusedInboxOverrideMongo extends BaseMongoEntity implements FocusedInboxOverride {
    @Column()
    @Description("The unique identifier of the `Mailbox` this override belongs to.")
    public mailboxUid: string = "";

    @Column()
    @Description("The sender address this override matches, normalized to lowercase.")
    public senderAddress: string = "";

    @Column()
    @Description("Where mail from senderAddress should always go.")
    public classifyAs: MessageClassification = MessageClassification.FOCUSED;

    constructor(other?: Partial<FocusedInboxOverrideMongo>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.senderAddress = other.senderAddress !== undefined ? other.senderAddress : this.senderAddress;
            this.classifyAs = other.classifyAs !== undefined ? other.classifyAs : this.classifyAs;
        }
    }
}
