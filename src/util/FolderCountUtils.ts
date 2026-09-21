///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AsyncLocalStorage } from "node:async_hooks";
import { MongoRepository, type NotificationUtils, type RepoUtils } from "@rapidrest/service-core";
import { asEntity } from "./EntityUtils.js";

/**
 * Folder counts, derived from the messages.
 *
 * `Folder.unreadCount`/`Folder.totalCount` used to be stored counters that were only ever incremented (at ingest),
 * so they were wrong the moment a message was read, moved, deleted, sent or retained away. The messages are the
 * source of truth: every read of a folder through `BaseFolderRoute` derives both numbers from them with ONE grouped
 * query per request (`countMessagesByFolder()`), and the stored fields are kept only as a best-effort cache -
 * refreshed at every point this library changes what a folder holds (`refreshFolderCounts()`, which also publishes
 * the live event below) so that a reader that goes straight to the `Folder` row (`@rapidmx/mapi-plugin`'s folder
 * tables) sees roughly what the route would answer. Nothing in this library trusts the stored values.
 *
 * What counts: exactly the rows the message list (`GET /messages?folderUid=`) shows - the folder's messages that are
 * not soft-deleted (`deleted = false`, `RepoUtils.find()`'s own default) - so a badge always equals what the list
 * holds. A message is unread unless `flags.read` is `true` (unset, `false` or a missing `flags` all count as unread).
 * `flags` itself is read, not the denormalized `Message.read` mirror: a protocol package that writes `flags` through
 * its own repository doesn't maintain the mirror (see `syncMessageListFields()`), and the mirror is `NULL` on rows
 * older than it.
 *
 * ## Live event
 *
 * After a change to what a folder holds (a message created, marked read/unread, moved, deleted, sent, imported,
 * purged, retained away) the folder's counts are published on **both the folder's channel (`Folder.uid`) and its
 * mailbox's channel (`Folder.mailboxUid`)** as:
 *
 * ```
 * { type: "FolderMongo" | "FolderSQL", action: "update", data: { uid, mailboxUid, unreadCount, totalCount } }
 * ```
 *
 * (`type` is the concrete folder class's name, so a client matches `/^Folder/`; `data.uid` is the folder, so the
 * copy on the mailbox channel is unambiguous.) `data` carries only those four fields - it is not the folder row.
 * One event per affected folder per operation: a bulk update, a send (Drafts, Outbox, Sent Items) or a truncate
 * publishes once per folder when it finishes (`coalesceFolderCounts()`); a move publishes the source and the
 * destination. Publishing is best-effort and fire-and-forget: a failure is logged and never fails the write. Events
 * from two overlapping writes to one folder are not ordered relative to each other, so a client should treat an event
 * as "this folder changed, and this is what it held a moment ago", and re-read (`GET /folders`) on reconnect.
 */

/** A folder's derived counts. */
export interface FolderCounts {
    /** Messages in the folder whose `flags.read` is not `true`. */
    unreadCount: number;
    /** Every message in the folder. */
    totalCount: number;
}

/** The `data` of the `{ action: "update" }` event `refreshFolderCounts()` publishes for a folder. */
export interface FolderCountsEvent extends FolderCounts {
    /** The folder. */
    uid: string;
    /** The mailbox the folder belongs to. */
    mailboxUid: string;
}

/** What `refreshFolderCounts()` needs to recompute, cache and publish a folder's counts. */
export interface FolderCountsContext {
    /** The repository of the concrete `Message` class - counted with one grouped query, never loaded. */
    messageRepo: RepoUtils<any>;
    /** The repository of the concrete `Folder` class - the stored counts are refreshed through it. */
    folderRepo: RepoUtils<any>;
    /** The concrete `Folder` class; its name is the event's `type`. */
    folderClass: any;
    /** Publishes the event; without it nothing is published (the stored counts are still refreshed). */
    notificationUtils?: NotificationUtils;
    logger?: any;
}

/** How many folder uids one grouped query names, keeping a SQL `IN` list bounded. */
const COUNT_BATCH_SIZE: number = 500;

/** How many times `refreshFolderCounts()` recomputes and re-tries a folder whose cached counts lost a version race. */
const REFRESH_ATTEMPTS: number = 3;

/** The `flags` fragment a SQL row carries when it is read: `flags` is a `simple-json` column, i.e. `JSON.stringify()`
 * output, and `MessageFlags` holds only booleans, so this can't match anything but the key. */
const SQL_READ_FLAG_PATTERN: string = '%"read":true%';

/**
 * Counts the messages of every folder in `folderUids` with one grouped query per `COUNT_BATCH_SIZE` uids - a `$group`
 * over `folderUid` on MongoDB, a `GROUP BY folderUid` on SQL - restricted to messages that are not soft-deleted. A folder
 * with no messages is in the result with `{ unreadCount: 0, totalCount: 0 }`.
 *
 * Never loads a message: MongoDB reads only `folderUid`, `deleted` and `flags.read`, which the
 * `message_folder_deleted_flags_read` index on `MessageMongo` covers. On SQL, `flags` is opaque JSON text, so the rows
 * of the folders are read (through `message_folder`) and their `flags` matched; there is no index that can cover that.
 *
 * @param messageRepo The repository of the concrete `Message` class.
 * @param folderUids The folders to count.
 */
export async function countMessagesByFolder(messageRepo: RepoUtils<any>, folderUids: readonly string[]): Promise<Map<string, FolderCounts>> {
    const counts: Map<string, FolderCounts> = new Map();
    const uids: string[] = [...new Set(folderUids)];
    for (const uid of uids) {
        counts.set(uid, { unreadCount: 0, totalCount: 0 });
    }
    const repo: any = messageRepo.repo;
    for (let i = 0; i < uids.length; i += COUNT_BATCH_SIZE) {
        const batch: string[] = uids.slice(i, i + COUNT_BATCH_SIZE);
        const rows: any[] =
            repo instanceof MongoRepository
                ? await repo
                      .aggregate([
                          { $match: { folderUid: { $in: batch }, deleted: false } },
                          {
                              $group: {
                                  _id: "$folderUid",
                                  totalCount: { $sum: 1 },
                                  unreadCount: { $sum: { $cond: [{ $eq: ["$flags.read", true] }, 0, 1] } },
                              },
                          },
                      ])
                      .toArray()
                : await repo
                      .createQueryBuilder("m")
                      .select("m.folderUid", "_id")
                      .addSelect("COUNT(*)", "totalCount")
                      .addSelect("SUM(CASE WHEN m.flags LIKE :read THEN 0 ELSE 1 END)", "unreadCount")
                      .where("m.folderUid IN (:...uids)", { uids: batch })
                      .andWhere("m.deleted = :deleted", { deleted: false })
                      .groupBy("m.folderUid")
                      .setParameter("read", SQL_READ_FLAG_PATTERN)
                      .getRawMany();
        for (const row of rows) {
            // SQL drivers hand a SUM/COUNT back as a string (PostgreSQL bigint, MySQL decimal).
            counts.set(row._id, { unreadCount: Number(row.unreadCount), totalCount: Number(row.totalCount) });
        }
    }
    return counts;
}

/** The distinct, non-empty strings of `values`. */
function distinctUids(values: Iterable<unknown>): string[] {
    const uids: Set<string> = new Set();
    for (const value of values) {
        if (typeof value === "string" && value.length > 0) {
            uids.add(value);
        }
    }
    return [...uids];
}

/**
 * Writes `counts` onto a folder's stored `unreadCount`/`totalCount` (the cache), if they differ, with a version-checked
 * update that does not publish the record (the caller publishes the counts event itself) - optionally also bumping
 * `syncKeyVersion`, which every write that adds to a folder has always done.
 *
 * @returns `false` when the write lost a version race (the caller re-reads and retries).
 */
async function storeFolderCounts(folderRepo: RepoUtils<any>, folder: any, counts: FolderCounts, bumpSyncKey: boolean): Promise<boolean> {
    if (folder.unreadCount === counts.unreadCount && folder.totalCount === counts.totalCount && !bumpSyncKey) {
        return true;
    }
    try {
        await folderRepo.update(
            {
                uid: folder.uid,
                version: folder.version,
                unreadCount: counts.unreadCount,
                totalCount: counts.totalCount,
                ...(bumpSyncKey ? { syncKeyVersion: (folder.syncKeyVersion ?? 0) + 1 } : {}),
            } as any,
            asEntity(folderRepo, folder),
            { ignoreACL: true, skipPush: true },
        );
        return true;
    } catch {
        return false;
    }
}

/**
 * Brings the stored (cached) counts of every folder in `folders` up to date with what `counts` derived from the
 * messages, best-effort: a folder that lost a version race is left for whoever changes it next. Used by
 * `BaseFolderRoute` after it answers a read from the derived counts, so a stale row heals itself.
 *
 * @param folders The folders as they were read, still carrying the stored counts.
 * @param counts The derived counts, by folder uid.
 */
export async function healStoredFolderCounts(folderRepo: RepoUtils<any>, folders: any[], counts: Map<string, FolderCounts>): Promise<void> {
    for (const folder of folders) {
        const derived: FolderCounts | undefined = counts.get(folder.uid);
        if (derived) {
            await storeFolderCounts(folderRepo, folder, derived, false);
        }
    }
}

/**
 * Recomputes the counts of `folderUids` (one grouped query), refreshes the stored cache, and publishes each folder's
 * `{ uid, mailboxUid, unreadCount, totalCount }` (see the module comment for the exact event and channels). Call it
 * after any write that changed which messages a folder holds, or whether they are read. Never throws: a failure is
 * logged and the write it follows is unaffected. A folder that no longer exists (or was soft-deleted) is skipped.
 *
 * @param ctx The repositories and publisher.
 * @param folderUids The affected folders - a move names both its source and destination. `undefined` entries are ignored.
 * @param options `bumpSyncKey` also bumps each folder's `syncKeyVersion`, as adding a message always has.
 */
export async function refreshFolderCounts(
    ctx: FolderCountsContext,
    folderUids: Iterable<string | undefined | null>,
    options: { bumpSyncKey?: boolean } = {},
): Promise<void> {
    const requested: string[] = distinctUids(folderUids);
    try {
        let pending: string[] = requested;
        for (let attempt = 1; pending.length > 0; attempt++) {
            const counts: Map<string, FolderCounts> = await countMessagesByFolder(ctx.messageRepo, pending);
            const conflicted: string[] = [];
            for (const uid of pending) {
                const folder: any = await ctx.folderRepo.findOne(uid, { ignoreACL: true, skipCache: true });
                if (!folder) {
                    continue;
                }
                const derived: FolderCounts = counts.get(uid)!;
                if (!(await storeFolderCounts(ctx.folderRepo, folder, derived, options.bumpSyncKey === true)) && attempt < REFRESH_ATTEMPTS) {
                    // Another write to the folder won: the counts are recomputed too, or this could store older ones over newer.
                    conflicted.push(uid);
                    continue;
                }
                const event: FolderCountsEvent = {
                    uid: folder.uid,
                    mailboxUid: folder.mailboxUid,
                    unreadCount: derived.unreadCount,
                    totalCount: derived.totalCount,
                };
                ctx.notificationUtils?.sendMessage(distinctUids([folder.uid, folder.mailboxUid]), ctx.folderClass.name, "update", event);
            }
            pending = conflicted;
        }
    } catch (err: any) {
        ctx.logger?.warn(`FolderCountUtils: failed to refresh the counts of folder(s) ${requested.join(", ")}: ${err?.message}`);
    }
}

/** The folders a `coalesceFolderCounts()` scope has been told about so far. */
const collector: AsyncLocalStorage<Set<string>> = new AsyncLocalStorage();

/**
 * Runs `work`; every `notifyFolderCounts()` call made while it runs (in the same async context - a request's own) is
 * collected instead of published, and the folders it named are refreshed and published once, when `work` settles -
 * whether it returned or threw, since what it already did stays done. `ctx` may be a function building the context, which
 * is then only called if a folder was named. This is how a bulk update publishes once per
 * folder rather than once per message. Nested scopes join the outermost one.
 */
export async function coalesceFolderCounts<R>(
    ctx: FolderCountsContext | (() => Promise<FolderCountsContext>),
    work: () => Promise<R>,
): Promise<R> {
    if (collector.getStore()) {
        return await work();
    }
    const affected: Set<string> = new Set();
    try {
        return await collector.run(affected, work);
    } finally {
        // The context is only built (a thunk lets a caller defer it) once there is something to publish.
        if (affected.size > 0) {
            await refreshFolderCounts(typeof ctx === "function" ? await ctx() : ctx, affected);
        }
    }
}

/**
 * `refreshFolderCounts()` now - or, inside a `coalesceFolderCounts()` scope, once when that scope ends.
 */
export async function notifyFolderCounts(ctx: FolderCountsContext, folderUids: Iterable<string | undefined | null>): Promise<void> {
    const affected: Set<string> | undefined = collector.getStore();
    if (affected) {
        for (const uid of distinctUids(folderUids)) {
            affected.add(uid);
        }
        return;
    }
    await refreshFolderCounts(ctx, folderUids);
}
