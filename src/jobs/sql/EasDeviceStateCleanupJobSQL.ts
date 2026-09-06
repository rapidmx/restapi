///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { EasDeviceStateCleanupJob } from "../EasDeviceStateCleanupJob.js";
import { DeviceSyncStateSQL } from "../../sql.js";

export class EasDeviceStateCleanupJobSQL extends EasDeviceStateCleanupJob<DeviceSyncStateSQL> {
    protected deviceSyncStateClass: any = DeviceSyncStateSQL;
}
