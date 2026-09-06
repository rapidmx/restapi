///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ACLAction, BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { ContactList } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `ContactList` interface for storage in a SQL database. If MongoDB is desired, please use
 * `models.mongo.ContactListMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
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
export class ContactListSQL extends BaseEntity implements ContactList {
    @Column()
    @Description("The unique identifier of the `Mailbox` this contact list belongs to.")
    public mailboxUid: string = "";

    @Column()
    @Description("The display name of the contact list.")
    public name: string = "";

    constructor(other?: Partial<ContactListSQL>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.name = other.name !== undefined ? other.name : this.name;
        }
    }
}
