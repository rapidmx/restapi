///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseMongoEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { Mailbox } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `Mailbox` interface for storage in a MongoDB database. If SQL is desired, please use
 * `models.sql.MailboxSQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@Description(
    "Defines a single mailbox belonging to a `User`. A mailbox is the root of a user's Folder hierarchy and " +
        "the unit that MAPI/EAS clients log on to.",
)
@Index("mailbox_owner", ["ownerUserUid"])
@Index("mailbox_primary_smtp", ["primarySmtpAddress"], { unique: true })
@Protect(
    {
        uid: "Mailbox",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            // Deny-all, including CREATE: mailbox creation is handled entirely by `BaseMailboxRoute.create()`,
            // which bypasses this class-level ACL (see its doc comment for why a `.*` CREATE grant here would
            // leak into permission checks against *specific* mailboxes' ACLs, since they parent to this one).
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    true,
)
export class MailboxMongo extends BaseMongoEntity implements Mailbox {
    @Column()
    @Description(
        "The unique identifier of the `User` (from `@rapidrest/auth`) that owns this mailbox, if any. Absent " +
            "for a true shared mailbox with no single owner — see the `Mailbox` interface doc comment.",
    )
    @Nullable
    public ownerUserUid?: string = undefined;

    @Column()
    @Description("The primary SMTP address that mail addressed to this mailbox is delivered under.")
    public primarySmtpAddress: string = "";

    @Column()
    @Description("Additional SMTP addresses that also deliver to this mailbox.")
    public aliasAddresses: string[] = [];

    @Column()
    @Description("The display name shown to recipients (e.g. in the `From` header) for mail sent from this mailbox.")
    public displayName: string = "";

    @Column()
    @Description("The IANA timezone identifier (e.g. `America/Los_Angeles`) used to render dates/times for this mailbox.")
    public timezone: string = "";

    @Column()
    @Description("The maximum total size, in bytes, of all messages/attachments this mailbox may store.")
    public quotaBytes: number = 0;

    @Column()
    @Description("The current total size, in bytes, of all messages/attachments stored in this mailbox.")
    public usedBytes: number = 0;

    constructor(other?: Partial<MailboxMongo>) {
        super(other);

        if (other) {
            this.ownerUserUid = other.ownerUserUid !== undefined ? other.ownerUserUid : this.ownerUserUid;
            this.primarySmtpAddress =
                other.primarySmtpAddress !== undefined ? other.primarySmtpAddress : this.primarySmtpAddress;
            this.aliasAddresses = other.aliasAddresses !== undefined ? other.aliasAddresses : this.aliasAddresses;
            this.displayName = other.displayName !== undefined ? other.displayName : this.displayName;
            this.timezone = other.timezone !== undefined ? other.timezone : this.timezone;
            this.quotaBytes = other.quotaBytes !== undefined ? other.quotaBytes : this.quotaBytes;
            this.usedBytes = other.usedBytes !== undefined ? other.usedBytes : this.usedBytes;
        }
    }
}
