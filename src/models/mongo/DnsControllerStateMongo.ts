///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BaseMongoEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { DnsControllerState } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity } = PersistenceDecorators;
const { Nullable } = ObjectDecorators;

/**
 * Implementation of the `DnsControllerState` interface for storage in MongoDB. If SQL is desired, please use
 * `models.sql.DnsControllerStateSQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@Description("What the DNS controller last told the server about itself: its handshake and its last status reports.")
@Protect(
    {
        uid: "DnsControllerState",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class DnsControllerStateMongo extends BaseMongoEntity implements DnsControllerState {
    @Column()
    @Description("The controller's last handshake: its versions and whether they are compatible with this server's.")
    @Nullable
    public handshake?: DnsControllerState["handshake"];

    @Column()
    @Description("The Lease holder's last status report: its version, its Lease and the desired-state version it reflects.")
    @Nullable
    public lastReport?: DnsControllerState["lastReport"];

    @Column()
    @Description("The last status report of a controller pod that didn't hold the Lease, which changed nothing.")
    @Nullable
    public lastStandbyReport?: DnsControllerState["lastStandbyReport"];

    constructor(other?: Partial<DnsControllerStateMongo>) {
        super(other);

        if (other) {
            this.handshake = "handshake" in other ? other.handshake : this.handshake;
            this.lastReport = "lastReport" in other ? other.lastReport : this.lastReport;
            this.lastStandbyReport = "lastStandbyReport" in other ? other.lastStandbyReport : this.lastStandbyReport;
        }
    }
}
