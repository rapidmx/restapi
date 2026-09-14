///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { DataExportFormat, DataExportRequest, DataExportStatus } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `DataExportRequest` interface for storage in a SQL database. If MongoDB is
 * desired, please use `models.mongo.DataExportRequestMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description("A GDPR data-portability/access request for one mailbox's content.")
@Index("data_export_request_mailbox", ["mailboxUid"])
@Index("data_export_request_status", ["status"])
@Protect(
    {
        uid: "DataExportRequest",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class DataExportRequestSQL extends BaseEntity implements DataExportRequest {
    @Column()
    @Description("The mailbox this export covers.")
    public mailboxUid: string = "";

    @Column()
    @Description("The caller who created this request.")
    public requestedByUserUid: string = "";

    // `type: "varchar"` is required on every string-literal-union column - see the identical note on
    // `DomainSQL.dmarcPolicy`.
    @Column({ type: "varchar" })
    @Description("json (GDPR portability bundle) or mbox (interoperable mail export).")
    public format: DataExportFormat = "json";

    @Column({ type: "varchar" })
    @Description("The current status of this request.")
    public status: DataExportStatus = "pending";

    @Column({ nullable: true })
    @Description("The BlobStore key the finished export bundle is stored under, once ready.")
    @Nullable
    public blobKey?: string;

    @Column({ type: "text", nullable: true })
    @Nullable
    public errorMessage?: string;

    @Column({ nullable: true })
    @Description("How many times DataExportJob has claimed this request for processing (lease/retry counter).")
    @Nullable
    public processingAttempts?: number;

    constructor(other?: Partial<DataExportRequestSQL>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.requestedByUserUid = other.requestedByUserUid !== undefined ? other.requestedByUserUid : this.requestedByUserUid;
            this.format = other.format !== undefined ? other.format : this.format;
            this.status = other.status !== undefined ? other.status : this.status;
            this.blobKey = "blobKey" in other ? other.blobKey : this.blobKey;
            this.errorMessage = "errorMessage" in other ? other.errorMessage : this.errorMessage;
            this.processingAttempts = "processingAttempts" in other ? other.processingAttempts : this.processingAttempts;
        }
    }
}
