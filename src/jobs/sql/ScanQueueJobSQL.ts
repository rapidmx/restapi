///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ScanQueueJob } from "../ScanQueueJob.js";
import {
    AttachmentSQL,
    FolderSQL,
    IngestQueueEntrySQL,
    MessageSQL,
    QuarantineEntrySQL,
    ScanResultSQL,
} from "../../sql.js";

export class ScanQueueJobSQL extends ScanQueueJob<
    IngestQueueEntrySQL,
    FolderSQL,
    MessageSQL,
    AttachmentSQL,
    QuarantineEntrySQL,
    ScanResultSQL
> {
    protected ingestQueueClass: any = IngestQueueEntrySQL;
    protected folderClass: any = FolderSQL;
    protected messageClass: any = MessageSQL;
    protected attachmentClass: any = AttachmentSQL;
    protected quarantineEntryClass: any = QuarantineEntrySQL;
    protected scanResultClass: any = ScanResultSQL;
}
