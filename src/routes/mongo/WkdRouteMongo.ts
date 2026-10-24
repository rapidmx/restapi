///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ModelUtils } from "@rapidrest/service-core";
import { DomainMongo, EncryptionPolicyMongo, KeyVaultMongo, MailboxMongo } from "../../mongo.js";
import { BaseWkdRoute } from "../BaseWkdRoute.js";

export class WkdRouteMongo extends BaseWkdRoute<MailboxMongo, KeyVaultMongo> {
    protected mailboxClass: any = MailboxMongo;
    protected keyVaultClass: any = KeyVaultMongo;
    protected domainClass: any = DomainMongo;
    protected encryptionPolicyClass: any = EncryptionPolicyMongo;

    protected aliasQueryValue(address: string): any {
        return ModelUtils.literal(address);
    }
}
