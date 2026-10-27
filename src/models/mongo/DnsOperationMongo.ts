///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseMongoEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { DnsOperation, DnsOperationRecord, DnsOperationState, DnsOperationType } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `DnsOperation` interface for storage in MongoDB. If SQL is desired, please use
 * `models.sql.DnsOperationSQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@Description("A one-shot operation the DNS controller runs for the server: a credentials test, a takeover or a restore.")
@Index("dnsoperation_state", ["state"])
@Protect(
    {
        uid: "DnsOperation",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class DnsOperationMongo extends BaseMongoEntity implements DnsOperation {
    @Column()
    @Description("What the operation does: test, takeover or restore.")
    public type: DnsOperationType = "test";

    @Column()
    @Description("The DNS provider config the operation runs with.")
    public providerUid: string = "";

    @Column()
    @Description("The domain the operation concerns, when it concerns one.")
    @Nullable
    public domainUid?: string;

    @Column()
    @Description("The endpoint set whose records the operation writes.")
    @Nullable
    public endpointSetId?: string;

    @Column()
    @Description("The records the operation writes.")
    @Nullable
    public records?: DnsOperationRecord[];

    @Column()
    @Description("Where the operation is: queued, running, succeeded or failed.")
    public state: DnsOperationState = "queued";

    @Column()
    @Description("The controller's result message.")
    @Nullable
    public message?: string;

    @Column()
    @Description("The uid of the administrator who queued the operation.")
    @Nullable
    public requestedBy?: string;

    @Column()
    @Description("When the controller started the operation.")
    @Nullable
    public startedAt?: Date;

    @Column()
    @Description("When the operation finished.")
    @Nullable
    public finishedAt?: Date;

    constructor(other?: Partial<DnsOperationMongo>) {
        super(other);

        if (other) {
            this.type = other.type !== undefined ? other.type : this.type;
            this.providerUid = other.providerUid !== undefined ? other.providerUid : this.providerUid;
            this.domainUid = "domainUid" in other ? other.domainUid : this.domainUid;
            this.endpointSetId = "endpointSetId" in other ? other.endpointSetId : this.endpointSetId;
            this.records = "records" in other ? other.records : this.records;
            this.state = other.state !== undefined ? other.state : this.state;
            this.message = "message" in other ? other.message : this.message;
            this.requestedBy = "requestedBy" in other ? other.requestedBy : this.requestedBy;
            this.startedAt = "startedAt" in other ? other.startedAt : this.startedAt;
            this.finishedAt = "finishedAt" in other ? other.finishedAt : this.finishedAt;
        }
    }
}
