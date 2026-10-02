///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { AttachmentSQL, IngestQueueEntrySQL, MailboxSQL, MatterSQL, MessageSQL, QuarantineEntrySQL } from "../../sql.js";
import { BaseAttachmentRoute } from "../BaseAttachmentRoute.js";
const { Model } = RouteDecorators;

@Model(AttachmentSQL)
export class AttachmentRouteSQL extends BaseAttachmentRoute<AttachmentSQL, MessageSQL> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected messageClass: any = MessageSQL;
    protected mailboxClass: any = MailboxSQL;
    protected matterClass: any = MatterSQL;
    protected quarantineEntryClass: any = QuarantineEntrySQL;
    protected ingestQueueEntryClass: any = IngestQueueEntrySQL;
}
