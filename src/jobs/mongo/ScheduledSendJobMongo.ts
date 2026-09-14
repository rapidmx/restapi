///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ScheduledSendJob } from "../ScheduledSendJob.js";
import { FolderMongo, MailboxMongo, MessageMongo } from "../../mongo.js";

export class ScheduledSendJobMongo extends ScheduledSendJob<MessageMongo> {
    protected messageClass: any = MessageMongo;
    protected folderClass: any = FolderMongo;
    protected mailboxClass: any = MailboxMongo;
}
