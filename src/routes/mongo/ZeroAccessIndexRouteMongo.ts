///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MailboxMongo, ZeroAccessIndexEntryMongo, ZeroAccessIndexSegmentMongo } from "../../mongo.js";
import { BaseZeroAccessIndexRoute } from "../BaseZeroAccessIndexRoute.js";

/** `BaseZeroAccessIndexRoute` over the Mongo models. The consuming application applies `@Route`/`@ApiRoute` (the mailbox prefix). */
export class ZeroAccessIndexRouteMongo extends BaseZeroAccessIndexRoute<MailboxMongo> {
    protected mailboxClass: any = MailboxMongo;
    protected entryClass: any = ZeroAccessIndexEntryMongo;
    protected segmentClass: any = ZeroAccessIndexSegmentMongo;
}
