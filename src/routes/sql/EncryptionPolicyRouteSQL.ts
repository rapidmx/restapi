///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntrySQL, EncryptionPolicySQL } from "../../sql.js";
import { BaseEncryptionPolicyRoute } from "../BaseEncryptionPolicyRoute.js";

export class EncryptionPolicyRouteSQL extends BaseEncryptionPolicyRoute<EncryptionPolicySQL> {
    protected encryptionPolicyClass: any = EncryptionPolicySQL;
    protected auditLogClass: any = AuditLogEntrySQL;
}
