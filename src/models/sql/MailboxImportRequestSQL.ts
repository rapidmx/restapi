///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { MailboxImportFormat, MailboxImportRequest, MailboxImportStatus } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `MailboxImportRequest` interface for storage in a SQL database. If MongoDB is
 * desired, please use `models.mongo.MailboxImportRequestMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description("A request to import historical mail from an uploaded Mbox or PST file into a mailbox.")
@Index("mailbox_import_request_mailbox", ["mailboxUid"])
@Index("mailbox_import_request_status", ["status"])
@Protect(
    {
        uid: "MailboxImportRequest",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class MailboxImportRequestSQL extends BaseEntity implements MailboxImportRequest {
    @Column()
    @Description("The mailbox this import targets.")
    public mailboxUid: string = "";

    @Column()
    @Description("The caller who created this request.")
    public requestedByUserUid: string = "";

    @Column()
    @Description("Every imported message is filed into this folder.")
    public targetFolderUid: string = "";

    // `type: "varchar"` is required on every string-literal-union column - see the identical note on
    // `DataExportRequestSQL.format`.
    @Column({ type: "varchar" })
    @Description("mbox or pst.")
    public format: MailboxImportFormat = "mbox";

    @Column()
    @Description("The BlobStore key the caller's originally-uploaded file is stored under.")
    public sourceBlobKey: string = "";

    @Column({ type: "varchar" })
    @Description("The current status of this request.")
    public status: MailboxImportStatus = "pending";

    @Column({ nullable: true })
    @Nullable
    public importedCount?: number;

    @Column({ nullable: true })
    @Nullable
    public failedCount?: number;

    @Column({ type: "text", nullable: true })
    @Nullable
    public errorMessage?: string;

    @Column({ nullable: true })
    @Description("How many times MailboxImportJob has claimed this request for processing (lease/retry counter).")
    @Nullable
    public processingAttempts?: number;

    constructor(other?: Partial<MailboxImportRequestSQL>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.requestedByUserUid = other.requestedByUserUid !== undefined ? other.requestedByUserUid : this.requestedByUserUid;
            this.targetFolderUid = other.targetFolderUid !== undefined ? other.targetFolderUid : this.targetFolderUid;
            this.format = other.format !== undefined ? other.format : this.format;
            this.sourceBlobKey = other.sourceBlobKey !== undefined ? other.sourceBlobKey : this.sourceBlobKey;
            this.status = other.status !== undefined ? other.status : this.status;
            this.importedCount = "importedCount" in other ? other.importedCount : this.importedCount;
            this.failedCount = "failedCount" in other ? other.failedCount : this.failedCount;
            this.errorMessage = "errorMessage" in other ? other.errorMessage : this.errorMessage;
            this.processingAttempts = "processingAttempts" in other ? other.processingAttempts : this.processingAttempts;
        }
    }
}
