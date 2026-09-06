///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MailboxQuotaRecalcJob } from "../MailboxQuotaRecalcJob.js";
import { AttachmentSQL, MailboxSQL, MessageSQL } from "../../sql.js";

export class MailboxQuotaRecalcJobSQL extends MailboxQuotaRecalcJob<MailboxSQL, MessageSQL, AttachmentSQL> {
    protected mailboxClass: any = MailboxSQL;
    protected messageClass: any = MessageSQL;
    protected attachmentClass: any = AttachmentSQL;
}
