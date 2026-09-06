///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { EasDeviceStateCleanupJob } from "../EasDeviceStateCleanupJob.js";
import { DeviceSyncStateMongo } from "../../mongo.js";

export class EasDeviceStateCleanupJobMongo extends EasDeviceStateCleanupJob<DeviceSyncStateMongo> {
    protected deviceSyncStateClass: any = DeviceSyncStateMongo;
}
