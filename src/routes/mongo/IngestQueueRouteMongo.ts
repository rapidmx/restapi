///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { AuditLogEntryMongo, IngestQueueEntryMongo } from "../../mongo.js";
import { BaseScopedChildRoute } from "../BaseScopedChildRoute.js";
const { Model } = RouteDecorators;

/**
 * `IngestQueueEntry` has no `AccessControlList` of its own — like every other `mailboxUid`-scoped entity (see
 * `ContactListRouteMongo`), `BaseScopedChildRoute` already provides exactly the CRUD/permission behavior
 * needed: a mailbox owner or delegate sees their own mailbox's pending/failed ingest entries. A trusted caller (ops
 * diagnosing stuck delivery) has no implicit access to anybody's mailbox - like everything mailbox-scoped - but may
 * review any mailbox's entries with `?scope=admin` (trusted + elevated; `adminScope`), each call audited. Writes are
 * trusted-only (`trustedOnlyWrites`).
 */
@Model(IngestQueueEntryMongo)
export class IngestQueueRouteMongo extends BaseScopedChildRoute<IngestQueueEntryMongo> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected readonly scopeProperty: string = "mailboxUid";
    /** Entries are produced by ingest; only a trusted caller (ops) may change them. */
    protected readonly trustedOnlyWrites: boolean = true;
    /** Ops review any mailbox's entries with `?scope=admin` (trusted + elevated, audited) - nothing else widens access. */
    protected readonly adminScope: boolean = true;
    protected auditLogClass: any = AuditLogEntryMongo;
    /** Range-queried by `ScanQueueJob` - stored as real `Date`s (see `BaseScopedChildRoute.dateFields`). */
    protected readonly dateFields: readonly string[] = ["nextAttemptAt", "scanLeaseExpiresAt"];
}
