///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, type JWTUser, type ObjectFactory } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, type ACLUtils, type HttpRequest, ModelUtils, MongoRepository, type RepoUtils } from "@rapidrest/service-core";
import { ERASURE_IN_PROGRESS } from "../jobs/ErasureExecutionJob.js";
import { AuditAction } from "../models/types.js";
import { recordAuditLog } from "./AuditLogUtils.js";
import { assertNotOnLegalHold } from "./LegalHoldUtils.js";

/**
 * The data a deleted mailbox leaves behind, and how an administrator erases it.
 *
 * Deleting a mailbox removes only its `Mailbox` row and that row's own `AccessControlList`. Its folders (with ACLs
 * parented to the mailbox uid) and every row that carries its `mailboxUid` stay. A mailbox's uid is its address, so a new
 * mailbox at the same address would be handed all of it - `BaseMailboxRoute` therefore refuses to create one until the old
 * data is erased (`assertNoLeftoverMailboxData()`). Erasing it is the job of `ErasureExecutionJob`, driven by a
 * `DataSubjectErasureRequest` the administrator files for the uid (`fileLeftoverErasure()`); the job already purges every
 * `mailboxUid`-scoped row, tolerates a missing mailbox row and, for one, removes the mailbox's own ACL document too.
 *
 * "Leftover" means exactly what blocks re-creation: a `Folder` (soft-deleted included) naming the uid as its `mailboxUid`,
 * or an `AccessControlList` at the uid. `listLeftoverMailboxes()` finds the first kind by the folders (the only kind that can
 * be enumerated - an ACL document carries no type); an address whose only remains are an ACL is still refused on create and
 * still erasable by naming it.
 */

/** The bounds of `listLeftoverMailboxes()`. A mutable object only so the tests can lower them. */
export const LEFTOVER_LIMITS = {
    /** How many mailboxes a list answers unless the caller asks for fewer. */
    defaultLimit: 50,
    /** The most a caller may ask for. */
    maxLimit: 100,
    /** How many distinct mailbox uids are read from the folders at a time. */
    scanPageSize: 100,
    /** How many distinct mailbox uids one list reads at most before it answers with a cursor - a server where nearly every uid
     * still has its mailbox would otherwise be scanned end to end. */
    maxScanned: 5000,
};

/** The statuses of an erasure request that is on its way to running (or running) - not waiting for a review. */
const RUNNING_STATUSES: string[] = ["approved", ERASURE_IN_PROGRESS];
/** Every status of a request that is not finished: what a second request for the same mailbox is refused or folded into. */
const OPEN_STATUSES: string[] = ["pending", ...RUNNING_STATUSES];

/** What `findLeftoverEvidence()` found for a mailbox uid. */
export interface LeftoverEvidence {
    /** How many folders (soft-deleted included) name the uid as their mailbox. */
    folderCount: number;
    /** Whether an `AccessControlList` exists at the uid. */
    hasAcl: boolean;
}

/** One deleted mailbox that still has data, as `GET /mailboxes/leftover` lists it. */
export interface LeftoverMailbox {
    mailboxUid: string;
    folderCount: number;
    messageCount: number;
    /** The newest erasure request filed for the uid, if any - a UI shows an erasure that is running, waiting or finished. */
    erasure?: { uid: string; status: string; dateCreated: Date };
}

/** One page of `GET /mailboxes/leftover`. */
export interface LeftoverMailboxPage {
    items: LeftoverMailbox[];
    /** Present when there may be more: pass it back as `after` to continue. Absent once the end was reached. */
    next?: string;
}

/** The repositories and services the leftover helpers work through. */
export interface LeftoverContext {
    objectFactory: ObjectFactory;
    mailboxRepo: RepoUtils<any>;
    folderRepo: RepoUtils<any>;
    requestRepo: RepoUtils<any>;
    /** The concrete `DataSubjectErasureRequest` class. */
    requestClass: any;
    matterClass: any;
    auditLogClass: any;
    aclUtils?: ACLUtils;
    config: any;
    logger?: any;
}

/** `LeftoverContext` plus what `listLeftoverMailboxes()` counts. */
export interface LeftoverListContext extends LeftoverContext {
    messageRepo: RepoUtils<any>;
}

/** A 409 carrying a machine-readable `reason` (and any `extra` fields) besides its message - the framework serializes every
 * own property of the error, so a client tells this refusal from another 409 without reading the text. */
export function leftoverConflict(reason: string, message: string, extra: Record<string, unknown> = {}): ApiError {
    return Object.assign(new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, message), { reason, ...extra });
}

/** Reads what data `uid` (a mailbox uid) still has: its folders and its ACL. */
export async function findLeftoverEvidence(folderRepo: RepoUtils<any>, aclUtils: ACLUtils | undefined, uid: string): Promise<LeftoverEvidence> {
    const folderCount: number = await folderRepo.count({ mailboxUid: ModelUtils.literal(uid) } as any, { ignoreACL: true, includeDeleted: true });
    const acl = await aclUtils?.findACL(uid, [], { skipCache: true });
    return { folderCount, hasAcl: !!acl };
}

/** The erasure request for `mailboxUid` that is in `statuses`, oldest first (`undefined` for none). */
async function findErasure(requestRepo: RepoUtils<any>, mailboxUid: string, statuses: string[]): Promise<any | undefined> {
    const rows: any[] = await requestRepo.find(
        { mailboxUid: ModelUtils.literal(mailboxUid), status: ModelUtils.literal(statuses, "in"), sort: { dateCreated: "ASC" }, limit: 10 } as any,
        { ignoreACL: true, limit: 10, skipCache: true },
    );
    // Whatever the query matched, a row for another mailbox or in another status is never taken for this one.
    return rows.find((row) => row.mailboxUid === mailboxUid && statuses.includes(row.status));
}

/** The request that is erasing (approved or running) `mailboxUid`'s data, if any. */
export async function findRunningErasure(requestRepo: RepoUtils<any>, mailboxUid: string): Promise<any | undefined> {
    return await findErasure(requestRepo, mailboxUid, RUNNING_STATUSES);
}

/** The distinct `mailboxUid`s of the folders (soft-deleted included), ascending, strictly after `after` when given, at most
 * `limit`. A grouped read on either backend - a `$group` on MongoDB, a `GROUP BY` on SQL. */
export async function listFolderMailboxUids(folderRepo: RepoUtils<any>, after: string | undefined, limit: number): Promise<string[]> {
    const repo: any = folderRepo.repo;
    if (repo instanceof MongoRepository) {
        const rows: any[] = await repo
            .aggregate([
                { $match: { mailboxUid: after === undefined ? { $type: "string" } : { $gt: after } } },
                { $sort: { mailboxUid: 1 } },
                { $group: { _id: "$mailboxUid" } },
                { $sort: { _id: 1 } },
                { $limit: limit },
            ])
            .toArray();
        return rows.map((row) => row._id);
    }
    const query = repo.createQueryBuilder("f").select("f.mailboxUid", "mailboxUid");
    const rows: any[] = await (after === undefined ? query.where("f.mailboxUid IS NOT NULL") : query.where("f.mailboxUid > :after", { after }))
        .groupBy("f.mailboxUid")
        .orderBy("f.mailboxUid", "ASC")
        .limit(limit)
        .getRawMany();
    return rows.map((row) => row.mailboxUid);
}

/** Clamps a client's `?limit=` to `1..maxLimit` (`defaultLimit` when it is not a number). */
export function parseLeftoverLimit(value: unknown): number {
    const parsed: number = typeof value === "string" || typeof value === "number" ? Math.floor(Number(value)) : NaN;
    return Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, LEFTOVER_LIMITS.maxLimit) : LEFTOVER_LIMITS.defaultLimit;
}

/**
 * Lists deleted mailboxes that still have data: distinct `mailboxUid`s of folders that no `Mailbox` row has as its uid,
 * ascending, with the folder and message counts and the newest erasure request of each. Bounded three ways: at most
 * `limit` mailboxes (`LEFTOVER_LIMITS.maxLimit`), at most `LEFTOVER_LIMITS.maxScanned` folder mailbox uids read per call, and
 * counts taken by an indexed `mailboxUid` count per listed mailbox. `next` says there may be more.
 *
 * @param after Continue after this mailbox uid (the previous page's `next`).
 */
export async function listLeftoverMailboxes(ctx: LeftoverListContext, after: string | undefined, limit: number): Promise<LeftoverMailboxPage> {
    const found: string[] = [];
    let cursor: string | undefined = after;
    let scanned = 0;
    // Set once every folder mailbox uid after `after` has been read and looked at.
    let exhausted = false;
    while (found.length < limit && scanned < LEFTOVER_LIMITS.maxScanned) {
        const uids: string[] = await listFolderMailboxUids(ctx.folderRepo, cursor, LEFTOVER_LIMITS.scanPageSize);
        if (uids.length === 0) {
            exhausted = true;
            break;
        }
        scanned += uids.length;
        const live: Set<string> = new Set(
            (await ctx.mailboxRepo.find({ uid: ModelUtils.literal(uids, "in"), limit: uids.length } as any, { ignoreACL: true, limit: uids.length })).map(
                (mailbox) => mailbox.uid,
            ),
        );
        for (const uid of uids) {
            cursor = uid;
            if (!live.has(uid)) {
                found.push(uid);
                if (found.length >= limit) {
                    break;
                }
            }
        }
        if (uids.length < LEFTOVER_LIMITS.scanPageSize && cursor === uids[uids.length - 1]) {
            exhausted = true;
            break;
        }
    }

    const items: LeftoverMailbox[] = [];
    for (const mailboxUid of found) {
        const criteria: any = { mailboxUid: ModelUtils.literal(mailboxUid) };
        const [folderCount, messageCount, latest] = await Promise.all([
            ctx.folderRepo.count(criteria, { ignoreACL: true, includeDeleted: true }),
            ctx.messageRepo.count(criteria, { ignoreACL: true, includeDeleted: true }),
            ctx.requestRepo.find({ ...criteria, sort: { dateCreated: "DESC" }, limit: 1 }, { ignoreACL: true, limit: 1, skipCache: true }),
        ]);
        const erasure: any = latest.find((row) => row.mailboxUid === mailboxUid);
        items.push({
            mailboxUid,
            folderCount,
            messageCount,
            ...(erasure ? { erasure: { uid: erasure.uid, status: erasure.status, dateCreated: erasure.dateCreated } } : {}),
        });
    }
    return { items, ...(exhausted ? {} : { next: cursor }) };
}

/**
 * Files an erasure of the leftover data of the deleted mailbox `mailboxUid`, already approved by `user` (the administrator
 * filing it, who the caller has checked with `assertAdminScope()`): a `DataSubjectErasureRequest` with `leftoverOnly` set and
 * `status: "approved"`, which `ErasureExecutionJob` then runs - the same audit trail, legal-hold checks and purge as an erasure
 * of a live mailbox. Audited as `ERASURE_REQUEST_CREATED` and `ERASURE_REQUEST_APPROVED`, both with `details.leftover`.
 *
 * Refuses (`409`, with a `reason`): the mailbox row exists (`mailbox-exists` - that mailbox is erased through an ordinary
 * erasure request, never through this route); a legal hold covers the address (the framework's hold 409). `404` when nothing
 * is left to erase. Idempotent: an approved or running request for the uid is returned as it is (`created: false`), and a
 * request still `pending` (a self-service one of the mailbox's former owner) is approved rather than duplicated.
 *
 * @returns The request, and whether this call created it.
 */
export async function fileLeftoverErasure(
    ctx: LeftoverContext,
    caller: { user: JWTUser; req?: HttpRequest },
    mailboxUid: string,
): Promise<{ request: any; created: boolean }> {
    const existing = await ctx.mailboxRepo.findOne(mailboxUid, { ignoreACL: true, includeDeleted: true });
    if (existing) {
        throw leftoverConflict(
            "mailbox-exists",
            "This mailbox still exists. Erase it with an erasure request instead of as leftover data.",
            { mailboxUid },
        );
    }
    const evidence: LeftoverEvidence = await findLeftoverEvidence(ctx.folderRepo, ctx.aclUtils, mailboxUid);
    if (evidence.folderCount === 0 && !evidence.hasAcl) {
        throw new ApiError(ApiErrors.NOT_FOUND, 404, "There is no data left over from a deleted mailbox at this address.");
    }
    await assertNotOnLegalHold(ctx.objectFactory, ctx.matterClass, mailboxUid);

    const audit = async (action: AuditAction, request: any): Promise<void> => {
        await recordAuditLog(
            ctx.objectFactory,
            ctx.auditLogClass,
            { config: ctx.config, req: caller.req, user: caller.user, logger: ctx.logger },
            {
                action,
                targetType: "DataSubjectErasureRequest",
                targetUid: request.uid,
                mailboxUid,
                details: { leftover: true, folderCount: evidence.folderCount },
            },
        );
    };

    const open: any | undefined = await findErasure(ctx.requestRepo, mailboxUid, OPEN_STATUSES);
    if (open && open.status !== "pending") {
        return { request: open, created: false };
    }
    if (open) {
        const approved = await ctx.requestRepo.update(
            { uid: open.uid, version: open.version, status: "approved", reviewedByUserUid: caller.user.uid, leftoverOnly: true } as any,
            open,
            { ignoreACL: true },
        );
        await audit(AuditAction.ERASURE_REQUEST_APPROVED, approved);
        return { request: approved, created: false };
    }
    const request = await ctx.requestRepo.create(
        new ctx.requestClass({
            mailboxUid,
            requestedByUserUid: caller.user.uid,
            reviewedByUserUid: caller.user.uid,
            status: "approved",
            leftoverOnly: true,
        }),
        { ignoreACL: true },
    );
    await audit(AuditAction.ERASURE_REQUEST_CREATED, request);
    await audit(AuditAction.ERASURE_REQUEST_APPROVED, request);
    return { request, created: true };
}

/**
 * The mailbox uid a client named, or a 400 for anything that is not a plausible one (not text, empty, longer than an address
 * can be, or with a control character). A uid holding an `@` is an address and is trimmed and lowercased as
 * `createMailboxes()` derives it; any other is kept exactly.
 */
export function requireMailboxUid(value: unknown): string {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > 320 || /\p{Cc}/u.test(value)) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
    }
    return value.includes("@") ? value.trim().toLowerCase() : value;
}
