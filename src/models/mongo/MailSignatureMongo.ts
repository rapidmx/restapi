///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseMongoEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { MailSignature } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Nullable } = ObjectDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `MailSignature` interface for storage in a MongoDB database. If SQL is desired, please
 * use `models.sql.MailSignatureSQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@Description("Defines a single named, roaming email signature (OWA/New Outlook-style) belonging to a `Mailbox`.")
@Index("mailsignature_mailbox", ["mailboxUid"])
@Protect(
    {
        uid: "MailSignature",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class MailSignatureMongo extends BaseMongoEntity implements MailSignature {
    @Column()
    @Description("The unique identifier of the `Mailbox` this signature belongs to.")
    public mailboxUid: string = "";

    @Column()
    @Description("The display name of the signature.")
    public name: string = "";

    @Column()
    @Description("The signature's HTML body.")
    // `ObjectUtils.validate()` treats an empty string the same as null/undefined for any non-`@Nullable` field -
    // this field's natural default (no signature written yet) is legitimately "", same reasoning as
    // `Mailbox.oofMessage`.
    @Nullable
    public contentHtml: string = "";

    @Column()
    @Description("Applied to new (non-reply/forward) compositions when `true`.")
    public isDefaultForNewMessages: boolean = false;

    @Column()
    @Description("Applied to replies/forwards when `true`.")
    public isDefaultForReplyForward: boolean = false;

    constructor(other?: Partial<MailSignatureMongo>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.name = other.name !== undefined ? other.name : this.name;
            this.contentHtml = other.contentHtml !== undefined ? other.contentHtml : this.contentHtml;
            this.isDefaultForNewMessages =
                other.isDefaultForNewMessages !== undefined ? other.isDefaultForNewMessages : this.isDefaultForNewMessages;
            this.isDefaultForReplyForward =
                other.isDefaultForReplyForward !== undefined ? other.isDefaultForReplyForward : this.isDefaultForReplyForward;
        }
    }
}
