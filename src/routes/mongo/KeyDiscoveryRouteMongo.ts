///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { KeyVaultMongo, MailboxMongo } from "../../mongo.js";
import { BaseKeyDiscoveryRoute } from "../BaseKeyDiscoveryRoute.js";

export class KeyDiscoveryRouteMongo extends BaseKeyDiscoveryRoute<MailboxMongo, KeyVaultMongo> {
    protected mailboxClass: any = MailboxMongo;
    protected keyVaultClass: any = KeyVaultMongo;
}
