///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseMongoEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { DataSubjectErasureRequest, DataSubjectErasureStatus } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `DataSubjectErasureRequest` interface for storage in MongoDB. If a SQL database
 * is desired, please use `models.sql.DataSubjectErasureRequestSQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@Description("A GDPR Article 17 (right to erasure) request for one mailbox.")
@Index("data_subject_erasure_request_mailbox", ["mailboxUid"])
@Protect(
    {
        uid: "DataSubjectErasureRequest",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class DataSubjectErasureRequestMongo extends BaseMongoEntity implements DataSubjectErasureRequest {
    @Column()
    @Description("The mailbox this erasure request covers.")
    public mailboxUid: string = "";

    @Column()
    @Description("The caller who created this request.")
    public requestedByUserUid: string = "";

    @Column()
    @Description("The current status of this request.")
    public status: DataSubjectErasureStatus = "pending";

    @Column()
    @Nullable
    public reviewedByUserUid?: string;

    @Column()
    @Nullable
    public reason?: string;

    @Column()
    @Nullable
    public purgedCount?: number;

    constructor(other?: Partial<DataSubjectErasureRequestMongo>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.requestedByUserUid = other.requestedByUserUid !== undefined ? other.requestedByUserUid : this.requestedByUserUid;
            this.status = other.status !== undefined ? other.status : this.status;
            this.reviewedByUserUid = "reviewedByUserUid" in other ? other.reviewedByUserUid : this.reviewedByUserUid;
            this.reason = "reason" in other ? other.reason : this.reason;
            this.purgedCount = "purgedCount" in other ? other.purgedCount : this.purgedCount;
        }
    }
}
