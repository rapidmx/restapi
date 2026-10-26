///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { SearchIndexJob } from "../SearchIndexJob.js";
import { AttachmentSQL, EncryptionPolicySQL, MailboxSQL, MessageSQL, ZeroAccessIndexEntrySQL } from "../../sql.js";

export class SearchIndexJobSQL extends SearchIndexJob<MessageSQL, AttachmentSQL> {
    protected messageClass: any = MessageSQL;
    protected attachmentClass: any = AttachmentSQL;
    protected mailboxClass: any = MailboxSQL;
    protected encryptionPolicyClass: any = EncryptionPolicySQL;
    protected zeroAccessIndexEntryClass: any = ZeroAccessIndexEntrySQL;
}
