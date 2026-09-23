///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { DomainSQL, KeyVaultSQL, MailboxSQL } from "../../sql.js";
import { BaseKeyDiscoveryRoute } from "../BaseKeyDiscoveryRoute.js";

export class KeyDiscoveryRouteSQL extends BaseKeyDiscoveryRoute<MailboxSQL, KeyVaultSQL> {
    protected mailboxClass: any = MailboxSQL;
    protected keyVaultClass: any = KeyVaultSQL;
    protected domainClass: any = DomainSQL;
}
