///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ZeroAccessBackfillJob } from "../ZeroAccessBackfillJob.js";
import { AttachmentMongo, EncryptionPolicyMongo, FolderMongo, IngestQueueEntryMongo, MailboxMongo, MessageMongo, QuarantineEntryMongo, ZeroAccessIndexEntryMongo } from "../../mongo.js";

export class ZeroAccessBackfillJobMongo extends ZeroAccessBackfillJob<MessageMongo, MailboxMongo, FolderMongo> {
    protected messageClass: any = MessageMongo;
    protected mailboxClass: any = MailboxMongo;
    protected folderClass: any = FolderMongo;
    protected attachmentClass: any = AttachmentMongo;
    protected quarantineEntryClass: any = QuarantineEntryMongo;
    protected ingestQueueEntryClass: any = IngestQueueEntryMongo;
    protected encryptionPolicyClass: any = EncryptionPolicyMongo;
    protected zeroAccessIndexEntryClass: any = ZeroAccessIndexEntryMongo;
}
