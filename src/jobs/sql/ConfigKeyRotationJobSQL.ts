///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ConfigKeyRotationJob } from "../ConfigKeyRotationJob.js";
import { AuditLogEntrySQL, ConfigKeyStateSQL } from "../../sql.js";

export class ConfigKeyRotationJobSQL extends ConfigKeyRotationJob<ConfigKeyStateSQL> {
    protected configKeyStateClass: any = ConfigKeyStateSQL;
    protected auditLogClass: any = AuditLogEntrySQL;
}
