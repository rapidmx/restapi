///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AcmeEnrollmentDriverJob } from "../AcmeEnrollmentDriverJob.js";
import { AuditLogEntrySQL, KeyVaultSQL, MailboxSQL } from "../../sql.js";

export class AcmeEnrollmentDriverJobSQL extends AcmeEnrollmentDriverJob<MailboxSQL, KeyVaultSQL> {
    protected mailboxClass: any = MailboxSQL;
    protected keyVaultClass: any = KeyVaultSQL;
    protected auditLogClass: any = AuditLogEntrySQL;
}
