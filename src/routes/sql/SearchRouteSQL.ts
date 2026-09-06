///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MailboxSQL } from "../../sql.js";
import { BaseSearchRoute } from "../BaseSearchRoute.js";

export class SearchRouteSQL extends BaseSearchRoute<MailboxSQL> {
    protected mailboxClass: any = MailboxSQL;
}
