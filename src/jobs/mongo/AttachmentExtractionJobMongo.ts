///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AttachmentExtractionJob } from "../AttachmentExtractionJob.js";
import { AttachmentMongo, MessageMongo } from "../../mongo.js";

export class AttachmentExtractionJobMongo extends AttachmentExtractionJob<AttachmentMongo, MessageMongo> {
    protected attachmentClass: any = AttachmentMongo;
    protected messageClass: any = MessageMongo;
}
