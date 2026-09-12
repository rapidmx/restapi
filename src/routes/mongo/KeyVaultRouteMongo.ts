///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { AuditLogEntryMongo, EscrowScopeMongo, KeyVaultMongo, MailboxMongo } from "../../mongo.js";
import { BaseKeyVaultRoute } from "../BaseKeyVaultRoute.js";
const { Model } = RouteDecorators;

/** `@Model(KeyVaultMongo)` is what lets `BaseKeyVaultRoute`'s `@Transactional()` methods resolve which
 * datasource to open a transaction against - see the `modelClass` getter there. */
@Model(KeyVaultMongo)
export class KeyVaultRouteMongo extends BaseKeyVaultRoute<KeyVaultMongo, MailboxMongo> {
    protected keyVaultClass: any = KeyVaultMongo;
    protected mailboxClass: any = MailboxMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
    protected escrowScopeClass: any = EscrowScopeMongo;
}
