///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { AuditLogEntryMongo, DomainMongo, FocusedInboxOverrideMongo, FolderMongo, KeyVaultMongo, MailboxMongo, MatterMongo, MessageMongo } from "../../mongo.js";
import { BaseMessageRoute } from "../BaseMessageRoute.js";
import { RecoverableRepoUtils } from "../../util/RecoverableRepoUtils.js";
import { buildMessageLabelFilterMongo } from "../../util/MessageListUtils.js";
const { Model } = RouteDecorators;

@Model(MessageMongo)
export class MessageRouteMongo extends BaseMessageRoute<MessageMongo> {
    protected readonly repoUtilsClass: any = RecoverableRepoUtils;
    protected folderClass: any = FolderMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
    protected focusedInboxOverrideClass: any = FocusedInboxOverrideMongo;
    protected mailboxClass: any = MailboxMongo;
    protected domainClass: any = DomainMongo;
    protected matterClass: any = MatterMongo;
    protected keyVaultClass: any = KeyVaultMongo;

    protected buildLabelUidsFilter(labelUids: string[]): Record<string, any> {
        return buildMessageLabelFilterMongo(labelUids);
    }
}
