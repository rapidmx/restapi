///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntryMongo, BrandingMongo } from "../../mongo.js";
import { BaseBrandingRoute } from "../BaseBrandingRoute.js";

export class BrandingRouteMongo extends BaseBrandingRoute<BrandingMongo> {
    protected brandingClass: any = BrandingMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
