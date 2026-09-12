///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { EscrowScopeMongo, MailboxMongo, MatterMongo } from "../../mongo.js";
import { BaseMatterSearchRoute } from "../BaseMatterSearchRoute.js";

export class MatterSearchRouteMongo extends BaseMatterSearchRoute<MatterMongo, MailboxMongo> {
    protected matterClass: any = MatterMongo;
    protected escrowScopeClass: any = EscrowScopeMongo;
    protected mailboxClass: any = MailboxMongo;
}
