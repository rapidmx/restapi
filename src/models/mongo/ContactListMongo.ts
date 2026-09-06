///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    ACLAction,
    BaseMongoEntity,
    DocDecorators,
    ModelDecorators,
    PersistenceDecorators,
} from "@rapidrest/service-core";
import { ContactList } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `ContactList` interface for storage in a MongoDB database. If SQL is desired, please use
 * `models.sql.ContactListSQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@Description("Defines a named grouping (address book / distribution list) of `Contact` records within a `Mailbox`.")
@Index("contactlist_mailbox", ["mailboxUid"])
@Protect(
    {
        uid: "ContactList",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class ContactListMongo extends BaseMongoEntity implements ContactList {
    @Column()
    @Description("The unique identifier of the `Mailbox` this contact list belongs to.")
    public mailboxUid: string = "";

    @Column()
    @Description("The display name of the contact list.")
    public name: string = "";

    constructor(other?: Partial<ContactListMongo>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.name = other.name !== undefined ? other.name : this.name;
        }
    }
}
