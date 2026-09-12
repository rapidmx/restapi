///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import {
    AuditLogEntryMongo,
    EscrowAccessRequestMongo,
    EscrowAuditLogEntryMongo,
    EscrowScopeMongo,
    KeyVaultMongo,
    MailboxMongo,
    MatterMongo,
} from "../../mongo.js";
import { BaseEscrowAccessRequestRoute } from "../BaseEscrowAccessRequestRoute.js";
const { Model } = RouteDecorators;

/** `@Model(EscrowAccessRequestMongo)` is what lets `BaseEscrowAccessRequestRoute`'s `@Transactional()`
 * methods resolve which datasource to open a transaction against - see the `modelClass` getter there.
 * `@Transactional()` is a documented no-op on Mongo in this repo's test topology (standalone
 * `MongoMemoryServer`, no replica set) - same disclosure `BaseBookingRoute.persistBooking()` already
 * makes. */
@Model(EscrowAccessRequestMongo)
export class EscrowAccessRequestRouteMongo extends BaseEscrowAccessRequestRoute<EscrowAccessRequestMongo, MatterMongo, MailboxMongo> {
    protected escrowAccessRequestClass: any = EscrowAccessRequestMongo;
    protected matterClass: any = MatterMongo;
    protected mailboxClass: any = MailboxMongo;
    protected keyVaultClass: any = KeyVaultMongo;
    protected escrowScopeClass: any = EscrowScopeMongo;
    protected escrowAuditLogClass: any = EscrowAuditLogEntryMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
