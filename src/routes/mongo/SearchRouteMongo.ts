///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MailboxMongo } from "../../mongo.js";
import { BaseSearchRoute } from "../BaseSearchRoute.js";

export class SearchRouteMongo extends BaseSearchRoute<MailboxMongo> {
    protected mailboxClass: any = MailboxMongo;
}
