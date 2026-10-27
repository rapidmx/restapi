///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ConfigKeyRotationJob } from "../ConfigKeyRotationJob.js";
import { AuditLogEntryMongo, ConfigKeyStateMongo } from "../../mongo.js";

export class ConfigKeyRotationJobMongo extends ConfigKeyRotationJob<ConfigKeyStateMongo> {
    protected configKeyStateClass: any = ConfigKeyStateMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
