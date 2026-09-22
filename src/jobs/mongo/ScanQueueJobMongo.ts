///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ScanQueueJob } from "../ScanQueueJob.js";
import {
    AttachmentMongo,
    CalendarEventMongo,
    ContactMongo,
    DomainMongo,
    FocusedInboxOverrideMongo,
    FolderMongo,
    IngestQueueEntryMongo,
    KeyVaultMongo,
    MailboxMongo,
    MailFilterRuleMongo,
    MessageMongo,
    OofReplySuppressionMongo,
    QuarantineEntryMongo,
    ScanResultMongo,
} from "../../mongo.js";

export class ScanQueueJobMongo extends ScanQueueJob<
    IngestQueueEntryMongo,
    FolderMongo,
    MessageMongo,
    AttachmentMongo,
    QuarantineEntryMongo,
    ScanResultMongo,
    MailboxMongo,
    MailFilterRuleMongo,
    CalendarEventMongo,
    OofReplySuppressionMongo,
    FocusedInboxOverrideMongo,
    ContactMongo
> {
    protected ingestQueueClass: any = IngestQueueEntryMongo;
    protected folderClass: any = FolderMongo;
    protected messageClass: any = MessageMongo;
    protected attachmentClass: any = AttachmentMongo;
    protected quarantineEntryClass: any = QuarantineEntryMongo;
    protected scanResultClass: any = ScanResultMongo;
    protected mailboxClass: any = MailboxMongo;
    protected mailFilterRuleClass: any = MailFilterRuleMongo;
    protected calendarEventClass: any = CalendarEventMongo;
    protected oofReplySuppressionClass: any = OofReplySuppressionMongo;
    protected focusedInboxOverrideClass: any = FocusedInboxOverrideMongo;
    protected contactClass: any = ContactMongo;
    protected domainClass: any = DomainMongo;
    protected keyVaultClass: any = KeyVaultMongo;
}
