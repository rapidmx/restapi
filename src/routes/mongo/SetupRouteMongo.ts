///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntryMongo, DomainMongo, SetupStateMongo } from "../../mongo.js";
import { BaseSetupRoute } from "../BaseSetupRoute.js";

export class SetupRouteMongo extends BaseSetupRoute<SetupStateMongo> {
    protected setupStateClass: any = SetupStateMongo;
    protected domainClass: any = DomainMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
