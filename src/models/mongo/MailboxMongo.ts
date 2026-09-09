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

    @Column()
    @Description("`true` if this mailbox's out-of-office auto-reply (MS-ASSettings `Oof`) is currently enabled.")
    public oofEnabled: boolean = false;

    @Column()
    @Description("The out-of-office auto-reply message body.")
    // `ObjectUtils.validate()` treats an empty string the same as null/undefined for any non-`@Nullable`
    // field ("Property oofMessage cannot be null.") - this field's natural default (no OOF message configured
    // yet) is legitimately "", so it must be `@Nullable` even though the type itself is always a `string`.
    @Nullable
    public oofMessage: string = "";

    @Column()
    @Description("When set together with `oofEndTime`, the auto-reply is only active within this window.")
    @Nullable
    public oofStartTime?: Date;

    @Column()
    @Nullable
    public oofEndTime?: Date;

    @Column()
    @Description(
        "`true` if this mailbox represents a bookable resource (Exchange's \"room\"/\"equipment\" mailbox " +
            "concept) rather than a person - see `resourceType`/the auto-accept fields below.",
    )
    @Nullable
    public isResource?: boolean = undefined;

    @Column()
    @Description("Whether this resource is a `room` or `equipment` - only meaningful when `isResource` is `true`.")
    @Nullable
    public resourceType?: "room" | "equipment" = undefined;

    @Column()
    @Description("Informational only (e.g. for a future room-picker UI) - not used by any accept/decline logic.")
    @Nullable
    public resourceCapacity?: number = undefined;

    @Column()
    @Description(
        "Mirrors Exchange's `Set-CalendarProcessing -AutomateProcessing AutoAccept` - has no effect unless " +
            "`isResource` is also `true`.",
    )
    @Nullable
    public autoAcceptBookings?: boolean = undefined;

    @Column()
    @Description("Mirrors `-AllowConflicts $true` - when set, every booking request is auto-accepted regardless of existing bookings.")
    @Nullable
    public allowConflicts?: boolean = undefined;

    @Column()
    @Description("Mirrors `-BookingWindowInDays` - a request starting further out than this many days is auto-declined.")
    @Nullable
    public bookingWindowDays?: number = undefined;

    @Column()
    @Description("Mirrors `-MaximumDurationInMinutes` - a request longer than this is auto-declined.")
    @Nullable
    public maxDurationMinutes?: number = undefined;

    @Column()
    @Description("Whether send() attaches a receipt request to every outgoing message to an internal recipient by default.")
    public alwaysRequestReceiptInternal: boolean = true;

    @Column()
    @Description("Same as alwaysRequestReceiptInternal, for an external recipient.")
    public alwaysRequestReceiptExternal: boolean = false;

    @Column()
    @Description("Whether this mailbox auto-sends a receipt back to an internal requester versus holding it for approval.")
    public autoSendReceiptsInternal: boolean = true;

    @Column()
    @Description("Same as autoSendReceiptsInternal, for an external requester.")
    public autoSendReceiptsExternal: boolean = false;

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
            this.oofEnabled = other.oofEnabled !== undefined ? other.oofEnabled : this.oofEnabled;
            this.oofMessage = other.oofMessage !== undefined ? other.oofMessage : this.oofMessage;
            this.oofStartTime = "oofStartTime" in other ? other.oofStartTime : this.oofStartTime;
            this.oofEndTime = "oofEndTime" in other ? other.oofEndTime : this.oofEndTime;
            this.isResource = "isResource" in other ? other.isResource : this.isResource;
            this.resourceType = "resourceType" in other ? other.resourceType : this.resourceType;
            this.resourceCapacity = "resourceCapacity" in other ? other.resourceCapacity : this.resourceCapacity;
            this.autoAcceptBookings = "autoAcceptBookings" in other ? other.autoAcceptBookings : this.autoAcceptBookings;
            this.allowConflicts = "allowConflicts" in other ? other.allowConflicts : this.allowConflicts;
            this.bookingWindowDays = "bookingWindowDays" in other ? other.bookingWindowDays : this.bookingWindowDays;
            this.maxDurationMinutes = "maxDurationMinutes" in other ? other.maxDurationMinutes : this.maxDurationMinutes;
            this.alwaysRequestReceiptInternal =
                other.alwaysRequestReceiptInternal !== undefined
                    ? other.alwaysRequestReceiptInternal
                    : this.alwaysRequestReceiptInternal;
            this.alwaysRequestReceiptExternal =
                other.alwaysRequestReceiptExternal !== undefined
                    ? other.alwaysRequestReceiptExternal
                    : this.alwaysRequestReceiptExternal;
            this.autoSendReceiptsInternal =
                other.autoSendReceiptsInternal !== undefined ? other.autoSendReceiptsInternal : this.autoSendReceiptsInternal;
            this.autoSendReceiptsExternal =
                other.autoSendReceiptsExternal !== undefined ? other.autoSendReceiptsExternal : this.autoSendReceiptsExternal;
        }
    }
}
