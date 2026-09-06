///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { IngestQueueEntryMongo, MailboxMongo } from "../../mongo.js";
import { BaseMailIngestRoute } from "../BaseMailIngestRoute.js";

export class MailIngestRouteMongo extends BaseMailIngestRoute<MailboxMongo, IngestQueueEntryMongo> {
    protected mailboxClass: any = MailboxMongo;
    protected ingestQueueClass: any = IngestQueueEntryMongo;
}
