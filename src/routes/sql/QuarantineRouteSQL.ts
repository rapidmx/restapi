///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { AuditLogEntrySQL, QuarantineEntrySQL } from "../../sql.js";
import { BaseQuarantineRoute } from "../BaseQuarantineRoute.js";
const { Model } = RouteDecorators;

/**
 * `QuarantineEntry` has no `AccessControlList` of its own: it is scoped by `mailboxUid` like `ContactList`, readable by
 * the mailbox's owner and delegates and writable only by a trusted caller - see `BaseQuarantineRoute`, including how a
 * release is recorded. A trusted AND elevated caller reviews any mailbox's entries with `?scope=admin`, audited.
 */
@Model(QuarantineEntrySQL)
export class QuarantineRouteSQL extends BaseQuarantineRoute<QuarantineEntrySQL> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected auditLogClass: any = AuditLogEntrySQL;
}
