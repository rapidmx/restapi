///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { QuarantineRetentionJob } from "../QuarantineRetentionJob.js";
import { AttachmentSQL, IngestQueueEntrySQL, MatterSQL, MessageSQL, QuarantineEntrySQL, ScanResultSQL } from "../../sql.js";

export class QuarantineRetentionJobSQL extends QuarantineRetentionJob<QuarantineEntrySQL> {
    protected quarantineEntryClass: any = QuarantineEntrySQL;
    protected scanResultClass: any = ScanResultSQL;
    protected messageClass: any = MessageSQL;
    protected attachmentClass: any = AttachmentSQL;
    protected ingestQueueEntryClass: any = IngestQueueEntrySQL;
    protected matterClass: any = MatterSQL;
}
