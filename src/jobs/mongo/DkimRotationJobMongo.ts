///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { DkimRotationJob } from "../DkimRotationJob.js";
import { AuditLogEntryMongo, DomainMongo } from "../../mongo.js";

export class DkimRotationJobMongo extends DkimRotationJob<DomainMongo> {
    protected domainClass: any = DomainMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
