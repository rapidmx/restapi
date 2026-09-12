///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AcmeEnrollmentDriverJob } from "../AcmeEnrollmentDriverJob.js";
import { AuditLogEntryMongo, KeyVaultMongo, MailboxMongo } from "../../mongo.js";

export class AcmeEnrollmentDriverJobMongo extends AcmeEnrollmentDriverJob<MailboxMongo, KeyVaultMongo> {
    protected mailboxClass: any = MailboxMongo;
    protected keyVaultClass: any = KeyVaultMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
