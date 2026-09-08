///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { DomainVerificationJob } from "../DomainVerificationJob.js";
import { AuditLogEntryMongo, DomainMongo } from "../../mongo.js";

export class DomainVerificationJobMongo extends DomainVerificationJob<DomainMongo> {
    protected domainClass: any = DomainMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
