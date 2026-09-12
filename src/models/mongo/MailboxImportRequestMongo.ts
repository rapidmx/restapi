///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseMongoEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { MailboxImportFormat, MailboxImportRequest, MailboxImportStatus } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `MailboxImportRequest` interface for storage in MongoDB. If a SQL database is
 * desired, please use `models.sql.MailboxImportRequestSQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@Description("A request to import historical mail from an uploaded Mbox or PST file into a mailbox.")
@Index("mailbox_import_request_mailbox", ["mailboxUid"])
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
export class MailboxImportRequestMongo extends BaseMongoEntity implements MailboxImportRequest {
    @Column()
    @Description("The mailbox this import targets.")
    public mailboxUid: string = "";

    @Column()
    @Description("The caller who created this request.")
    public requestedByUserUid: string = "";

    @Column()
    @Description("Every imported message is filed into this folder.")
    public targetFolderUid: string = "";

    @Column()
    @Description("mbox or pst.")
    public format: MailboxImportFormat = "mbox";

    @Column()
    @Description("The BlobStore key the caller's originally-uploaded file is stored under.")
    public sourceBlobKey: string = "";

    @Column()
    @Description("The current status of this request.")
    public status: MailboxImportStatus = "pending";

    @Column()
    @Nullable
    public importedCount?: number;

    @Column()
    @Nullable
    public failedCount?: number;

    @Column()
    @Nullable
    public errorMessage?: string;

    constructor(other?: Partial<MailboxImportRequestMongo>) {
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
        }
    }
}
