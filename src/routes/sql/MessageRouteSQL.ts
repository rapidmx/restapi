///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { AttachmentSQL, AuditLogEntrySQL, DomainSQL, FocusedInboxOverrideSQL, FolderSQL, KeyVaultSQL, MailboxSQL, MatterSQL, MessageSQL } from "../../sql.js";
import { BaseMessageRoute } from "../BaseMessageRoute.js";
import { ScheduledSendJobSQL } from "../../jobs/sql/ScheduledSendJobSQL.js";
import { RecoverableRepoUtils } from "../../util/RecoverableRepoUtils.js";
import { buildMessageLabelFilterSQL } from "../../util/MessageListUtils.js";
const { Model } = RouteDecorators;

@Model(MessageSQL)
export class MessageRouteSQL extends BaseMessageRoute<MessageSQL> {
    protected readonly repoUtilsClass: any = RecoverableRepoUtils;
    protected folderClass: any = FolderSQL;
    protected attachmentClass: any = AttachmentSQL;
    protected auditLogClass: any = AuditLogEntrySQL;
    protected focusedInboxOverrideClass: any = FocusedInboxOverrideSQL;
    protected mailboxClass: any = MailboxSQL;
    protected domainClass: any = DomainSQL;
    protected matterClass: any = MatterSQL;
    protected keyVaultClass: any = KeyVaultSQL;
    protected sendJobClass: any = ScheduledSendJobSQL;

    protected buildLabelUidsFilter(labelUids: string[]): Record<string, any> {
        return buildMessageLabelFilterSQL(labelUids);
    }
}
