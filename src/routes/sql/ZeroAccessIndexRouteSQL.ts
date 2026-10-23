///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MailboxSQL, ZeroAccessIndexEntrySQL, ZeroAccessIndexSegmentSQL } from "../../sql.js";
import { BaseZeroAccessIndexRoute } from "../BaseZeroAccessIndexRoute.js";

/** `BaseZeroAccessIndexRoute` over the SQL models. The consuming application applies `@Route`/`@ApiRoute` (the mailbox prefix). */
export class ZeroAccessIndexRouteSQL extends BaseZeroAccessIndexRoute<MailboxSQL> {
    protected mailboxClass: any = MailboxSQL;
    protected entryClass: any = ZeroAccessIndexEntrySQL;
    protected segmentClass: any = ZeroAccessIndexSegmentSQL;
}
