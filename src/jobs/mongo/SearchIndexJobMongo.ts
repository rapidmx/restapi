///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { SearchIndexJob } from "../SearchIndexJob.js";
import { AttachmentMongo, EncryptionPolicyMongo, MailboxMongo, MessageMongo, ZeroAccessIndexEntryMongo } from "../../mongo.js";

export class SearchIndexJobMongo extends SearchIndexJob<MessageMongo, AttachmentMongo> {
    protected messageClass: any = MessageMongo;
    protected attachmentClass: any = AttachmentMongo;
    protected mailboxClass: any = MailboxMongo;
    protected encryptionPolicyClass: any = EncryptionPolicyMongo;
    protected zeroAccessIndexEntryClass: any = ZeroAccessIndexEntryMongo;
}
