///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { AttachmentMongo, IngestQueueEntryMongo, MailboxMongo, MatterMongo, MessageMongo, QuarantineEntryMongo } from "../../mongo.js";
import { BaseAttachmentRoute } from "../BaseAttachmentRoute.js";
const { Model } = RouteDecorators;

@Model(AttachmentMongo)
export class AttachmentRouteMongo extends BaseAttachmentRoute<AttachmentMongo, MessageMongo> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected messageClass: any = MessageMongo;
    protected mailboxClass: any = MailboxMongo;
    protected matterClass: any = MatterMongo;
    protected quarantineEntryClass: any = QuarantineEntryMongo;
    protected ingestQueueEntryClass: any = IngestQueueEntryMongo;
}
