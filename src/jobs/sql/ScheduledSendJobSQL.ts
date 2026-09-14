///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ScheduledSendJob } from "../ScheduledSendJob.js";
import { FolderSQL, MailboxSQL, MessageSQL } from "../../sql.js";

export class ScheduledSendJobSQL extends ScheduledSendJob<MessageSQL> {
    protected messageClass: any = MessageSQL;
    protected folderClass: any = FolderSQL;
    protected mailboxClass: any = MailboxSQL;
}
