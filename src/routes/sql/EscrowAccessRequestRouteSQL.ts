///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import {
    AuditLogEntrySQL,
    EscrowAccessRequestSQL,
    EscrowAuditLogEntrySQL,
    EscrowScopeSQL,
    KeyVaultSQL,
    MailboxSQL,
    MatterSQL,
} from "../../sql.js";
import { BaseEscrowAccessRequestRoute } from "../BaseEscrowAccessRequestRoute.js";
const { Model } = RouteDecorators;

/** `@Model(EscrowAccessRequestSQL)` is what lets `BaseEscrowAccessRequestRoute`'s `@Transactional()`
 * methods resolve which datasource to open a transaction against - see the `modelClass` getter there. */
@Model(EscrowAccessRequestSQL)
export class EscrowAccessRequestRouteSQL extends BaseEscrowAccessRequestRoute<EscrowAccessRequestSQL, MatterSQL, MailboxSQL> {
    protected escrowAccessRequestClass: any = EscrowAccessRequestSQL;
    protected matterClass: any = MatterSQL;
    protected mailboxClass: any = MailboxSQL;
    protected keyVaultClass: any = KeyVaultSQL;
    protected escrowScopeClass: any = EscrowScopeSQL;
    protected escrowAuditLogClass: any = EscrowAuditLogEntrySQL;
    protected auditLogClass: any = AuditLogEntrySQL;
}
