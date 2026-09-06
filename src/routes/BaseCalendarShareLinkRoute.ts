///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { type JWTUser } from "@rapidrest/core";
import { HttpRequest, RouteDecorators, type AccessControlList, type UpdateObject } from "@rapidrest/service-core";
import { BaseScopedChildRoute } from "./BaseScopedChildRoute.js";
import { CalendarShareLink } from "../models/types.js";
const { Param, Query, Request, User: AuthUser } = RouteDecorators;

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
 * folder's `AccessControlList` (`{userOrRoleId: token, actions: permittedActions}`) — granted on create,
 * re-granted (upserted, picking up any `permittedActions`/`folderUid` change) on update, and revoked on
 * delete. `ExternalShareExpirationJob` does the same revocation for links it GCs after they expire.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseCalendarShareLinkRoute<T extends CalendarShareLink> extends BaseScopedChildRoute<T> {
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
            ...acl.records.filter((record) => record.userOrRoleId !== link.token),
            { userOrRoleId: link.token, actions: link.permittedActions },
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
        const records = acl.records.filter((record) => record.userOrRoleId !== token);
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
