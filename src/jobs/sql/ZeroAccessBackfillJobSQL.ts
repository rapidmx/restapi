///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ZeroAccessBackfillJob } from "../ZeroAccessBackfillJob.js";
import { AttachmentSQL, CalendarEventSQL, ContactSQL, EncryptionPolicySQL, FolderSQL, IngestQueueEntrySQL, MailboxSQL, MessageSQL, QuarantineEntrySQL, TaskSQL, ZeroAccessIndexEntrySQL } from "../../sql.js";

export class ZeroAccessBackfillJobSQL extends ZeroAccessBackfillJob<MessageSQL, MailboxSQL, FolderSQL> {
    protected messageClass: any = MessageSQL;
    protected mailboxClass: any = MailboxSQL;
    protected folderClass: any = FolderSQL;
    protected attachmentClass: any = AttachmentSQL;
    protected quarantineEntryClass: any = QuarantineEntrySQL;
    protected ingestQueueEntryClass: any = IngestQueueEntrySQL;
    protected encryptionPolicyClass: any = EncryptionPolicySQL;
    protected zeroAccessIndexEntryClass: any = ZeroAccessIndexEntrySQL;
    protected calendarEventClass: any = CalendarEventSQL;
    protected contactClass: any = ContactSQL;
    protected taskClass: any = TaskSQL;
}
