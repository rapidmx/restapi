///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ACLAction, BaseEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { ObjectDecorators } from "@rapidrest/core";
import { DeviceSyncState } from "../types.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Nullable } = ObjectDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `DeviceSyncState` interface for storage in a SQL database. If MongoDB is desired,
 * please use `models.mongo.DeviceSyncStateMongo` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("sql")
@Entity()
@Description("Tracks the EAS sync state of a single paired mobile device against a `Mailbox`.")
@Index("devicesyncstate_mailbox_device", ["mailboxUid", "deviceId"], { unique: true })
@Protect(
    {
        uid: "DeviceSyncState",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class DeviceSyncStateSQL extends BaseEntity implements DeviceSyncState {
    @Column()
    @Description("The unique identifier of the `Mailbox` this device is synced against.")
    public mailboxUid: string = "";

    @Column()
    @Description("The unique identifier of the paired device.")
    public deviceId: string = "";

    @Column()
    @Description("The device type/model string reported by the device.")
    public deviceType: string = "";

    @Column({ nullable: true })
    @Description("The EAS provisioning policy key most recently acknowledged by the device.")
    @Nullable
    public policyKey?: string;

    @Column({ type: "simple-json" })
    @Description("The per-folder EAS `SyncKey` cursor, keyed by `Folder.uid`.")
    public folderSyncKeys: Record<string, string> = {};

    @Column({ nullable: true })
    @Description("The date and time of the device's last successful sync.")
    @Nullable
    public lastSyncAt?: Date;

    @Column()
    @Description("`true` if the device has completed EAS provisioning.")
    public provisioned: boolean = false;

    constructor(other?: Partial<DeviceSyncStateSQL>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.deviceId = other.deviceId !== undefined ? other.deviceId : this.deviceId;
            this.deviceType = other.deviceType !== undefined ? other.deviceType : this.deviceType;
            this.policyKey = "policyKey" in other ? other.policyKey : this.policyKey;
            this.folderSyncKeys = other.folderSyncKeys !== undefined ? other.folderSyncKeys : this.folderSyncKeys;
            this.lastSyncAt = "lastSyncAt" in other ? other.lastSyncAt : this.lastSyncAt;
            this.provisioned = other.provisioned !== undefined ? other.provisioned : this.provisioned;
        }
    }
}
