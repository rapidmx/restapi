///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, type JWTUser } from "@rapidrest/core";
import {
    ACLAction,
    ApiErrorMessages,
    ApiErrors,
    BaseEntity,
    CRUDRoute,
    HttpRequest,
    HttpResponse,
    RouteDecorators,
    type UpdateObject,
} from "@rapidrest/service-core";
const { Delete, Get, Head, Param, Post, Put, Query, Request, Response, User: AuthUser } = RouteDecorators;

/**
 * Resolves an unauthenticated caller's `?shareToken=` query parameter into a synthetic, ACL-checkable identity
 * (`uid` = the token itself) when no real authenticated `user` is present — see `BaseScopedChildRoute`'s own
 * doc comment for the full explanation of the mechanism this is one half of. Kept as a small private function
 * duplicated in `BaseScopedChildRoute.ts`/`BaseFolderRoute.ts` (identical in both), rather than a shared
 * `util/` module, deliberately: `ClassLoader` (see `@rapidrest/core`) scans and dynamically `import()`s an
 * entire test-fixture directory's files concurrently via `Promise.all`, and a brand-new leaf module reached
 * for the very first time by *several* of those concurrent imports at once triggered a real, repeatable
 * `"Class extends value undefined"` failure under Vitest's module transform — the same class of "concurrent
 * first dynamic import of the same module can resolve inconsistently" issue already documented on
 * `ConnectionManager.connect()`'s sequential-redis-connection comment. Duplicating these few lines avoids ever
 * introducing that new shared module into the concurrently-scanned graph.
 */
function resolveEffectiveUser(user: JWTUser | undefined, query: any): JWTUser | undefined {
    if (user) {
        return user;
    }
    const shareToken: unknown = query?.shareToken;
    return typeof shareToken === "string" && shareToken.length > 0
        ? ({ uid: shareToken, roles: [], scopes: [] })
        : undefined;
}

/**
 * Base CRUD route for any entity that has no `AccessControlList` of its own and is instead permission-checked
 * against a named "scope" field it carries — `folderUid` for most entities (`Message`, `CalendarEvent`,
 * `Task`, `Note`, `Contact`, `Attachment`, `CalendarShareLink`), or `mailboxUid` for the one entity with no
 * folder to belong to (`ContactList`). See the architecture note on `Message.mailboxUid` in `models/types.ts`
 * for the full rationale, and `BaseFolderRoute` for `Folder`'s own (different) pattern.
 *
 * Concrete subclasses set `scopeProperty` to the field name to scope by; everything else is generic. A
 * `mailboxUid`-scoped concrete class still works identically here since `ACLUtils.hasPermission` resolves any
 * uid to its `AccessControlList` regardless of which kind of entity that uid actually names.
 *
 * IMPORTANT implementation note: this class deliberately does NOT delegate to `ModelRoute`'s `doFind`/
 * `doCount`/`doFindById`/`doDelete`/`doTruncate`/`doUpdate` helpers, even though `CRUDRoute` (which this
 * extends) normally does. Those helpers' own internal `RepoUtils.find`/`findOne`/`count`/`truncate` calls do
 * NOT forward an `ignoreACL: true` passed into the helper's `options` down to that internal call — verified by
 * reading their source — so calling them after establishing permission below would still hit this library's
 * deny-by-default class-level ACL and fail. `doCreateObject`/`doBulkCreate` are the exception (verified safe:
 * they forward `options`, `ignoreACL` included, straight through to `RepoUtils.create()`), so `create()` still
 * uses them. Every other operation calls `this.repoUtils` directly instead.
 *
 * Read-shaped denials (`find`/`count`/`exists`/`findById`) fail quietly (an empty result / zero count / `404`)
 * rather than `403`, so a caller with no access can't distinguish "records exist but you can't see them" from
 * "nothing matches". Write-shaped denials (`create`/`update`/`delete`/`truncate`/`updateProperty`) return
 * `403`, since the caller already knows the target scope/record they were trying to act on.
 *
 * Read-shaped methods also resolve an unauthenticated caller's `?shareToken=` query param via the local
 * `resolveEffectiveUser()` helper below before checking permission — this, together with
 * `BaseCalendarShareLinkRoute` keeping a real `ACLRecord` for each link's token in sync on the shared folder's
 * `AccessControlList`, is the entire mechanism behind anonymous `CalendarShareLink` consumption. There is no
 * separate route or lookup for it: a share link's token is checked by `ACLUtils.hasPermission()` exactly the
 * same way any other uid is, through these same `find`/`count`/`exists`/`findById` methods every other caller
 * already uses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseScopedChildRoute<T extends BaseEntity> extends CRUDRoute<T> {
    /** The property name on `T` (and on incoming create bodies / list query params) to check permission by. */
    protected abstract readonly scopeProperty: string;

    private scopeUidOf(obj: any): string | undefined {
        return obj?.[this.scopeProperty];
    }

    private async requirePermission(scopeUid: string | undefined, user: JWTUser | undefined, action: string): Promise<void> {
        if (!scopeUid || !(await this.aclUtils!.hasPermission(user, scopeUid, action))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
    }

    /**
     * Publishes live-update notifications (see `push/MailPushRoute.ts`) for create/update/delete on this entity
     * type. Channels are bare `folderUid`/`mailboxUid` values, matching every other permission check in this
     * class — a webmail client subscribed to a folder it can read sees every mutation of a record scoped to it.
     * `this.notificationUtils` is inherited from `ModelRoute` (`@Inject(NotificationUtils)` there already) —
     * publishing is fire-and-forget (see `NotificationUtils.sendMessage()`) and never blocks or fails a request.
     */
    private notify(scopeUid: string | undefined, action: "create" | "update" | "delete", data: any): void {
        /* v8 ignore else -- unreachable via real usage: every call site derives `scopeUid` from a record that
           already passed `requirePermission()` (which throws on a falsy scope) earlier in the same method, so
           it is always truthy by the time `notify()` runs. The `string | undefined` parameter type (matching
           `scopeUidOf()`'s own return type) is what requires this guard to typecheck, not a real code path. */
        if (scopeUid) {
            this.notificationUtils?.sendMessage(scopeUid, this.modelClass.name, action, data);
        }
    }

    @Head()
    public async count(
        @Param() params: any,
        @Query() query: any,
        @Response res: HttpResponse,
        @AuthUser user?: JWTUser,
    ): Promise<any> {
        if (!this.repoUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const scopeUid: string | undefined = this.scopeUidOf(query);
        if (!scopeUid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }
        if (!(await this.aclUtils!.hasPermission(resolveEffectiveUser(user, query), scopeUid, ACLAction.COUNT))) {
            return res.status(200).setHeader("content-length", 0);
        }
        // `shareToken` is consumed above by `resolveEffectiveUser()` for permission resolution only - it names
        // no field on `T`, so it must not be forwarded into the data filter below (SQL: an unknown-column
        // error; Mongo: a `$match` no real document ever satisfies, silently returning zero results either way).
        const { shareToken: _shareToken, ...filterQuery } = query ?? {};
        const result: number = await this.repoUtils.count(
            { ...filterQuery, ...params },
            { limit: query?.limit, page: query?.page, version: query?.version, user, ignoreACL: true },
        );
        return res.status(200).setHeader("content-length", result);
    }

    @Post()
    public async create(obj: T | T[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T | T[]> {
        const objs: T[] = Array.isArray(obj) ? obj : [obj];
        for (const single of objs) {
            await this.requirePermission(this.scopeUidOf(single), user, ACLAction.CREATE);
        }
        if (Array.isArray(obj)) {
            const created: T[] = await this.doBulkCreate(obj, { req, user, ignoreACL: true });
            for (const single of created) {
                this.notify(this.scopeUidOf(single), "create", single);
            }
            return created;
        }
        const created: T = await this.doCreateObject(obj, { req, user, ignoreACL: true });
        this.notify(this.scopeUidOf(created), "create", created);
        return created;
    }

    @Delete("/:id")
    public async delete(
        @Param("id") id: string,
        @Query("version") version: string | undefined,
        @Query("purge") purge: string | undefined,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<void> {
        if (!this.repoUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const existing: T | undefined = await this.repoUtils.findOne(id, { version, ignoreACL: true });
        if (!existing) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        await this.requirePermission(this.scopeUidOf(existing), user, ACLAction.DELETE);
        await this.repoUtils.delete(existing.uid, { user, version, purge: purge === "true", ignoreACL: true });
        this.notify(this.scopeUidOf(existing), "delete", { uid: existing.uid });
    }

    @Head("/:id")
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
        const scopeUid: string | undefined = existing ? this.scopeUidOf(existing) : undefined;
        const permitted: boolean = scopeUid
            ? await this.aclUtils!.hasPermission(resolveEffectiveUser(user, query), scopeUid, ACLAction.EXISTS)
            : false;
        return permitted
            ? res.status(200).setHeader("content-length", 1)
            : res.status(404).setHeader("content-length", 0);
    }

    @Get()
    public async find(@Param() params: any, @Query() query: any, @AuthUser user?: JWTUser): Promise<T[]> {
        if (!this.repoUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const scopeUid: string | undefined = this.scopeUidOf(query);
        if (!scopeUid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }
        if (!(await this.aclUtils!.hasPermission(resolveEffectiveUser(user, query), scopeUid, ACLAction.LIST))) {
            return [];
        }
        // See the identical `shareToken` exclusion (and its rationale) in `count()` above.
        const { shareToken: _shareToken, ...filterQuery } = query ?? {};
        return await this.repoUtils.find(
            { ...filterQuery, ...params },
            { limit: query?.limit, page: query?.page, version: query?.version, user, ignoreACL: true },
        );
    }

    @Get("/:id")
    public async findById(@Param("id") id: string, @Query() query: any, @AuthUser user?: JWTUser): Promise<T | null> {
        if (!this.repoUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const existing: T | undefined = await this.repoUtils.findOne(id, {
            version: query?.version,
            includeDeleted: query?.deleted === true || query?.deleted === "true",
            ignoreACL: true,
        });
        const scopeUid: string | undefined = existing ? this.scopeUidOf(existing) : undefined;
        if (!scopeUid || !(await this.aclUtils!.hasPermission(resolveEffectiveUser(user, query), scopeUid, ACLAction.READ))) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        return existing!;
    }

    @Delete()
    public async truncate(@Param() params: any, @Query() query: any, @AuthUser user?: JWTUser): Promise<void> {
        if (!this.repoUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        await this.requirePermission(this.scopeUidOf(query), user, ACLAction.TRUNCATE);
        await this.repoUtils.truncate(
            { ...query, ...params },
            { limit: query?.limit, page: query?.page, version: query?.version, user, ignoreACL: true },
        );
    }

    @Put("/:id")
    public async update(
        @Param("id") id: string,
        obj: UpdateObject<T>,
        @Request req?: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        if (!this.repoUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const existing: T | undefined = await this.repoUtils.findOne(id, { skipCache: true, ignoreACL: true });
        if (!existing) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        await this.requirePermission(this.scopeUidOf(existing), user, ACLAction.UPDATE);

        // `obj` is client-supplied and `scopeProperty` (`folderUid`/`mailboxUid`) is an ordinary, writable field
        // on every entity this class serves - none of them mark it `@ReadOnly`, since a folder/mailbox transfer
        // (e.g. moving a Message between folders) is legitimate functionality, not something to block outright.
        // But the check above only establishes permission on the record's CURRENT scope; without also checking
        // the NEW one, a caller with UPDATE access to their own folder could silently re-parent any record they
        // can already reach into a folder/mailbox they have no access to at all (or vice versa: pull a record
        // OUT of a folder they don't own but happen to know the uid of, into their own), completely bypassing
        // the scope-based permission model this route family exists to enforce - equivalent to planting
        // attacker-controlled content directly into a victim's mailbox, bypassing ingestion/scanning entirely
        // for entities like `Message`/`Attachment`.
        const newScopeUid: string | undefined = this.scopeUidOf(obj);
        if (newScopeUid !== undefined && newScopeUid !== this.scopeUidOf(existing)) {
            await this.requirePermission(newScopeUid, user, ACLAction.CREATE);
        }

        await this.validate(obj, { user });
        const updated: T = await this.repoUtils.update(obj, existing, { user, ignoreACL: true });

        // Notify the record's new scope always, and its OLD scope too if this update re-parented it - a
        // client subscribed to the folder the record just left needs to know it's gone from their view, not
        // just that it appeared somewhere else.
        const oldScopeUid: string | undefined = this.scopeUidOf(existing);
        const updatedScopeUid: string | undefined = this.scopeUidOf(updated);
        this.notify(updatedScopeUid, "update", updated);
        if (newScopeUid !== undefined && oldScopeUid !== updatedScopeUid) {
            this.notify(oldScopeUid, "delete", { uid: updated.uid });
        }

        return updated;
    }

    @Put()
    public async updateBulk(obj: UpdateObject<T>[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T[]> {
        const results: T[] = [];
        for (const single of obj) {
            results.push(await this.update(single.uid, single, req, user));
        }
        return results;
    }

    @Put("/:id/:property")
    public async updateProperty(
        @Param("id") id: string,
        @Param("property") propertyName: string,
        obj: any,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        if (!this.repoUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const existing: T | undefined = await this.repoUtils.findOne(id, { ignoreACL: true });
        if (!existing) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        return await this.update(
            id,
            { uid: existing.uid, version: (existing as any).version, [propertyName]: obj } as any,
            undefined,
            user,
        );
    }
}
