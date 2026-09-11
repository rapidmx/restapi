///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { BaseMongoEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { ObjectDecorators } from "@rapidrest/core";
import { Label } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `Label` interface for storage in a MongoDB database. If SQL is desired, please use
 * `models.sql.LabelSQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@Description("A Gmail-style label a mailbox owner can apply to any number of messages, independent of folder placement.")
@Index("label_mailbox", ["mailboxUid"])
@Protect(
    {
        uid: "Label",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class LabelMongo extends BaseMongoEntity implements Label {
    @Column()
    @Description("The unique identifier of the `Mailbox` this label belongs to.")
    public mailboxUid: string = "";

    @Column()
    @Description("The display name of the label.")
    public name: string = "";

    @Column()
    @Description("An optional display color hint (e.g. a hex code) for the label.")
    @Nullable
    public color?: string;

    constructor(other?: Partial<LabelMongo>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.name = other.name !== undefined ? other.name : this.name;
            this.color = "color" in other ? other.color : this.color;
        }
    }
}
