///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseMongoEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { MatterExportRequest, MatterExportStatus } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `MatterExportRequest` interface for storage in MongoDB. If a SQL database is
 * desired, please use `models.sql.MatterExportRequestSQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@Description("A holder-invoked eDiscovery export spanning a Matter's full custodian set.")
@Index("matter_export_request_matter", ["matterId"])
@Protect(
    {
        uid: "MatterExportRequest",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class MatterExportRequestMongo extends BaseMongoEntity implements MatterExportRequest {
    @Column()
    @Description("The matter this export covers.")
    public matterId: string = "";

    @Column()
    @Description("The holder who created this request.")
    public requestedByUserUid: string = "";

    @Column()
    @Description("The current status of this request.")
    public status: MatterExportStatus = "pending";

    @Column()
    @Description("The BlobStore key the finished export bundle is stored under, once ready.")
    @Nullable
    public blobKey?: string;

    @Column()
    @Nullable
    public errorMessage?: string;

    constructor(other?: Partial<MatterExportRequestMongo>) {
        super(other);

        if (other) {
            this.matterId = other.matterId !== undefined ? other.matterId : this.matterId;
            this.requestedByUserUid = other.requestedByUserUid !== undefined ? other.requestedByUserUid : this.requestedByUserUid;
            this.status = other.status !== undefined ? other.status : this.status;
            this.blobKey = "blobKey" in other ? other.blobKey : this.blobKey;
            this.errorMessage = "errorMessage" in other ? other.errorMessage : this.errorMessage;
        }
    }
}
