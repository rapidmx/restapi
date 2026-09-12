///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { AuditLogEntrySQL, EscrowScopeSQL, KeyVaultSQL, MailboxSQL } from "../../sql.js";
import { BaseKeyVaultRoute } from "../BaseKeyVaultRoute.js";
const { Model } = RouteDecorators;

/** `@Model(KeyVaultSQL)` is what lets `BaseKeyVaultRoute`'s `@Transactional()` methods resolve which
 * datasource to open a transaction against - see the `modelClass` getter there. */
@Model(KeyVaultSQL)
export class KeyVaultRouteSQL extends BaseKeyVaultRoute<KeyVaultSQL, MailboxSQL> {
    protected keyVaultClass: any = KeyVaultSQL;
    protected mailboxClass: any = MailboxSQL;
    protected auditLogClass: any = AuditLogEntrySQL;
    protected escrowScopeClass: any = EscrowScopeSQL;
}
