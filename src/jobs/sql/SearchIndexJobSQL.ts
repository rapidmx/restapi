///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { SearchIndexJob } from "../SearchIndexJob.js";
import { AttachmentSQL, MessageSQL } from "../../sql.js";

export class SearchIndexJobSQL extends SearchIndexJob<MessageSQL, AttachmentSQL> {
    protected messageClass: any = MessageSQL;
    protected attachmentClass: any = AttachmentSQL;
}
