///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { ApiError, type JWTUser } from "@rapidrest/core";
import { ACLAction, ApiErrors, HttpRequest, RepoUtils, RouteDecorators, type AccessControlList, type UpdateObject } from "@rapidrest/service-core";
import { BaseScopedChildRoute } from "./BaseScopedChildRoute.js";
import { CalendarShareLink, Folder, FolderType } from "../models/types.js";
const { Param, Query, Request, User: AuthUser } = RouteDecorators;

/** The `userOrRoleId` a link's grant is written under - see the identical constant (and why it's duplicated) on
 * `BaseScopedChildRoute.ts`. Records written before this prefix existed are keyed by the bare token; revocation and
 * re-granting remove both forms, so updating such a link migrates it. */
const SHARE_TOKEN_UID_PREFIX = "share:";

/** What a link may grant: reading a calendar's events and its free/busy (see `CalendarShareLink.permittedActions`) - never a write. */
const SHAREABLE_ACTIONS: readonly string[] = [ACLAction.READ, ACLAction.LIST, ACLAction.COUNT, ACLAction.EXISTS, "freebusy"];

/** How long a link lives when its creator names no `expiresAt`. */
export const DEFAULT_SHARE_LINK_TTL_MS: number = 90 * 24 * 60 * 60 * 1000;

/** The longest a link may live, however far ahead its creator sets `expiresAt` - a link is a standing grant on the folder's access list. */
export const MAX_SHARE_LINK_TTL_MS: number = 366 * 24 * 60 * 60 * 1000;

/** The most links one calendar folder may have: each is a record on the folder's access list, read on every access check to it. */
export const MAX_SHARE_LINKS_PER_FOLDER: number = 50;

function isShareTokenRecord(userOrRoleId: string, token: string): boolean {
    return userOrRoleId === `${SHARE_TOKEN_UID_PREFIX}${token}` || userOrRoleId === token;
}

/**
 * Extends `BaseScopedChildRoute` (scoped by `folderUid`) for `CalendarShareLink` with the two pieces of
 * bookkeeping that make anonymous share-link consumption work with NO separate route or lookup of its own
 * (see `BaseScopedChildRoute`'s doc comment and its local `resolveEffectiveUser()` helper for the read side of
 * this mechanism):
 *
 * 1. `create()`/`update()` always mint (or preserve) `token` server-side, discarding any value the client
 * supplied for it — `token` is the sole credential an anonymous caller presents, so its unguessability can't
 * depend on the client, and it must never change after creation (a client "updating" it would orphan the ACL
 * record already granted under the old value).
 * 2. `create()`/`update()`/`delete()` keep a real `ACLRecord` for the link's token in sync on the shared
 * folder's `AccessControlList` (`{userOrRoleId: "share:" + token, actions: permittedActions}`) — granted on create,
 * re-granted (upserted, picking up any `permittedActions`/`folderUid` change) on update, and revoked on
 * delete. `ExternalShareExpirationJob` does the same revocation for links it GCs after they expire.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseCalendarShareLinkRoute<T extends CalendarShareLink> extends BaseScopedChildRoute<T> {
    /** `ExternalShareExpirationJob` range-queries `expiresAt`, which never matches a string on Mongo. */
    protected readonly dateFields: readonly string[] = ["expiresAt"];

    /** The concrete `Folder` entity class, supplied by the Mongo/SQL concrete subclass - a link can only share a calendar folder. */
    protected abstract folderClass: any;

    private folderRepo?: RepoUtils<Folder>;

    /**
     * Checks what a link grants against its creator and the folder, for a create or an update that names `permittedActions` or `folderUid`:
     * every action must be one of `SHAREABLE_ACTIONS` (400) and one `user` holds on the folder themselves (403) - a link is never a way to hand
     * out more than its creator has, as a delegate holding only CREATE could otherwise mint a `read` token - and the folder must be a calendar
     * (400).
     */
    private async assertLinkAllowed(folderUid: string, actions: unknown, user: JWTUser | undefined): Promise<void> {
        // A list longer than there are shareable actions can only repeat some (each repeat would be a permission check, and an entry on the folder's ACL).
        if (Array.isArray(actions) && actions.length > SHAREABLE_ACTIONS.length) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'permittedActions' must be a list of: ${SHAREABLE_ACTIONS.join(", ")}.`);
        }
        if (!Array.isArray(actions) || actions.length === 0 || actions.some((action) => typeof action !== "string" || !SHAREABLE_ACTIONS.includes(action))) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'permittedActions' must be a list of: ${SHAREABLE_ACTIONS.join(", ")}.`);
        }
        if (!this.folderRepo) {
            this.folderRepo = await this._objectFactory!.newInstance(RepoUtils, { name: this.folderClass.name, args: [this.folderClass] });
        }
        const folder: Folder | undefined = await this.folderRepo.findOne(folderUid, { ignoreACL: true });
        if (folder?.type !== FolderType.CALENDAR) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A share link can only share a calendar folder.");
        }
        for (const action of actions as string[]) {
            if (!(await this.hasMailAccess(user, folderUid, action))) {
                throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, "A share link can't grant an action you don't hold on the calendar.");
            }
        }
    }

    /** `token` is minted by `create()`, the creator is always the caller, and a link with no `expiresAt` gets `DEFAULT_SHARE_LINK_TTL_MS`. */
    protected async prepareCreate(obj: any, user: JWTUser | undefined): Promise<void> {
        await super.prepareCreate(obj, user);
        this.dedupeActions(obj);
        await this.assertLinkAllowed(obj.folderUid, obj.permittedActions, user);
        if (typeof obj.folderUid === "string" && (await this.repoUtils!.count({ folderUid: obj.folderUid } as any, { ignoreACL: true })) >= MAX_SHARE_LINKS_PER_FOLDER) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `A calendar can have at most ${MAX_SHARE_LINKS_PER_FOLDER} share links.`);
        }
        obj.createdByUserUid = user?.uid;
        if (obj.expiresAt === undefined || obj.expiresAt === null) {
            obj.expiresAt = new Date(Date.now() + DEFAULT_SHARE_LINK_TTL_MS);
        }
        this.assertExpiryBounded(obj.expiresAt);
    }

    /** `permittedActions` without repeats. */
    private dedupeActions(obj: any): void {
        if (Array.isArray(obj.permittedActions)) {
            obj.permittedActions = [...new Set(obj.permittedActions)];
        }
    }

    /** Refuses (400) an `expiresAt` that isn't a date or lies further ahead than `MAX_SHARE_LINK_TTL_MS`. */
    private assertExpiryBounded(expiresAt: unknown): void {
        const time: number = expiresAt instanceof Date ? expiresAt.getTime() : typeof expiresAt === "string" || typeof expiresAt === "number" ? new Date(expiresAt).getTime() : NaN;
        if (Number.isNaN(time) || time > Date.now() + MAX_SHARE_LINK_TTL_MS) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'expiresAt' must be a date no more than a year ahead.");
        }
    }

    protected async prepareUpdate(obj: any, existing: T, user: JWTUser | undefined): Promise<void> {
        await super.prepareUpdate(obj, existing, user);
        // Who made the link is fixed; a changed grant or folder is checked as a new one.
        delete obj.createdByUserUid;
        this.dedupeActions(obj);
        // A link never becomes permanent, and its end is only moved within the bound (a value that isn't changing - a round-tripped object - isn't judged).
        if ("expiresAt" in obj) {
            const unchanged: boolean = obj.expiresAt != null && existing.expiresAt != null && new Date(obj.expiresAt).getTime() === new Date(existing.expiresAt).getTime();
            if (!unchanged) {
                this.assertExpiryBounded(obj.expiresAt);
            }
        }
        if ("permittedActions" in obj || (typeof obj.folderUid === "string" && obj.folderUid !== existing.folderUid)) {
            await this.assertLinkAllowed(obj.folderUid ?? existing.folderUid, obj.permittedActions ?? existing.permittedActions, user);
        }
    }

    /** Grants (or re-grants, upserting) `link.token` access to `link.folderUid`'s ACL, matching `link`'s
     * current `permittedActions`. A no-op if the folder has no ACL document (should never happen in practice —
     * every `Folder` is seeded with one on creation — but this is a background-adjacent write, not a
     * request the caller is blocked on, so failing open rather than throwing keeps a missing/corrupt folder
     * ACL from turning "create a share link" into a 500. */
    private async grantShareTokenAccess(link: T): Promise<void> {
        const acl: AccessControlList | undefined = await this.aclUtils!.findACL(link.folderUid);
        if (!acl) {
            return;
        }
        acl.records = [
            ...acl.records.filter((record) => !isShareTokenRecord(record.userOrRoleId, link.token)),
            { userOrRoleId: `${SHARE_TOKEN_UID_PREFIX}${link.token}`, actions: link.permittedActions },
        ];
        await this.aclUtils!.saveACL(acl);
    }

    /** Removes any ACL record for `token` from `folderUid`'s ACL. A no-op if the folder has no ACL document or
     * no matching record - same fail-open rationale as `grantShareTokenAccess()`. */
    private async revokeShareTokenAccess(folderUid: string, token: string): Promise<void> {
        const acl: AccessControlList | undefined = await this.aclUtils!.findACL(folderUid);
        if (!acl) {
            return;
        }
        const records = acl.records.filter((record) => !isShareTokenRecord(record.userOrRoleId, token));
        if (records.length === acl.records.length) {
            return;
        }
        acl.records = records;
        await this.aclUtils!.saveACL(acl);
    }

    public async create(obj: T | T[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T | T[]> {
        for (const single of Array.isArray(obj) ? obj : [obj]) {
            (single as any).token = crypto.randomBytes(32).toString("base64url");
        }
        const created: T | T[] = await super.create(obj, req, user);
        for (const single of Array.isArray(created) ? created : [created]) {
            await this.grantShareTokenAccess(single);
        }
        return created;
    }

    public async update(
        id: string,
        obj: UpdateObject<T>,
        @Request req?: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        // `token` is immutable once minted - a client-supplied change would orphan the ACL record already
        // granted under the old value, since nothing would ever revoke it.
        delete (obj as any).token;

        const existing: T | undefined = this.repoUtils ? await this.repoUtils.findOne(id, { ignoreACL: true }) : undefined;
        const updated: T = await super.update(id, obj, req, user);

        if (existing && existing.folderUid !== updated.folderUid) {
            await this.revokeShareTokenAccess(existing.folderUid, existing.token);
        }
        await this.grantShareTokenAccess(updated);

        return updated;
    }

    public async delete(
        @Param("id") id: string,
        @Query("version") version: string | undefined,
        @Query("purge") purge: string | undefined,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<void> {
        const existing: T | undefined = this.repoUtils ? await this.repoUtils.findOne(id, { ignoreACL: true }) : undefined;
        await super.delete(id, version, purge, req, user);
        if (existing) {
            await this.revokeShareTokenAccess(existing.folderUid, existing.token);
        }
    }
}
