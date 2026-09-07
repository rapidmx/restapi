///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ScanQueueJob } from "../ScanQueueJob.js";
import {
    AttachmentSQL,
    CalendarEventSQL,
    FolderSQL,
    IngestQueueEntrySQL,
    MailboxSQL,
    MailFilterRuleSQL,
    MessageSQL,
    OofReplySuppressionSQL,
    QuarantineEntrySQL,
    ScanResultSQL,
} from "../../sql.js";

export class ScanQueueJobSQL extends ScanQueueJob<
    IngestQueueEntrySQL,
    FolderSQL,
    MessageSQL,
    AttachmentSQL,
    QuarantineEntrySQL,
    ScanResultSQL,
    MailboxSQL,
    MailFilterRuleSQL,
    CalendarEventSQL,
    OofReplySuppressionSQL
> {
    protected ingestQueueClass: any = IngestQueueEntrySQL;
    protected folderClass: any = FolderSQL;
    protected messageClass: any = MessageSQL;
    protected attachmentClass: any = AttachmentSQL;
    protected quarantineEntryClass: any = QuarantineEntrySQL;
    protected scanResultClass: any = ScanResultSQL;
    protected mailboxClass: any = MailboxSQL;
    protected mailFilterRuleClass: any = MailFilterRuleSQL;
    protected calendarEventClass: any = CalendarEventSQL;
    protected oofReplySuppressionClass: any = OofReplySuppressionSQL;
}
