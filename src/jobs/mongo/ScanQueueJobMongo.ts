///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ScanQueueJob } from "../ScanQueueJob.js";
import {
    AttachmentMongo,
    FolderMongo,
    IngestQueueEntryMongo,
    MessageMongo,
    QuarantineEntryMongo,
    ScanResultMongo,
} from "../../mongo.js";

export class ScanQueueJobMongo extends ScanQueueJob<
    IngestQueueEntryMongo,
    FolderMongo,
    MessageMongo,
    AttachmentMongo,
    QuarantineEntryMongo,
    ScanResultMongo
> {
    protected ingestQueueClass: any = IngestQueueEntryMongo;
    protected folderClass: any = FolderMongo;
    protected messageClass: any = MessageMongo;
    protected attachmentClass: any = AttachmentMongo;
    protected quarantineEntryClass: any = QuarantineEntryMongo;
    protected scanResultClass: any = ScanResultMongo;
}
