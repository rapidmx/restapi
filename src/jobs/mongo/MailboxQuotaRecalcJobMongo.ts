///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MailboxQuotaRecalcJob } from "../MailboxQuotaRecalcJob.js";
import { AttachmentMongo, MailboxMongo, MessageMongo } from "../../mongo.js";

export class MailboxQuotaRecalcJobMongo extends MailboxQuotaRecalcJob<MailboxMongo, MessageMongo, AttachmentMongo> {
    protected mailboxClass: any = MailboxMongo;
    protected messageClass: any = MessageMongo;
    protected attachmentClass: any = AttachmentMongo;
}
