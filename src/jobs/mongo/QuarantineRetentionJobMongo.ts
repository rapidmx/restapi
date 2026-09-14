///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { QuarantineRetentionJob } from "../QuarantineRetentionJob.js";
import { AttachmentMongo, IngestQueueEntryMongo, MatterMongo, MessageMongo, QuarantineEntryMongo, ScanResultMongo } from "../../mongo.js";

export class QuarantineRetentionJobMongo extends QuarantineRetentionJob<QuarantineEntryMongo> {
    protected quarantineEntryClass: any = QuarantineEntryMongo;
    protected scanResultClass: any = ScanResultMongo;
    protected messageClass: any = MessageMongo;
    protected attachmentClass: any = AttachmentMongo;
    protected ingestQueueEntryClass: any = IngestQueueEntryMongo;
    protected matterClass: any = MatterMongo;
}
