///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { DomainVerificationJob } from "../DomainVerificationJob.js";
import { AuditLogEntrySQL, DomainSQL } from "../../sql.js";

export class DomainVerificationJobSQL extends DomainVerificationJob<DomainSQL> {
    protected domainClass: any = DomainSQL;
    protected auditLogClass: any = AuditLogEntrySQL;
}
