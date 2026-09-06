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
import { Message, MessageFlags, MessageImportance, Recipient, RecipientType } from "../types.js";
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
@Index("message_id", ["messageId"])
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

    @Column()
    @Description("The RFC 5322 `Message-ID` header value, used to deduplicate and thread messages.")
    public messageId: string = "";

    @Column()
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

    @Column()
    @Description("A short plain-text preview of the message body, generated at ingestion time.")
    public bodyPreview: string = "";

    @Column({ type: "simple-json" })
    @Description("The read/answered/flagged state of the message.")
    public flags: MessageFlags = { read: false, flagged: false, answered: false, forwarded: false };

    // `type: "varchar"` is required on every enum-typed column: TypeScript's `emitDecoratorMetadata` reflects
    // a string enum's design type as the enum object itself, not a primitive constructor, which TypeORM/
    // better-sqlite3 cannot resolve into a column type on its own (it would otherwise fail at
    // `DataSource.initialize()` with "Data type 'undefined' ... is not supported").
    @Column({ type: "varchar" })
    @Description("The importance level of the message.")
    public importance: MessageImportance = MessageImportance.NORMAL;

    @Column({ nullable: true })
    @Description("The RFC 5322 `In-Reply-To` header value, if this message is a reply.")
    @Nullable
    public inReplyTo?: string;

    @Column({ type: "simple-json" })
    @Description("The RFC 5322 `References` header value(s), for building conversation threads.")
    public references: string[] = [];

    @Column()
    @Description("`true` if the message has one or more attachments.")
    public hasAttachments: boolean = false;

    @Column({ nullable: true })
    @Description("The unique identifier of this message's `ScanResult`, once scanning has completed.")
    @Nullable
    public scanResultUid?: string;

    @Column({ nullable: true })
    @Description("The timestamp this message was last (re)indexed for full-text search, if ever.")
    @Nullable
    public searchIndexedAt?: Date;

    constructor(other?: Partial<MessageSQL>) {
        super(other);

        if (other) {
            this.folderUid = other.folderUid !== undefined ? other.folderUid : this.folderUid;
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.messageId = other.messageId !== undefined ? other.messageId : this.messageId;
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
            this.scanResultUid = "scanResultUid" in other ? other.scanResultUid : this.scanResultUid;
            this.searchIndexedAt = "searchIndexedAt" in other ? other.searchIndexedAt : this.searchIndexedAt;
        }
    }
}
