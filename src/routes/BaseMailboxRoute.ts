///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators, UserUtils, type JWTUser } from "@rapidrest/core";
import { ACLAction, ApiErrorMessages, ApiErrors, CRUDRoute, HttpRequest, HttpResponse, RouteDecorators } from "@rapidrest/service-core";
import { Mailbox } from "../models/types.js";
const { Param, Query, Request, Response, User: AuthUser } = RouteDecorators;
const { Config } = ObjectDecorators;

/**
 * Extends the standard `CRUDRoute` CRUD scaffolding for `Mailbox` with ACL-driven `find`/`count` overrides,
 * plus a `create` override that bypasses the ACL system entirely. `Mailbox` has a real per-record
 * `AccessControlList` (`@Protect(..., true)`; see the architecture note on `Message.mailboxUid`), whose
 * class-level ACL denies EVERY action to non-trusted callers, including `CREATE`.
 *
 * `create` is deliberately NOT gated by the class-level ACL at all (unlike every other action): provisioning a
 * brand-new mailbox is a pure self-service action (any authenticated user may create their own) with no parent
 * resource to check permission against — `RepoUtils.create()`'s own automatic owner-grant logic is what
 * actually scopes the new mailbox to its creator, not a class-level check. A class-level `CREATE` grant to
 * `.*` was tried first and found to leak: every mailbox's own ACL falls back to that SAME class ACL as its
 * parent whenever a caller has no mailbox-specific record, so *any* authenticated user calling
 * `ACLUtils.hasPermission(user, someOtherMailboxUid, CREATE)` (e.g. `BaseFolderRoute.create()` checking
 * permission to create a folder *in* that mailbox) would incorrectly pass too. Denying `CREATE` at the class
 * level entirely, and having this route check only `user` truthiness before bypassing ACL, closes that leak.
 *
 * A non-trusted caller's `ownerUserUid` is always forced to their own uid, discarding whatever the client
 * sent — self-service creation can only ever create a mailbox *for yourself*. Only a trusted caller may create
 * a mailbox with a different (or no) `ownerUserUid` — the latter is a true ownerless "shared mailbox" (the
 * Exchange concept, e.g. `support@example.com`) with no single owner, only delegates added afterward via
 * `BaseACLRoute` (`@rapidrest/service-core`). `RepoUtils.create()`'s automatic owner-grant is already
 * conditioned on the creator lacking a trusted role, so a trusted caller creating an ownerless mailbox does
 * not, on its own, leave behind a stray self-grant for the admin who happened to create it.
 *
 * `find`/`count` still need overriding despite the real per-record ACL: `RepoUtils.find()`/`count()` both
 * check the class-level ACL as an unconditional first gate *before* any per-record narrowing, and even that
 * later per-record narrowing falls back to the class grant for a record with no caller-specific entry —
 * verified by reading their source. Rather than the old ownership-only (`ownerUserUid: user.uid`) scoping,
 * these now query for every mailbox uid the caller has *any* ACL grant on — owned, shared-with-them as a
 * delegate, or (for a trusted caller) every mailbox unfiltered — via `findAccessibleMailboxUids()`, backed by
 * the exact same `AccessControlList` model `BaseACLRoute` exposes as CRUD (no new API surface). `exists`
 * doesn't need this treatment: it fetches the specific record first (bypassing ACL) and then checks
 * permission against *that record's own* uid via `ACLUtils.hasPermission`, which already resolves ownership,
 * delegate shares, and trusted-role access correctly on its own — see `exists()` below, unchanged.
 * `findById`/`update`/`delete` are unaffected for the same reason: `RepoUtils.findOne()`/`update()`/
 * `delete()` check the *record's own* resolved ACL chain directly (no class-level fast-fail), so once the
 * class-level grant is denied, that chain correctly resolves to "deny" for a caller with no grant and "allow"
 * for the owner or any delegate — `CRUDRoute`'s default behavior for those already works correctly and is
 * left untouched.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseMailboxRoute<T extends Mailbox> extends CRUDRoute<T> {
    @Config("trusted_roles", ["admin"])
    protected trustedRoles: string[] = ["admin"];

    /**
     * Returns the uids of every mailbox this user has any ACL grant on — as owner, as a shared delegate, or
     * (implicitly, via a wildcard/role record) as a trusted caller. Backend-specific because
     * `AccessControlList`'s storage shape differs (a natively queryable embedded array in Mongo vs. a
     * `simple-json` column in SQL) — implemented by the concrete `MailboxRouteMongo`/`MailboxRouteSQL`
     * subclass, each against the exact same `AccessControlList` collection/table `BaseACLRoute` exposes.
     */
    protected abstract findAccessibleMailboxUids(user: JWTUser): Promise<string[]>;

    public async create(obj: T | T[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T | T[]> {
        if (!user) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        const isTrusted: boolean = UserUtils.hasRoles(user, this.trustedRoles);
        const objs: T[] = Array.isArray(obj) ? obj : [obj];
        if (!isTrusted) {
            for (const o of objs) {
                (o as any).ownerUserUid = user.uid;
            }
        }
        if (Array.isArray(obj)) {
            return await this.doBulkCreate(objs, { req, user, ignoreACL: true });
        }
        return await this.doCreateObject(objs[0], { req, user, ignoreACL: true });
    }

    public async find(@Param() params: any, @Query() query: any, @AuthUser user?: JWTUser): Promise<T[]> {
        if (!this.repoUtils || !user) {
            return [];
        }
        const isTrusted: boolean = UserUtils.hasRoles(user, this.trustedRoles);
        let scopedQuery: any = { ...query, ...params };
        if (!isTrusted) {
            const accessibleUids: string[] = await this.findAccessibleMailboxUids(user);
            // An empty array must short-circuit rather than be passed through as a query filter value: the
            // underlying query builder "zips" an array filter value's *last* element onto any query branch
            // past its own length, so an empty array resolves to `undefined` for that field — which TypeORM
            // (and this builder) treats as "no filter on this field", not "match nothing". Passing it through
            // would incorrectly return every mailbox to a caller who is entitled to see none.
            if (accessibleUids.length === 0) {
                return [];
            }
            scopedQuery = { ...scopedQuery, uid: accessibleUids };
        }
        return await this.repoUtils.find(scopedQuery, {
            limit: query?.limit,
            page: query?.page,
            version: query?.version,
            user,
            ignoreACL: true,
        });
    }

    public async count(
        @Param() params: any,
        @Query() query: any,
        @Response res: HttpResponse,
        @AuthUser user?: JWTUser,
    ): Promise<any> {
        if (!this.repoUtils || !user) {
            return res.status(200).setHeader("content-length", 0);
        }
        const isTrusted: boolean = UserUtils.hasRoles(user, this.trustedRoles);
        let scopedQuery: any = { ...query, ...params };
        if (!isTrusted) {
            const accessibleUids: string[] = await this.findAccessibleMailboxUids(user);
            // See the identical short-circuit (and its rationale) in `find()` above.
            if (accessibleUids.length === 0) {
                return res.status(200).setHeader("content-length", 0);
            }
            scopedQuery = { ...scopedQuery, uid: accessibleUids };
        }
        const result: number = await this.repoUtils.count(scopedQuery, {
            limit: query?.limit,
            page: query?.page,
            version: query?.version,
            user,
            ignoreACL: true,
        });
        return res.status(200).setHeader("content-length", result);
    }

    public async exists(
        @Param("id") id: string,
        @Query() query: any,
        @Response res: HttpResponse,
        @AuthUser user?: JWTUser,
    ): Promise<any> {
        if (!this.repoUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const existing: T | undefined = await this.repoUtils.findOne(id, {
            version: query?.version,
            includeDeleted: query?.deleted === true || query?.deleted === "true",
            ignoreACL: true,
        });
        const permitted: boolean = existing
            ? await this.aclUtils!.hasPermission(user, existing.uid, ACLAction.EXISTS)
            : false;
        return permitted
            ? res.status(200).setHeader("content-length", 1)
            : res.status(404).setHeader("content-length", 0);
    }
}
