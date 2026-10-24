///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { DomainSQL, EncryptionPolicySQL, KeyVaultSQL, MailboxSQL } from "../../sql.js";
import { BaseWkdRoute } from "../BaseWkdRoute.js";
import { escapeLike, rawLike } from "./LikeUtils.js";

export class WkdRouteSQL extends BaseWkdRoute<MailboxSQL, KeyVaultSQL> {
    protected mailboxClass: any = MailboxSQL;
    protected keyVaultClass: any = KeyVaultSQL;
    protected domainClass: any = DomainSQL;
    protected encryptionPolicyClass: any = EncryptionPolicySQL;

    /** `MailboxSQL.aliasAddresses` is a serialized `simple-json` column - see `KeyLookupRouteSQL.aliasQueryValue()`. */
    protected aliasQueryValue(address: string): any {
        return rawLike(`%"${escapeLike(address)}"%`);
    }
}
