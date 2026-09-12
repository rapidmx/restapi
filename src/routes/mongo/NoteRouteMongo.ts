///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { FolderMongo, NoteMongo } from "../../mongo.js";
import { getMailboxUidForFolder } from "../../util/FolderUtils.js";
import { BaseScopedChildRoute } from "../BaseScopedChildRoute.js";
const { Model } = RouteDecorators;

@Model(NoteMongo)
export class NoteRouteMongo extends BaseScopedChildRoute<NoteMongo> {
    protected readonly repoUtilsClass: any = RepoUtils;
    protected readonly scopeProperty: string = "folderUid";

    /** See `BaseScopedChildRoute.resolveMailboxUidFor()`'s own doc comment - `Note` carries its own
     * denormalized `mailboxUid` that must never diverge from its actual folder's mailbox. */
    protected async resolveMailboxUidFor(scopeUid: string): Promise<string | undefined> {
        return getMailboxUidForFolder(this._objectFactory!, FolderMongo, scopeUid);
    }
}
