///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { EncryptionPreference, FreeBusyVisibility, Mailbox, PublicKey } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `Mailbox` interface for storage in a SQL database. If MongoDB is desired, please use
 * `models.mongo.MailboxMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description(
    "Defines a single mailbox belonging to a `User`. A mailbox is the root of a user's Folder hierarchy and " +
        "the unit that MAPI/EAS clients log on to.",
)
@Index("mailbox_owner", ["ownerUserUid"])
@Index("mailbox_primary_smtp", ["primarySmtpAddress"], { unique: true })
// Not `unique: true` - see `Mailbox.keyDiscoveryHash`'s own doc comment on why this is optional/unbackfilled
// rather than required-with-a-default (a uniqueness constraint on a shared default would collide across every
// pre-existing row the moment a second one is saved).
@Index("mailbox_key_discovery_hash", ["keyDiscoveryHash"])
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
export class MailboxSQL extends BaseEntity implements Mailbox {
    @Column({ type: String, nullable: true })
    @Description(
        "The unique identifier of the `User` (from `@rapidrest/auth`) that owns this mailbox, if any. Absent " +
            "for a true shared mailbox with no single owner — see the `Mailbox` interface doc comment.",
    )
    @Nullable
    public ownerUserUid?: string = undefined;

    @Column()
    @Description("The primary SMTP address that mail addressed to this mailbox is delivered under.")
    public primarySmtpAddress: string = "";

    @Column({ type: "simple-json" })
    @Description("Additional SMTP addresses that also deliver to this mailbox.")
    public aliasAddresses: string[] = [];

    @Column()
    @Description("The display name shown to recipients (e.g. in the `From` header) for mail sent from this mailbox.")
    public displayName: string = "";

    @Column()
    @Description("The IANA timezone identifier (e.g. `America/Los_Angeles`) used to render dates/times for this mailbox.")
    public timezone: string = "";

    // `type: "double precision"` for both byte counts, for the same reason as `ContactSQL.keysFirstSeen`: an untyped
    // `number` column is a 32-bit integer on Postgres/MySQL (max ~2.1 GB), below the 5 GB default quota. An existing
    // Postgres/MySQL column needs a manual `ALTER` before upgrading - see the README's "Upgrading" section.
    @Column({ type: "double precision" })
    @Description("The maximum total size, in bytes, of all messages/attachments this mailbox may store.")
    public quotaBytes: number = 0;

    @Column({ type: "double precision" })
    @Description("The current total size, in bytes, of all messages/attachments stored in this mailbox.")
    public usedBytes: number = 0;

    @Column()
    @Description("`true` if this mailbox's out-of-office auto-reply (MS-ASSettings `Oof`) is currently enabled.")
    public oofEnabled: boolean = false;

    @Column({ type: "text" })
    @Description("The out-of-office auto-reply message body.")
    // `ObjectUtils.validate()` treats an empty string the same as null/undefined for any non-`@Nullable`
    // field ("Property oofMessage cannot be null.") - this field's natural default (no OOF message configured
    // yet) is legitimately "", so it must be `@Nullable` even though the type itself is always a `string`.
    @Nullable
    public oofMessage: string = "";

    @Column({ nullable: true })
    @Description("When set together with `oofEndTime`, the auto-reply is only active within this window.")
    @Nullable
    public oofStartTime?: Date;

    @Column({ nullable: true })
    @Nullable
    public oofEndTime?: Date;

    @Column({ nullable: true })
    @Description(
        "`true` if this mailbox represents a bookable resource (Exchange's \"room\"/\"equipment\" mailbox " +
            "concept) rather than a person - see `resourceType`/the auto-accept fields below.",
    )
    @Nullable
    public isResource?: boolean = undefined;

    // Enum-like string-literal-union column - needs an explicit type, same as `IngestQueueEntrySQL.status`.
    @Column({ type: "varchar", nullable: true })
    @Description("Whether this resource is a `room` or `equipment` - only meaningful when `isResource` is `true`.")
    @Nullable
    public resourceType?: "room" | "equipment" = undefined;

    @Column({ nullable: true })
    @Description("Informational only (e.g. for a future room-picker UI) - not used by any accept/decline logic.")
    @Nullable
    public resourceCapacity?: number = undefined;

    @Column({ nullable: true })
    @Description(
        "Mirrors Exchange's `Set-CalendarProcessing -AutomateProcessing AutoAccept` - has no effect unless " +
            "`isResource` is also `true`.",
    )
    @Nullable
    public autoAcceptBookings?: boolean = undefined;

    @Column({ nullable: true })
    @Description("Mirrors `-AllowConflicts $true` - when set, every booking request is auto-accepted regardless of existing bookings.")
    @Nullable
    public allowConflicts?: boolean = undefined;

    @Column({ nullable: true })
    @Description("Mirrors `-BookingWindowInDays` - a request starting further out than this many days is auto-declined.")
    @Nullable
    public bookingWindowDays?: number = undefined;

    @Column({ nullable: true })
    @Description("Mirrors `-MaximumDurationInMinutes` - a request longer than this is auto-declined.")
    @Nullable
    public maxDurationMinutes?: number = undefined;

    @Column()
    @Description("Whether send() attaches a receipt request to every outgoing message to an internal recipient by default.")
    public alwaysRequestReceiptInternal: boolean = true;

    // `nullable: true` (even though the field is a required, defaulted `boolean`): this column was added
    // after the table already existed in deployed installations, and this framework's `@Column` decorator
    // exposes no way to attach a SQL-level `DEFAULT` (see `ColumnOptions` - only `nullable` is available).
    // Without `nullable: true`, `synchronize: true`'s `ALTER TABLE ... ADD COLUMN ... NOT NULL` fails outright
    // against a populated table on Postgres/MySQL. A legacy row backfilled to SQL `NULL` reads back as
    // `false` in practice (every consumer here treats this as a plain boolean flag, and `null` is falsy), so
    // no explicit `?? false` guard is needed at read sites - same reasoning `Mailbox.keyDiscoveryHash` (the
    // pre-existing case of this exact pattern) documents for itself.
    @Column({ nullable: true })
    @Description("Same as alwaysRequestReceiptInternal, for a federated-peer recipient.")
    public alwaysRequestReceiptFederated: boolean = false;

    @Column()
    @Description("Same as alwaysRequestReceiptInternal, for an external recipient.")
    public alwaysRequestReceiptExternal: boolean = false;

    @Column()
    @Description("Whether this mailbox auto-sends a receipt back to an internal requester versus holding it for approval.")
    public autoSendReceiptsInternal: boolean = true;

    // See `alwaysRequestReceiptFederated`'s comment above - same reasoning, same fix.
    @Column({ nullable: true })
    @Description("Same as autoSendReceiptsInternal, for a federated-peer requester.")
    public autoSendReceiptsFederated: boolean = false;

    @Column()
    @Description("Same as autoSendReceiptsInternal, for an external requester.")
    public autoSendReceiptsExternal: boolean = false;

    // `nullable: true` for the same migration-safety reason as the booleans above - this framework's `@Column`
    // decorator has no SQL-level `DEFAULT` option (see `ColumnOptions`). Unlike a boolean, `null` here is NOT
    // safely usable as-is (`mailbox.keys.find(...)` throws on `null`) - every read site that could see a
    // legacy row (`BaseMessageRoute`, `BaseKeyVaultRoute`, `ScanQueueJob`) guards with `?? []`/`?? {...}`.
    @Column({ type: "simple-json", nullable: true })
    @Description("This mailbox's own encryption preference.")
    public encryptPreference: EncryptionPreference = { preferEncrypt: "nopreference" };

    @Column({ type: "simple-json", nullable: true })
    @Description("This mailbox's published public keys (signing and/or encryption).")
    public keys: PublicKey[] = [];

    @Column({ nullable: true })
    @Description("Precomputed zbase32(sha256(localPart)) of primarySmtpAddress, for the discovery endpoint's indexed lookup.")
    @Nullable
    public keyDiscoveryHash?: string = undefined;

    @Column({ nullable: true })
    @Description("This mailbox's assigned escrow scope, if any.")
    @Nullable
    public escrowScopeId?: string = undefined;

    // Enum-like string-literal-union column - needs an explicit type, same as `resourceType`. `nullable: true` so `synchronize`
    // can add the column to a table that already has rows; those rows read back `null`, which every reader takes as `domain`.
    @Column({ type: "varchar", nullable: true })
    @Description(
        "Who may see this mailbox's free/busy: `domain` (the default - any signed-in user with a mailbox in the same domain), " +
            "`shared` (callers who already hold access on it), `nobody` (only its owner and full-access delegates) or " +
            "`everyone` (any signed-in user). A row without a value reads as `domain`.",
    )
    @Nullable
    public freeBusyVisibility?: FreeBusyVisibility = "domain";

    // `simple-json`, `nullable: true` so `synchronize` can add the columns to a table that already has rows (no migration): those rows
    // read back `null`, which every reader takes as an empty list (`?? []`).
    @Column({ type: "simple-json", nullable: true })
    @Description(
        "This mailbox's Blocked Senders list: lowercase addresses (`user@example.com`) and domains (`@example.com`). Mail from one " +
            "goes to Junk Email. At most 1,000 entries; changed with `POST /:id/blocked-senders` and `DELETE /:id/blocked-senders/:entry`, " +
            "and only by the mailbox's owner or a full-access delegate. A row without a value reads as empty.",
    )
    @Nullable
    public blockedSenders?: string[] = [];

    @Column({ type: "simple-json", nullable: true })
    @Description(
        "This mailbox's Safe Senders list, shaped like `blockedSenders`. Authenticated mail from one is never junked for a spam " +
            "verdict (it never releases mail an antivirus or policy verdict quarantined). A row without a value reads as empty.",
    )
    @Nullable
    public safeSenders?: string[] = [];

    constructor(other?: Partial<MailboxSQL>) {
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
            this.alwaysRequestReceiptFederated =
                other.alwaysRequestReceiptFederated !== undefined
                    ? other.alwaysRequestReceiptFederated
                    : this.alwaysRequestReceiptFederated;
            this.alwaysRequestReceiptExternal =
                other.alwaysRequestReceiptExternal !== undefined
                    ? other.alwaysRequestReceiptExternal
                    : this.alwaysRequestReceiptExternal;
            this.autoSendReceiptsInternal =
                other.autoSendReceiptsInternal !== undefined ? other.autoSendReceiptsInternal : this.autoSendReceiptsInternal;
            this.autoSendReceiptsFederated =
                other.autoSendReceiptsFederated !== undefined ? other.autoSendReceiptsFederated : this.autoSendReceiptsFederated;
            this.autoSendReceiptsExternal =
                other.autoSendReceiptsExternal !== undefined ? other.autoSendReceiptsExternal : this.autoSendReceiptsExternal;
            this.encryptPreference = other.encryptPreference !== undefined ? other.encryptPreference : this.encryptPreference;
            this.keys = other.keys !== undefined ? other.keys : this.keys;
            this.keyDiscoveryHash = "keyDiscoveryHash" in other ? other.keyDiscoveryHash : this.keyDiscoveryHash;
            this.escrowScopeId = "escrowScopeId" in other ? other.escrowScopeId : this.escrowScopeId;
            this.freeBusyVisibility = other.freeBusyVisibility !== undefined ? other.freeBusyVisibility : this.freeBusyVisibility;
            this.blockedSenders = other.blockedSenders !== undefined ? other.blockedSenders : this.blockedSenders;
            this.safeSenders = other.safeSenders !== undefined ? other.safeSenders : this.safeSenders;
        }
    }
}
