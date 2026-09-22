///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { AuditLogEntrySQL, IngestQueueEntrySQL } from "../../sql.js";
import { BaseScopedChildRoute } from "../BaseScopedChildRoute.js";
const { Model } = RouteDecorators;

/**
 * See `IngestQueueRouteMongo` for the rationale — identical behavior against the SQL backend.
 */
@Model(IngestQueueEntrySQL)
export class IngestQueueRouteSQL extends BaseScopedChildRoute<IngestQueueEntrySQL> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected readonly scopeProperty: string = "mailboxUid";
    /** Entries are produced by ingest; only a trusted caller (ops) may change them. */
    protected readonly trustedOnlyWrites: boolean = true;
    /** Ops review any mailbox's entries with `?scope=admin` (trusted + elevated, audited) - nothing else widens access. */
    protected readonly adminScope: boolean = true;
    protected auditLogClass: any = AuditLogEntrySQL;
    protected readonly dateFields: readonly string[] = ["nextAttemptAt", "scanLeaseExpiresAt"];
}
