///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntryMongo, EncryptionPolicyMongo } from "../../mongo.js";
import { BaseEncryptionPolicyRoute } from "../BaseEncryptionPolicyRoute.js";

export class EncryptionPolicyRouteMongo extends BaseEncryptionPolicyRoute<EncryptionPolicyMongo> {
    protected encryptionPolicyClass: any = EncryptionPolicyMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
