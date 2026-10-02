///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { escapeLike, rawLike } from "../../routes/sql/LikeUtils.js";
import { ScanQueueJob } from "../ScanQueueJob.js";
import {
    AttachmentSQL,
    CalendarEventSQL,
    ContactSQL,
    CorrespondentSQL,
    DataSubjectErasureRequestSQL,
    DomainSQL,
    FocusedInboxOverrideSQL,
    FolderSQL,
    IngestQueueEntrySQL,
    KeyVaultSQL,
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
    OofReplySuppressionSQL,
    FocusedInboxOverrideSQL,
    ContactSQL
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
    protected focusedInboxOverrideClass: any = FocusedInboxOverrideSQL;
    protected contactClass: any = ContactSQL;
    protected correspondentClass: any = CorrespondentSQL;
    protected domainClass: any = DomainSQL;
    protected keyVaultClass: any = KeyVaultSQL;
    protected dataSubjectErasureRequestClass: any = DataSubjectErasureRequestSQL;

    /** `MailboxSQL.aliasAddresses` is a serialized `simple-json` column - see `MailIngestRouteSQL.aliasQueryValue()`, whose
     * anchored, `ESCAPE`d LIKE this repeats. */
    protected aliasQueryValue(address: string): any {
        return rawLike(`%"${escapeLike(address)}"%`);
    }

    /**
     * `ContactSQL.emails` is a `simple-json` column (one serialized JSON string), so the base class's
     * `emails.address` dot-notation query - which MongoDB resolves natively against an array element - names
     * no real column here. Match the serialized substring instead, anchored on the `address` key so a value
     * that merely appears inside some other field (e.g. a contact's `notes`) can't false-positive, and
     * escaped so an address containing `%`/`_` can't turn this intended exact match into a wildcard one.
     * Identical problem/solution to `MailIngestRouteSQL.aliasQueryValue()`.
     */
    protected contactEmailQuery(address: string): any {
        return { emails: rawLike(`%"address":"${escapeLike(address)}"%`) };
    }
}
