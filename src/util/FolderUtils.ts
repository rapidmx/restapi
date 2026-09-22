///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { JWTUser, ObjectFactory } from "@rapidrest/core";
import { type AccessControlList, type ACLRecord, type ACLUtils, ModelUtils, RepoUtils } from "@rapidrest/service-core";
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

/** A folder type every mailbox has exactly one of (every `FolderType` but `USER`). */
export type WellKnownFolderType = Exclude<FolderType, FolderType.USER>;

/**
 * Every well-known folder a mailbox has, in the order `ensureWellKnownFolders()` creates them (so a listing ordered by
 * `dateCreated` reads Inbox first): the mail set - Inbox, Drafts, Outbox, Sent Items, Deleted Items, Junk Email, Archive -
 * and the calendar, contacts, tasks and notes folders.
 */
export const WELL_KNOWN_FOLDER_TYPES: readonly WellKnownFolderType[] = [
    FolderType.INBOX,
    FolderType.DRAFTS,
    FolderType.OUTBOX,
    FolderType.SENT_ITEMS,
    FolderType.DELETED_ITEMS,
    FolderType.JUNK,
    FolderType.ARCHIVE,
    FolderType.CALENDAR,
    FolderType.CONTACTS,
    FolderType.TASKS,
    FolderType.NOTES,
];

/** How many rows the existence query of `ensureWellKnownFolders()` may read: far more than the well-known types could
 * ever legitimately hold, but still bounded should a mailbox be full of duplicates. */
const WELL_KNOWN_QUERY_LIMIT: number = 200;

/**
 * Makes sure `mailboxUid` has every well-known folder (`WELL_KNOWN_FOLDER_TYPES`), creating the missing ones - the one
 * step that gives a new mailbox all its folders at creation (`BaseMailboxRoute.create()`) and gives an older mailbox,
 * one created when only some were provisioned (or by another path), the rest the next time its folders are read
 * (`BaseFolderRoute.find()`/`findById()`). Idempotent and race-safe: ONE existence query (`type` in the well-known
 * set, uncached) decides whether anything is missing and a complete mailbox costs nothing more and writes nothing;
 * each missing folder is created through `findOrCreateWellKnownFolder()` (a deterministic uid, so concurrent callers
 * settle on one folder each and only the winner's create is published - see below).
 *
 * **Access is the caller's to check first**: this creates folders in whichever mailbox it is given, so a request handler
 * asks `hasMailAccess()` for that mailbox before calling it. `user` is only the creator recorded on a new folder's ACL
 * (`BaseMailboxRoute.create()` passes its caller); a handler healing on read leaves it unset so a delegate's read never
 * grants them a record on a folder.
 *
 * Each created folder is published like any other creation (see `findOrCreateWellKnownFolder()`), one event per folder.
 *
 * @returns The folders that were missing and are now present (created here, or by a concurrent caller that won).
 */
export async function ensureWellKnownFolders<F extends Folder>(
    folderRepo: RepoUtils<F>,
    folderClass: any,
    mailboxUid: string,
    user?: JWTUser,
): Promise<F[]> {
    const present: F[] = await folderRepo.find(
        { mailboxUid: ModelUtils.literal(mailboxUid), type: [...WELL_KNOWN_FOLDER_TYPES], limit: WELL_KNOWN_QUERY_LIMIT } as any,
        { ignoreACL: true, limit: WELL_KNOWN_QUERY_LIMIT, skipCache: true },
    );
    const have: Set<FolderType> = new Set(present.map((folder) => folder.type));
    const ensured: F[] = [];
    for (const type of WELL_KNOWN_FOLDER_TYPES) {
        if (!have.has(type)) {
            ensured.push(await findOrCreateWellKnownFolder(folderRepo, folderClass, mailboxUid, type, user));
        }
    }
    return ensured;
}

/**
 * Finds the given mailbox's well-known folder of `type` (e.g. its Inbox, Junk, Sent Items), creating it — with
 * the platform's conventional display name — if it does not already exist. A mailbox gets every well-known folder
 * when it is created and again whenever its folders are read (`ensureWellKnownFolders()`); this is the single-folder
 * step underneath, and what a delivery, a send or an import calls for the one it needs (so a mailbox that predates
 * that, or lost a folder, still works).
 *
 * **A folder this creates is announced**: `RepoUtils.create()` publishes
 * `{ type: "FolderMongo" | "FolderSQL", action: "create", data: <the folder> }` on the folder's own channel, and this asks
 * it to publish on the mailbox's channel too (`pushChannels`) - the one a client subscribes to - so a folder created
 * lazily (at first send, first junk delivery, ...) appears in an open client without a reload. Best-effort and
 * fire-and-forget (a failed publish never fails the create); a lost race publishes nothing (the winner's create did).
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

    const deterministicUid: string = wellKnownFolderUid(mailboxUid, type);
    const existing: F | undefined = await findExisting();
    if (existing) {
        if (existing.uid === deterministicUid) {
            // Repairs a folder a lost race left without an ACL when the repair below didn't get to run (cached read).
            await ensureFolderACL(folderRepo, existing.uid, mailboxUid, true);
        }
        return existing;
    }

    try {
        return await createWellKnownFolder(folderRepo, folderClass, mailboxUid, type, deterministicUid, user);
    } catch (err) {
        const winner: F | undefined = await findExisting();
        if (winner) {
            // This create's failed insert may have removed the ACL the winner's create reused (see `ensureFolderACL()`).
            // `create()` finished that removal before throwing, so checking now is late enough.
            if (winner.uid === deterministicUid) {
                await ensureFolderACL(folderRepo, winner.uid, mailboxUid);
            }
            return winner;
        }
        // No folder of this type was visible a moment ago. Either the create failed for another reason (nothing holds the
        // uid: rethrown), or the winner's row only became visible now (used - a random-uid folder created here instead left
        // the mailbox with two of the same type, seen under concurrent first reads), or a soft-deleted folder already holds
        // the deterministic uid, in which case a random uid is used rather than failing delivery.
        const holder: F | undefined = await folderRepo.findOne(deterministicUid, { ignoreACL: true, includeDeleted: true, skipCache: true });
        if (!holder) {
            throw err;
        }
        if ((holder as any).deleted !== true) {
            await ensureFolderACL(folderRepo, holder.uid, mailboxUid);
            return holder;
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
    // `RepoUtils.create()` publishes the new folder on its own channel; the mailbox's is where a client is listening.
    const pushChannels: string[] = [mailboxUid];
    if (!uid) {
        // A random uid: no existing ACL can legitimately be there, so service-core's default refusal applies.
        return await folderRepo.create(instance, { user, ignoreACL: true, acl, pushChannels });
    }

    // The deterministic uid is derived server-side from the mailbox uid and type and never taken from a client, and
    // only trusted callers can write an ACL at an arbitrary uid (`BaseACLRoute`), so an ACL already at this uid was
    // left behind by an earlier incarnation of this same folder (its row removed without its ACL). service-core
    // 2.1.0 refuses to reuse it unless told to (`allowExistingACL`). Reusing it keeps a lost race on the uid failing
    // on the unique index (the caller re-reads the winner) rather than at the ACL claim, before the winner's row is
    // visible - where the losing caller would find no winner and fail. The leftover ACL may carry stale grants or a
    // different parent, so once this create has won the uid its snapshot's records are removed and its parent reset
    // (`resetLeftoverACL()`).
    //
    // Reusing is always allowed, not only when a leftover was seen: two creates that both saw none still race on the
    // ACL claim, and the loser would fail instead of re-reading the winner. The cost is that the reused ACL can be one
    // a concurrent create just claimed; if that create then loses on the unique index, `RepoUtils.create()` removes
    // "its" ACL - the only one this folder has. `ensureFolderACL()` recreates it, here and in the loser's re-read.
    const aclUtils: ACLUtils | undefined = (folderRepo as any).aclUtils;
    const leftover: AccessControlList | undefined = await aclUtils?.findACL(uid, [], { skipCache: true, skipParents: true });
    const created: F = await folderRepo.create(instance, { user, ignoreACL: true, acl, allowExistingACL: true, pushChannels });
    if (leftover) {
        await resetLeftoverACL(aclUtils!, uid, mailboxUid, leftover);
    }
    await ensureFolderACL(folderRepo, uid, mailboxUid);
    return created;
}

/** An order-independent key of one ACL record. */
function recordKey(record: ACLRecord): string {
    return JSON.stringify([record.userOrRoleId, [...record.actions].sort()]);
}

/**
 * Removes the records of `leftover` (the ACL found at `uid` before the create) from the ACL now at `uid` and parents it
 * to the mailbox. Only the snapshot's records go: a share granted on the new folder between its insert and this reset
 * is kept. Version-checked (`saveACL()` refuses a stale version) and retried on a concurrent ACL write.
 */
async function resetLeftoverACL(aclUtils: ACLUtils, uid: string, mailboxUid: string, leftover: AccessControlList): Promise<void> {
    const stale: Set<string> = new Set(leftover.records.map(recordKey));
    for (let attempt = 1; ; attempt++) {
        const current: AccessControlList | undefined = await aclUtils.findACL(uid, [], { skipCache: true, skipParents: true });
        if (!current) {
            return;
        }
        const records: ACLRecord[] = current.records.filter((record) => !stale.has(recordKey(record)));
        if (current.parentUid === mailboxUid && records.length === current.records.length) {
            return;
        }
        current.parentUid = mailboxUid;
        current.records = records;
        try {
            await aclUtils.saveACL(current);
            return;
        } catch (err) {
            if (attempt >= 3) {
                throw err;
            }
        }
    }
}

/**
 * Recreates the folder ACL at `uid` (`{ uid, parentUid: mailboxUid, records: [] }`, the shape `createWellKnownFolder()`
 * seeds) when it is missing. `RepoUtils.create()` removes the ACL it claimed when its insert fails, and a well-known
 * folder create may have reused that very ACL (see `createWellKnownFolder()`), leaving the folder that won with no
 * ACL at all - which `hasPermission()` then denies to everyone, the mailbox owner included, for good. Claimed with
 * `createOnly`, so a concurrent repair of the same folder is harmless. `cached` allows a cached read first (the
 * find-existing path runs on every delivery); a missing ACL is always confirmed uncached before it is recreated.
 */
async function ensureFolderACL(folderRepo: RepoUtils<any>, uid: string, mailboxUid: string, cached: boolean = false): Promise<void> {
    const aclUtils: ACLUtils | undefined = (folderRepo as any).aclUtils;
    if (!aclUtils) {
        return;
    }
    const exists = async (skipCache: boolean): Promise<boolean> => !!(await aclUtils.findACL(uid, [], { skipCache, skipParents: true }));
    if ((cached && (await exists(false))) || (await exists(true))) {
        return;
    }
    try {
        await aclUtils.saveACL({ uid, parentUid: mailboxUid, records: [] }, { createOnly: true });
    } catch (err) {
        if (!(await exists(true))) {
            throw err;
        }
    }
}
