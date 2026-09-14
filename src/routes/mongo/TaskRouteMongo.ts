///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { FolderMongo, TaskMongo } from "../../mongo.js";
import { getMailboxUidForFolder } from "../../util/FolderUtils.js";
import { BaseScopedChildRoute } from "../BaseScopedChildRoute.js";
import { RecoverableRepoUtils } from "../../util/RecoverableRepoUtils.js";
const { Model } = RouteDecorators;

@Model(TaskMongo)
export class TaskRouteMongo extends BaseScopedChildRoute<TaskMongo> {
    protected readonly repoUtilsClass: any = RecoverableRepoUtils;
    protected readonly scopeProperty: string = "folderUid";
    /** Stored as real `Date`s so due/reminder range queries match on Mongo (see `BaseScopedChildRoute.dateFields`). */
    protected readonly dateFields: readonly string[] = ["dueDate", "reminderDate"];

    /** See `BaseScopedChildRoute.resolveMailboxUidFor()`'s own doc comment - `Task` carries its own
     * denormalized `mailboxUid` that must never diverge from its actual folder's mailbox. */
    protected async resolveMailboxUidFor(scopeUid: string): Promise<string | undefined> {
        return getMailboxUidForFolder(this._objectFactory!, FolderMongo, scopeUid);
    }
}
