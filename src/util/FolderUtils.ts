///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { JWTUser, ObjectFactory } from "@rapidrest/core";
import { type AccessControlList, type ACLUtils, RepoUtils } from "@rapidrest/service-core";
import { Folder, FolderType } from "../models/types.js";
import { nameBasedUuid } from "./UuidUtils.js";

/** Caches one `RepoUtils` per concrete `Folder` class (Mongo vs SQL) - mirrors `EscrowUtils.ts`'s
 * identical `getEscrowScopeRepo()` pattern. */
const folderRepoCache = new WeakMap<any, Promise<RepoUtils<Folder>>>();

function getCachedFolderRepo(objectFactory: ObjectFactory, folderClass: any): Promise<RepoUtils<Folder>> {
    let cached = folderRepoCache.get(folderClass);
    if (!cached) {
        cached = Promise.resolve(objectFactory.newInstance(RepoUtils, { name: folderClass.name, args: [folderClass] }));
        folderRepoCache.set(folderClass, cached);
    }
    return cached;
}

/**
 * The real, authoritative `mailboxUid` of `folderUid` (`undefined` if no such folder exists) - looked up
 * with `ignoreACL: true` and no soft-delete filtering (a plain `RepoUtils`, not `RecoverableRepoUtils`),
 * so a folder that was soft-deleted mid-request still resolves correctly rather than appearing not found.
 *
 * This is the one place `BaseScopedChildRoute.resolveMailboxUidFor()`'s overrides
 * (`BaseMessageRoute`/`BaseAttachmentRoute`/`BaseContactRoute`/`BaseCalendarEventRoute`/`TaskRoute*`/
 * `NoteRoute*`) resolve a folder-scoped record's `mailboxUid` through, rather than trusting whatever value
 * a client supplied directly - see that hook's own doc comment for why an independently client-writable
 * `mailboxUid` is a real problem (every compliance job that purges/queries by `mailboxUid` treats it as
 * authoritative).
 */
export async function getMailboxUidForFolder(objectFactory: ObjectFactory, folderClass: any, folderUid: string): Promise<string | undefined> {
    const repo: RepoUtils<Folder> = await getCachedFolderRepo(objectFactory, folderClass);
    const folder: Folder | undefined = await repo.findOne(folderUid, { ignoreACL: true });
    return folder?.mailboxUid;
}

const DEFAULT_FOLDER_NAMES: Record<FolderType, string> = {
    [FolderType.INBOX]: "Inbox",
    [FolderType.SENT_ITEMS]: "Sent Items",
    [FolderType.DRAFTS]: "Drafts",
    [FolderType.DELETED_ITEMS]: "Deleted Items",
    [FolderType.OUTBOX]: "Outbox",
    [FolderType.JUNK]: "Junk Email",
    [FolderType.ARCHIVE]: "Archive",
    [FolderType.CALENDAR]: "Calendar",
    [FolderType.CONTACTS]: "Contacts",
    [FolderType.TASKS]: "Tasks",
    [FolderType.NOTES]: "Notes",
    [FolderType.USER]: "New Folder",
};

/**
 * The deterministic uid a newly created well-known folder of `type` in `mailboxUid` gets (`nameBasedUuid()` of
 * `<mailboxUid>:<type>`). Two replicas racing to create the same mailbox's Inbox therefore insert the same uid,
 * and the uid's unique index (on both backends) lets exactly one of them win.
 */
export function wellKnownFolderUid(mailboxUid: string, type: FolderType): string {
    return nameBasedUuid(`folder:${mailboxUid}:${type}`);
}

/**
 * Finds the given mailbox's well-known folder of `type` (e.g. its Inbox, Junk, Sent Items), creating it — with
 * the platform's conventional display name — if it does not already exist. Every well-known folder is
 * provisioned lazily this way rather than all at once when a `Mailbox` is created, so a mailbox that never
 * receives a piece of spam, for example, never has an empty Junk folder to show for it.
 *
 * Safe against concurrent callers (e.g. two replicas delivering a new mailbox's first messages at the same
 * time): a new folder is created under `wellKnownFolderUid()`, so the losing `create()` fails on the uid's unique
 * index and re-reads the winner's folder instead of adding a second Inbox. A unique `(mailboxUid, type)` index
 * isn't an option because user folders all share `FolderType.USER`. When duplicates already exist (created
 * before this change), the oldest one is always returned, so every caller agrees on the same folder. If the
 * deterministic uid is held by a soft-deleted folder, a random uid is used instead.
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
    const findExisting = async (): Promise<F | undefined> =>
        (
            await folderRepo.find({ mailboxUid, type, sort: { dateCreated: "ASC", uid: "ASC" }, limit: 1 } as any, {
                ignoreACL: true,
                limit: 1,
                skipCache: true,
            })
        )[0];

    const existing: F | undefined = await findExisting();
    if (existing) {
        return existing;
    }

    const deterministicUid: string = wellKnownFolderUid(mailboxUid, type);
    try {
        return await createWellKnownFolder(folderRepo, folderClass, mailboxUid, type, deterministicUid, user);
    } catch (err) {
        const winner: F | undefined = await findExisting();
        if (winner) {
            return winner;
        }
        // No visible folder holds the uid, so this wasn't a lost race - unless a soft-deleted folder already has
        // the deterministic uid, in which case a random uid is used rather than failing delivery.
        if (!(await folderRepo.findOne(deterministicUid, { ignoreACL: true, includeDeleted: true }))) {
            throw err;
        }
        return await createWellKnownFolder(folderRepo, folderClass, mailboxUid, type, undefined, user);
    }
}

async function createWellKnownFolder<F extends Folder>(
    folderRepo: RepoUtils<F>,
    folderClass: any,
    mailboxUid: string,
    type: Exclude<FolderType, FolderType.USER>,
    uid: string | undefined,
    user?: JWTUser,
): Promise<F> {
    const instance: F = new folderClass({
        ...(uid ? { uid } : {}),
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
    const acl = { uid: instance.uid, parentUid: mailboxUid, records: [] };
    if (!uid) {
        // A random uid: no existing ACL can legitimately be there, so service-core's default refusal applies.
        return await folderRepo.create(instance, { user, ignoreACL: true, acl });
    }

    // The deterministic uid is derived server-side from the mailbox uid and type and never taken from a client, and
    // only trusted callers can write an ACL at an arbitrary uid (`BaseACLRoute`), so an ACL already at this uid was
    // left behind by an earlier incarnation of this same folder (its row removed without its ACL). service-core
    // 2.1.0 refuses to reuse it unless told to (`allowExistingACL`). Reusing it keeps a lost race on the uid failing
    // on the unique index (the caller re-reads the winner) rather than at the ACL claim, before the winner's row is
    // visible. The leftover ACL may carry stale grants or a different parent, so it is reset to the fresh shape once
    // this create has won the uid.
    const aclUtils: ACLUtils | undefined = (folderRepo as any).aclUtils;
    const leftover: AccessControlList | undefined = await aclUtils?.findACL(uid, [], { skipCache: true, skipParents: true });
    const created: F = await folderRepo.create(instance, { user, ignoreACL: true, acl, allowExistingACL: true });
    if (leftover) {
        const current: AccessControlList | undefined = await aclUtils!.findACL(uid, [], { skipCache: true, skipParents: true });
        if (current) {
            current.parentUid = mailboxUid;
            current.records = [];
            await aclUtils!.saveACL(current);
        }
    }
    return created;
}
