///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { DataSubjectErasureRequest, DataSubjectErasureStatus } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `DataSubjectErasureRequest` interface for storage in a SQL database. If MongoDB
 * is desired, please use `models.mongo.DataSubjectErasureRequestMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description("A GDPR Article 17 (right to erasure) request for one mailbox.")
@Index("data_subject_erasure_request_mailbox", ["mailboxUid"])
@Index("data_subject_erasure_request_status", ["status"])
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
export class DataSubjectErasureRequestSQL extends BaseEntity implements DataSubjectErasureRequest {
    @Column()
    @Description("The mailbox this erasure request covers.")
    public mailboxUid: string = "";

    @Column()
    @Description("The caller who created this request.")
    public requestedByUserUid: string = "";

    @Column({ type: "varchar" })
    @Description("The current status of this request.")
    public status: DataSubjectErasureStatus = "pending";

    @Column({ nullable: true })
    @Nullable
    public reviewedByUserUid?: string;

    @Column({ type: "text", nullable: true })
    @Nullable
    public reason?: string;

    @Column({ nullable: true })
    @Nullable
    public purgedCount?: number;

    @Column({ type: "boolean", nullable: true })
    @Nullable
    @Description("Set when an administrator filed this request for the leftover data of a mailbox that was already deleted.")
    public leftoverOnly?: boolean;

    constructor(other?: Partial<DataSubjectErasureRequestSQL>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.requestedByUserUid = other.requestedByUserUid !== undefined ? other.requestedByUserUid : this.requestedByUserUid;
            this.status = other.status !== undefined ? other.status : this.status;
            this.reviewedByUserUid = "reviewedByUserUid" in other ? other.reviewedByUserUid : this.reviewedByUserUid;
            this.reason = "reason" in other ? other.reason : this.reason;
            this.purgedCount = "purgedCount" in other ? other.purgedCount : this.purgedCount;
            this.leftoverOnly = "leftoverOnly" in other ? other.leftoverOnly : this.leftoverOnly;
        }
    }
}
