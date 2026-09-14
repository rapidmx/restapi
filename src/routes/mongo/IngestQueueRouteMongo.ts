///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { IngestQueueEntryMongo } from "../../mongo.js";
import { BaseScopedChildRoute } from "../BaseScopedChildRoute.js";
const { Model } = RouteDecorators;

/**
 * `IngestQueueEntry` has no `AccessControlList` of its own — like every other `mailboxUid`-scoped entity (see
 * `ContactListRouteMongo`), `BaseScopedChildRoute` already provides exactly the CRUD/permission behavior
 * needed: a mailbox owner or delegate sees their own mailbox's pending/failed ingest entries, a trusted caller
 * (ops diagnosing stuck delivery) sees everything via the same ACL bypass every other route in this library
 * already gets for free. Writes are trusted-only (`trustedOnlyWrites`).
 */
@Model(IngestQueueEntryMongo)
export class IngestQueueRouteMongo extends BaseScopedChildRoute<IngestQueueEntryMongo> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected readonly scopeProperty: string = "mailboxUid";
    /** Entries are produced by ingest; only a trusted caller (ops) may change them. */
    protected readonly trustedOnlyWrites: boolean = true;
    /** Range-queried by `ScanQueueJob` - stored as real `Date`s (see `BaseScopedChildRoute.dateFields`). */
    protected readonly dateFields: readonly string[] = ["nextAttemptAt", "scanLeaseExpiresAt"];
}
