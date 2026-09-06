///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { JWTUser } from "@rapidrest/core";
import { RepoUtils } from "@rapidrest/service-core";
import { Folder, FolderType } from "../models/types.js";

const DEFAULT_FOLDER_NAMES: Record<FolderType, string> = {
    [FolderType.INBOX]: "Inbox",
    [FolderType.SENT_ITEMS]: "Sent Items",
    [FolderType.DRAFTS]: "Drafts",
    [FolderType.DELETED_ITEMS]: "Deleted Items",
    [FolderType.OUTBOX]: "Outbox",
    [FolderType.JUNK]: "Junk Email",
    [FolderType.CALENDAR]: "Calendar",
    [FolderType.CONTACTS]: "Contacts",
    [FolderType.TASKS]: "Tasks",
    [FolderType.NOTES]: "Notes",
    [FolderType.USER]: "New Folder",
};

/**
 * Finds the given mailbox's well-known folder of `type` (e.g. its Inbox, Junk, Sent Items), creating it — with
 * the platform's conventional display name — if it does not already exist. Every well-known folder is
 * provisioned lazily this way rather than all at once when a `Mailbox` is created, so a mailbox that never
 * receives a piece of spam, for example, never has an empty Junk folder to show for it.
 *
 * @param folderRepo A `RepoUtils` bound to the caller's concrete `Folder` entity class (Mongo or SQL).
 * @param folderClass The concrete `Folder` entity class `folderRepo` is bound to, used to construct a new row.
 * @param mailboxUid The mailbox to find or create the folder within.
 * @param type The well-known folder type to find or create. Must not be `FolderType.USER`.
 */
export async function findOrCreateWellKnownFolder<F extends Folder>(
    folderRepo: RepoUtils<F>,
    folderClass: any,
    mailboxUid: string,
    type: Exclude<FolderType, FolderType.USER>,
    user?: JWTUser,
): Promise<F> {
    const existing: F[] = await folderRepo.find({ mailboxUid, type }, { ignoreACL: true, limit: 1 });
    if (existing.length > 0) {
        return existing[0];
    }

    const instance: F = new folderClass({
        mailboxUid,
        name: DEFAULT_FOLDER_NAMES[type],
        type,
        unreadCount: 0,
        totalCount: 0,
        syncKeyVersion: 0,
    });

    // `parentUid` must be set explicitly to the owning mailbox's ACL uid — without it, `RepoUtils.create()`'s
    // default (parenting to the `Folder` *class* ACL, which is deny-all) would leave this folder unreachable
    // by anyone, including the mailbox's own owner, once a real per-record ACL exists for `Folder` (see the
    // architecture note on `Message.mailboxUid`). Matches `BaseFolderRoute.create()`'s same seeding for
    // client-initiated folder creation.
    return await folderRepo.create(instance, {
        user,
        ignoreACL: true,
        acl: { uid: instance.uid, parentUid: mailboxUid, records: [] },
    });
}
