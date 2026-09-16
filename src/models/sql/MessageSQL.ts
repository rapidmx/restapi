///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    ACLAction,
    DocDecorators,
    ModelDecorators,
    PersistenceDecorators,
    RecoverableBaseEntity,
} from "@rapidrest/service-core";
import { ObjectDecorators } from "@rapidrest/core";
import {
    Message,
    MessageClassification,
    MessageFlags,
    MessageImportance,
    MessageReceiptEntry,
    Recipient,
    RecipientType,
} from "../types.js";
import { boundIndexedValue } from "../../util/ConversationUtils.js";
import { deriveMessageListFields } from "../../util/MessageListUtils.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Nullable } = ObjectDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `Message` interface for storage in a SQL database. If MongoDB is desired, please use
 * `models.mongo.MessageMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description(
    "Defines a single email message stored in a `Folder`. The raw MIME source and sanitized HTML body are " +
        "not stored inline on this record — they live in the configured `BlobStore`, referenced by " +
        "`bodyBlobKey`/`sanitizedHtmlBlobKey`.",
)
@Index("message_folder", ["folderUid"])
@Index("message_mailbox", ["mailboxUid"])
@Index("message_mailbox_conversation", ["mailboxUid", "conversationId"])
// The mail list's own access paths: its default ordering, and the two filters (Unread, Flagged) a mail client
// offers on every list. Each is `folderUid` first (a list is always folder-scoped), then the filtered column,
// then `receivedDate`, so one index serves the filter and the ordering together. The rarer sorts/filters (From,
// Subject, Importance, Has files, Focused/Other) deliberately get no index of their own - they are already
// narrowed to one folder by `message_folder`, and sorting within a single folder's rows is cheap next to the
// write cost every extra index on this table would add to delivery.
@Index("message_folder_received", ["folderUid", "receivedDate"])
@Index("message_folder_read_received", ["folderUid", "read", "receivedDate"])
@Index("message_folder_flagged_received", ["folderUid", "flagged", "receivedDate"])
// Expanding one conversation (`conversationMessages()`) reads a mailbox's messages for one `conversationId` in
// date order.
@Index("message_mailbox_conversation_received", ["mailboxUid", "conversationId", "receivedDate"])
@Index("message_folder_modified", ["folderUid", "dateModified", "uid"])
@Index("message_mailbox_modified", ["mailboxUid", "dateModified", "uid"])
@Index("message_id", ["messageId"])
@Index("message_sent_date", ["sentDate"])
@Index("message_scheduled_send_time", ["scheduledSendTime"])
@Index("message_search_indexed_at", ["searchIndexedAt"])
@Index("message_body_blob_key", ["bodyBlobKey"])
@Index("message_sanitized_html_blob_key", ["sanitizedHtmlBlobKey"])
@Protect(
    {
        uid: "Message",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class MessageSQL extends RecoverableBaseEntity implements Message {
    @Column()
    @Description("The unique identifier of the `Folder` this message currently resides in.")
    public folderUid: string = "";

    @Column()
    @Description("The unique identifier of the `Mailbox` this message belongs to.")
    public mailboxUid: string = "";

    // Bounded by `boundIndexedValue()` in the constructor (an over-long value is stored as its SHA-256): indexed
    // and equality-matched, so it stays a plain (indexable) string column, which is `varchar(255)` on MySQL.
    @Column()
    @Description(
        "The RFC 5322 `Message-ID` header value, used to deduplicate and thread messages. A value longer than 255 " +
            "characters is stored as `sha256:<hex>` of the original.",
    )
    public messageId: string = "";

    @Column({ type: "text" })
    @Description("The subject line of the message.")
    public subject: string = "";

    @Column({ type: "simple-json" })
    @Description("The sender of the message.")
    public from: Recipient = { address: "", type: RecipientType.TO };

    @Column({ type: "simple-json" })
    @Description("The list of recipients (to/cc/bcc) of the message.")
    public recipients: Recipient[] = [];

    @Column()
    @Description("The date and time the message was sent.")
    public sentDate: Date = new Date();

    @Column()
    @Description("The date and time the message was received.")
    public receivedDate: Date = new Date();

    @Column()
    @Description("The key under which the raw MIME source is stored in the `BlobStore`, unmodified from ingestion/send.")
    public bodyBlobKey: string = "";

    @Column({ nullable: true })
    @Description(
        "The key under which the message's HTML body is stored, after ScanPipeline's sanitization pass has " +
            "run - absent for a not-yet-scanned draft or a message with no HTML body.",
    )
    @Nullable
    public sanitizedHtmlBlobKey?: string;

    @Column({ type: "text" })
    @Description("A short plain-text preview of the message body, generated at ingestion time.")
    public bodyPreview: string = "";

    @Column({ type: "simple-json" })
    @Description("The read/answered/flagged state of the message.")
    public flags: MessageFlags = { read: false, flagged: false, answered: false, forwarded: false };

    // The four denormalized list fields below are derived from `flags`/`from`/`importance` by
    // `deriveMessageListFields()` in the constructor, and by `syncMessageListFields()` for a partial update
    // (which never runs a constructor). `nullable: true` for the same reason `encrypted` below needs it - added
    // after this table already existed in deployed installations, and `@Column` has no SQL-level `DEFAULT`
    // option, so a NOT NULL `ALTER TABLE ADD COLUMN` fails outright against a populated table.
    @Column({ nullable: true })
    @Description("Server-managed mirror of `flags.read`, so an unread filter can be an indexed query.")
    @Nullable
    public read?: boolean;

    @Column({ nullable: true })
    @Description("Server-managed mirror of `flags.flagged`, so a flagged filter can be an indexed query.")
    @Nullable
    public flagged?: boolean;

    // Bounded to `MAX_INDEXED_VALUE_LENGTH` by `deriveMessageListFields()` for the same reason `messageId` is: a
    // plain string column is `varchar(255)` on MySQL, which rejects a longer value outright, and an address can run
    // to 320 characters.
    @Column({ nullable: true })
    @Description("Server-managed mirror of `from.address`, normalized and length-bounded, so a list can sort by sender.")
    @Nullable
    public fromAddress?: string;

    @Column({ type: "integer", nullable: true })
    @Description("Server-managed sortable rank of `importance` (low 0, normal 1, high 2).")
    @Nullable
    public importanceRank?: number;

    // `type: "varchar"` is required on every enum-typed column: TypeScript's `emitDecoratorMetadata` reflects
    // a string enum's design type as the enum object itself, not a primitive constructor, which TypeORM/
    // better-sqlite3 cannot resolve into a column type on its own (it would otherwise fail at
    // `DataSource.initialize()` with "Data type 'undefined' ... is not supported").
    @Column({ type: "varchar" })
    @Description("The importance level of the message.")
    public importance: MessageImportance = MessageImportance.NORMAL;

    // `text`: sender-controlled and unindexed - a plain string column is `varchar(255)` on MySQL, which rejects a
    // longer value and fails delivery.
    @Column({ type: "text", nullable: true })
    @Description("The RFC 5322 `In-Reply-To` header value, if this message is a reply.")
    @Nullable
    public inReplyTo?: string;

    @Column({ type: "simple-json" })
    @Description("The RFC 5322 `References` header value(s), for building conversation threads.")
    public references: string[] = [];

    @Column()
    @Description("`true` if the message has one or more attachments.")
    public hasAttachments: boolean = false;

    // `nullable: true` for the same reason `encrypted` below needs it - added after this table already
    // existed in deployed installations, and `@Column` has no SQL-level `DEFAULT` option, so a NOT NULL
    // `ALTER TABLE ADD COLUMN` fails against a populated table. Unlike a boolean, a legacy row's `NULL` here
    // reads back as literal `null`, not `[]` - every reader of this field elsewhere in this codebase treats
    // it defensively (`labelUids ?? []`) for exactly that reason, matching `Message.labelUids`'s own "absent
    // is equivalent to empty" contract in `models/types.ts`.
    @Column({ type: "simple-json", nullable: true })
    @Description("The `Label.uid`s applied to this message, if any.")
    public labelUids: string[] = [];

    // `nullable: true`: added after the table already existed in deployed installations, and this framework's
    // `@Column` decorator has no SQL-level `DEFAULT` option (see `ColumnOptions`) - without `nullable: true`,
    // `synchronize: true`'s `ALTER TABLE ... ADD COLUMN ... NOT NULL` fails outright against a populated table
    // on Postgres/MySQL. A legacy row's `NULL` reads back as falsy, same as this flag's intended default.
    @Column({ nullable: true })
    @Description("`true` if this message's body is S/MIME (CMS) encrypted.")
    public encrypted: boolean = false;

    @Column({ nullable: true })
    @Description("The unique identifier of this message's `ScanResult`, once scanning has completed.")
    @Nullable
    public scanResultUid?: string;

    @Column({ nullable: true })
    @Description("The timestamp this message was last (re)indexed for full-text search, if ever.")
    @Nullable
    public searchIndexedAt?: Date;

    @Column({ nullable: true })
    @Description("How many times `SearchIndexJob` has failed to process this message (unset when never failed).")
    @Nullable
    public searchIndexAttempts?: number;

    @Column({ nullable: true })
    @Description("The earliest time `SearchIndexJob` will retry this message after a failure.")
    @Nullable
    public searchIndexNextAttemptAt?: Date;

    @Column({ type: "text", nullable: true })
    @Description("The error from this message's most recent failed `SearchIndexJob` attempt, if any.")
    @Nullable
    public searchIndexError?: string;

    @Column({ nullable: true })
    @Description(
        "When set to a future time, `send()` defers relay until then instead of sending immediately - the " +
            "message sits in the mailbox's `OUTBOX` folder until `ScheduledSendJob` relays it and clears this field.",
    )
    @Nullable
    public scheduledSendTime?: Date;

    @Column({ nullable: true })
    @Description("Consecutive failed ScheduledSendJob attempts for the current scheduled send.")
    @Nullable
    public scheduledSendAttempts?: number;

    @Column({ type: "text", nullable: true })
    @Description("Why ScheduledSendJob gave up on (or refused) this scheduled send, leaving it unsent.")
    @Nullable
    public scheduledSendError?: string;

    @Column({ nullable: true })
    @Description("Set once the transport accepted this scheduled send but filing it into Sent Items failed - never relayed again.")
    @Nullable
    public scheduledSendRelayedAt?: Date;

    @Column({ nullable: true })
    @Description("While in the future, a send of this message is in flight (claimed for relay) and it can't leave Outbox.")
    @Nullable
    public scheduledSendLeaseExpiresAt?: Date;

    @Column({ type: "simple-json", nullable: true })
    @Description("Server-managed: body blob keys this draft's body replaced while its mailbox was under a legal hold.")
    @Nullable
    public retainedBodyBlobKeys?: string[] | null;

    @Column({ type: "text", nullable: true })
    @Description("Client-written, write-once opaque seal of a client-side signature verification (PUT /:id/verification-seal).")
    @Nullable
    public verificationSeal?: string | null;

    @Column({ type: "integer", nullable: true })
    @Description("The key vault master key generation verificationSeal was sealed under (set with it).")
    @Nullable
    public verificationSealGeneration?: number | null;

    @Column({ nullable: true })
    @Description(
        "Set by recall() the moment a recall is requested - purely informational, the eventual outcome is " +
            "reported back to the sender as an ordinary visible email instead of being synced onto this field.",
    )
    @Nullable
    public recallRequestedAt?: Date;

    // Bounded the same way as `messageId` (see `boundIndexedValue()`), as it's derived from sender-controlled headers.
    @Column({ nullable: true })
    @Description(
        "Groups this message with the rest of its RFC 5322/2822 thread - computed once at creation time " +
            "from this message's own references/inReplyTo/messageId.",
    )
    @Nullable
    public conversationId?: string;

    // `type: "varchar"` for the same enum-column reason documented on `importance` above.
    @Column({ type: "varchar", nullable: true })
    @Description(
        "Which half of the Focused Inbox split this message belongs to, assigned at delivery time - only " +
            "ever set for mail delivered to the INBOX, absent otherwise (treat absent as focused).",
    )
    @Nullable
    public inferenceClassification?: MessageClassification;

    @Column({ nullable: true })
    @Description(
        "Set on a Draft, before send(), to request a real RFC 3798 MDN from every recipient - undefined " +
            "means 'use this mailbox's own always-request default'.",
    )
    @Nullable
    public requestReceipt?: boolean;

    // `text` for the same reason as `inReplyTo`.
    @Column({ type: "text", nullable: true })
    @Description(
        "The address a receipt should be sent back to, persisted on the recipient's own delivered copy at " +
            "delivery time from the inbound Disposition-Notification-To header.",
    )
    @Nullable
    public dispositionNotificationTo?: string;

    @Column({ nullable: true })
    @Description("Idempotency stamp, recipient's own delivered copy - set once a delivery receipt has actually been sent.")
    @Nullable
    public deliveryReceiptSentAt?: Date;

    @Column({ nullable: true })
    @Description("Idempotency stamp, recipient's own delivered copy - set once a read receipt has actually been sent.")
    @Nullable
    public readReceiptSentAt?: Date;

    @Column()
    @Description(
        "true when a delivery receipt was requested but is held for the mailbox owner's explicit approval " +
            "instead of being sent immediately.",
    )
    public deliveryReceiptPending: boolean = false;

    @Column()
    @Description("Same as deliveryReceiptPending, for a read receipt.")
    public readReceiptPending: boolean = false;

    @Column()
    @Description(
        "true once the mailbox owner has explicitly declined a pending delivery receipt - a separate, " +
            "permanent 'handled, don't ask again' marker distinct from deliveryReceiptPending.",
    )
    public deliveryReceiptDeclined: boolean = false;

    @Column()
    @Description("Same as deliveryReceiptDeclined, for a read receipt.")
    public readReceiptDeclined: boolean = false;

    @Column({ type: "simple-json", nullable: true })
    @Description(
        "The per-recipient delivery/read roster - the client-visible indicator shown on the original sent " +
            "message. undefined (not an empty array) when no receipt was ever requested for this message.",
    )
    @Nullable
    public receiptStatus?: MessageReceiptEntry[];

    constructor(other?: Partial<MessageSQL>) {
        super(other);

        if (other) {
            this.folderUid = other.folderUid !== undefined ? other.folderUid : this.folderUid;
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.messageId = other.messageId !== undefined ? boundIndexedValue(other.messageId) : this.messageId;
            this.subject = other.subject !== undefined ? other.subject : this.subject;
            this.from = other.from !== undefined ? other.from : this.from;
            this.recipients = other.recipients !== undefined ? other.recipients : this.recipients;
            this.sentDate = other.sentDate !== undefined ? other.sentDate : this.sentDate;
            this.receivedDate = other.receivedDate !== undefined ? other.receivedDate : this.receivedDate;
            this.bodyBlobKey = other.bodyBlobKey !== undefined ? other.bodyBlobKey : this.bodyBlobKey;
            this.sanitizedHtmlBlobKey = "sanitizedHtmlBlobKey" in other ? other.sanitizedHtmlBlobKey : this.sanitizedHtmlBlobKey;
            this.bodyPreview = other.bodyPreview !== undefined ? other.bodyPreview : this.bodyPreview;
            this.flags = other.flags !== undefined ? other.flags : this.flags;
            this.importance = other.importance !== undefined ? other.importance : this.importance;
            this.inReplyTo = "inReplyTo" in other ? other.inReplyTo : this.inReplyTo;
            this.references = other.references !== undefined ? other.references : this.references;
            this.hasAttachments = other.hasAttachments !== undefined ? other.hasAttachments : this.hasAttachments;
            this.labelUids = other.labelUids !== undefined ? other.labelUids : this.labelUids;
            this.encrypted = other.encrypted !== undefined ? other.encrypted : this.encrypted;
            this.scanResultUid = "scanResultUid" in other ? other.scanResultUid : this.scanResultUid;
            this.searchIndexedAt = "searchIndexedAt" in other ? other.searchIndexedAt : this.searchIndexedAt;
            this.searchIndexAttempts = "searchIndexAttempts" in other ? other.searchIndexAttempts : this.searchIndexAttempts;
            this.searchIndexNextAttemptAt = "searchIndexNextAttemptAt" in other ? other.searchIndexNextAttemptAt : this.searchIndexNextAttemptAt;
            this.searchIndexError = "searchIndexError" in other ? other.searchIndexError : this.searchIndexError;
            this.scheduledSendTime = "scheduledSendTime" in other ? other.scheduledSendTime : this.scheduledSendTime;
            this.scheduledSendAttempts = "scheduledSendAttempts" in other ? other.scheduledSendAttempts : this.scheduledSendAttempts;
            this.scheduledSendError = "scheduledSendError" in other ? other.scheduledSendError : this.scheduledSendError;
            this.scheduledSendRelayedAt = "scheduledSendRelayedAt" in other ? other.scheduledSendRelayedAt : this.scheduledSendRelayedAt;
            this.scheduledSendLeaseExpiresAt =
                "scheduledSendLeaseExpiresAt" in other ? other.scheduledSendLeaseExpiresAt : this.scheduledSendLeaseExpiresAt;
            this.retainedBodyBlobKeys = "retainedBodyBlobKeys" in other ? other.retainedBodyBlobKeys : this.retainedBodyBlobKeys;
            this.verificationSeal = "verificationSeal" in other ? other.verificationSeal : this.verificationSeal;
            this.verificationSealGeneration =
                "verificationSealGeneration" in other ? other.verificationSealGeneration : this.verificationSealGeneration;
            this.recallRequestedAt = "recallRequestedAt" in other ? other.recallRequestedAt : this.recallRequestedAt;
            this.conversationId = "conversationId" in other ? boundIndexedValue(other.conversationId) : this.conversationId;
            this.inferenceClassification =
                "inferenceClassification" in other ? other.inferenceClassification : this.inferenceClassification;
            this.requestReceipt = "requestReceipt" in other ? other.requestReceipt : this.requestReceipt;
            this.dispositionNotificationTo =
                "dispositionNotificationTo" in other ? other.dispositionNotificationTo : this.dispositionNotificationTo;
            this.deliveryReceiptSentAt = "deliveryReceiptSentAt" in other ? other.deliveryReceiptSentAt : this.deliveryReceiptSentAt;
            this.readReceiptSentAt = "readReceiptSentAt" in other ? other.readReceiptSentAt : this.readReceiptSentAt;
            this.deliveryReceiptPending =
                other.deliveryReceiptPending !== undefined ? other.deliveryReceiptPending : this.deliveryReceiptPending;
            this.readReceiptPending = other.readReceiptPending !== undefined ? other.readReceiptPending : this.readReceiptPending;
            this.deliveryReceiptDeclined =
                other.deliveryReceiptDeclined !== undefined ? other.deliveryReceiptDeclined : this.deliveryReceiptDeclined;
            this.readReceiptDeclined =
                other.readReceiptDeclined !== undefined ? other.readReceiptDeclined : this.readReceiptDeclined;
            this.receiptStatus = "receiptStatus" in other ? other.receiptStatus : this.receiptStatus;
        }

        // Always derived, never copied from `other`: these are server-managed mirrors of `flags`/`from`/
        // `importance` (see `util/MessageListUtils.ts`), so taking a caller's value would let the two disagree.
        Object.assign(this, deriveMessageListFields(this));
    }
}
