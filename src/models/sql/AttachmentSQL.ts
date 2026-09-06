///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ACLAction, BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { ObjectDecorators } from "@rapidrest/core";
import { Attachment } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Nullable } = ObjectDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `Attachment` interface for storage in a SQL database. If MongoDB is desired, please use
 * `models.mongo.AttachmentMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description(
    "Defines a single file attached to a `Message`. The binary content is stored in the configured " +
        "`BlobStore`, referenced by `blobKey`.",
)
@Index("attachment_message", ["messageUid"])
@Index("attachment_folder", ["folderUid"])
@Index("attachment_mailbox", ["mailboxUid"])
@Protect(
    {
        uid: "Attachment",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class AttachmentSQL extends BaseEntity implements Attachment {
    @Column()
    @Description("The unique identifier of the `Message` this attachment belongs to.")
    public messageUid: string = "";

    @Column()
    @Description("The unique identifier of the `Folder` the owning `Message` resides in.")
    public folderUid: string = "";

    @Column()
    @Description("The unique identifier of the `Mailbox` this attachment belongs to.")
    public mailboxUid: string = "";

    @Column()
    @Description("The filename of the attachment.")
    public filename: string = "";

    @Column()
    @Description("The MIME type of the attachment.")
    public mimeType: string = "";

    @Column()
    @Description("The size, in bytes, of the attachment's content.")
    public sizeBytes: number = 0;

    @Column()
    @Description("The key under which the attachment's binary content is stored in the `BlobStore`.")
    public blobKey: string = "";

    @Column({ nullable: true })
    @Description("The MIME `Content-ID`, present when this attachment is referenced inline by the message's HTML body.")
    @Nullable
    public contentId?: string;

    @Column()
    @Description("`true` if this attachment is displayed inline in the message body rather than listed separately.")
    public isInline: boolean = false;

    @Column({ nullable: true })
    @Description("The key under which this attachment's extracted plain text is stored in the `BlobStore`, once extracted.")
    @Nullable
    public extractedTextBlobKey?: string;

    @Column({ nullable: true })
    @Description("The unique identifier of this attachment's `ScanResult`, once scanning has completed.")
    @Nullable
    public scanResultUid?: string;

    constructor(other?: Partial<AttachmentSQL>) {
        super(other);

        if (other) {
            this.messageUid = other.messageUid !== undefined ? other.messageUid : this.messageUid;
            this.folderUid = other.folderUid !== undefined ? other.folderUid : this.folderUid;
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.filename = other.filename !== undefined ? other.filename : this.filename;
            this.mimeType = other.mimeType !== undefined ? other.mimeType : this.mimeType;
            this.sizeBytes = other.sizeBytes !== undefined ? other.sizeBytes : this.sizeBytes;
            this.blobKey = other.blobKey !== undefined ? other.blobKey : this.blobKey;
            this.contentId = "contentId" in other ? other.contentId : this.contentId;
            this.isInline = other.isInline !== undefined ? other.isInline : this.isInline;
            this.extractedTextBlobKey =
                "extractedTextBlobKey" in other ? other.extractedTextBlobKey : this.extractedTextBlobKey;
            this.scanResultUid = "scanResultUid" in other ? other.scanResultUid : this.scanResultUid;
        }
    }
}
