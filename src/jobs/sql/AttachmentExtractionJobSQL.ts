///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AttachmentExtractionJob } from "../AttachmentExtractionJob.js";
import { AttachmentSQL, MessageSQL } from "../../sql.js";

export class AttachmentExtractionJobSQL extends AttachmentExtractionJob<AttachmentSQL, MessageSQL> {
    protected attachmentClass: any = AttachmentSQL;
    protected messageClass: any = MessageSQL;
}
