///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { DkimRotationJob } from "../DkimRotationJob.js";
import { AuditLogEntrySQL, DomainSQL } from "../../sql.js";

export class DkimRotationJobSQL extends DkimRotationJob<DomainSQL> {
    protected domainClass: any = DomainSQL;
    protected auditLogClass: any = AuditLogEntrySQL;
}
