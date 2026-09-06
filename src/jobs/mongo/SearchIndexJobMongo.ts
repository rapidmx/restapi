///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { SearchIndexJob } from "../SearchIndexJob.js";
import { AttachmentMongo, MessageMongo } from "../../mongo.js";

export class SearchIndexJobMongo extends SearchIndexJob<MessageMongo, AttachmentMongo> {
    protected messageClass: any = MessageMongo;
    protected attachmentClass: any = AttachmentMongo;
}
