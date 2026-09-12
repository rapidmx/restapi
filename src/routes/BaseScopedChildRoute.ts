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
    /**
     * Hook for a permanent delete to check whether `existing` is protected by an active legal hold
     * (`util/LegalHoldUtils.ts`) before it's irrecoverably destroyed - throws a `409` if so. A no-op by
     * default, so scoped-child entities uninvolved in eDiscovery (`Contact`/`Task`/`Note`/etc.) are
     * unaffected; `BaseMessageRoute` is the one override today, since email is what a `Matter`'s
     * `custodianMailboxUids` actually protects. An ordinary soft-delete never calls this - see `delete()`
     * below. Called for `delete()` only under `purge: true` (the only way that method is irrecoverable),
     * and for EVERY record `truncate()` matches (that method has no `purge` option at all - it is always
     * a hard, permanent delete, see `truncate()`'s own doc comment - so skipping this check there would
     * let a caller destroy held records simply by preferring the bulk endpoint over the equivalent
     * one-at-a-time `delete(..., { purge: true })` calls).
     */
    protected async checkLegalHold(existing: T): Promise<void> {
        // no-op by default
    }

    /**
     * Hook resolving the authoritative `mailboxUid` for a record scoped to `scopeUid` (its `folderUid`) -
     * a no-op (`undefined`) by default, which is already correct for every concrete entity whose
     * `scopeProperty` IS `mailboxUid` (any change to it is already gated by the `newScopeUid` permission
     * check in `update()` below, since it's exactly what that check compares) and for the one
     * `folderUid`-scoped entity with no independent `mailboxUid` field at all (`CalendarShareLink`).
     *
     * Every OTHER `folderUid`-scoped entity also carries its own denormalized `mailboxUid`
     * (`Message`/`Attachment`/`Contact`/`CalendarEvent`/`Task`/`Note` - see the architecture note on
     * `Message.mailboxUid` in `models/types.ts`) and overrides this to resolve it from the actual target
     * folder via `FolderUtils.getMailboxUidForFolder()`, so `create()`/`update()` below can force-set it
     * rather than ever trusting a client-supplied value. Every compliance job that queries or purges by
     * `mailboxUid` (`ErasureExecutionJob`, `RetentionEnforcementJob`, `util/LegalHoldUtils.ts`) treats that
     * field as authoritative - leaving it independently client-writable would let a record silently escape
     * (or be wrongly swept into) an erasure/retention-purge/legal-hold scoped to a mailbox it was never
     * really in, simply by setting `mailboxUid` in a create/update body to something other than its real
     * folder's mailbox.
     */
    protected async resolveMailboxUidFor(scopeUid: string): Promise<string | undefined> {
        return undefined;
    }

    private async enforceMailboxUid(obj: any, scopeUid: string | undefined): Promise<void> {
        /* v8 ignore if -- unreachable via real usage: both call sites (`create()`/`update()`) only reach
           this method after their own `requirePermission()` call already threw on a falsy scope, so
           `scopeUid` is always truthy by the time it gets here. The `string | undefined` parameter type
           (matching `scopeUidOf()`'s own return type) is what requires this guard to typecheck, the same
           reasoning `notify()`'s own identical guard above documents. */
        if (scopeUid === undefined) {
            return;
        }
        const mailboxUid: string | undefined = await this.resolveMailboxUidFor(scopeUid);
        if (mailboxUid !== undefined) {
            obj.mailboxUid = mailboxUid;
        }
    }

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
            await this.enforceMailboxUid(single, this.scopeUidOf(single));
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
        const purgeRequested: boolean = purge === "true";
        if (purgeRequested) {
            await this.checkLegalHold(existing);
        }
        await this.repoUtils.delete(existing.uid, { user, version, purge: purgeRequested, ignoreACL: true });
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

    /** Fetches every page of `repoUtils.find(criteria, ...)` results - a bare, unpaginated `find()` call
     * silently truncates at this framework's own default page size, and `truncate()`'s own legal-hold
     * check below must see every matched record, not a sample - mirrors `ErasureExecutionJob.
     * findAllPages()`'s identical rationale. */
    private async findAllForTruncate(criteria: Record<string, any>, user: JWTUser | undefined, pageSize: number = 500): Promise<T[]> {
        const all: T[] = [];
        for (let page = 0; ; page++) {
            const batch: T[] = await this.repoUtils!.find({ ...criteria, limit: pageSize, page } as any, {
                limit: pageSize,
                page,
                user,
                ignoreACL: true,
            });
            all.push(...batch);
            if (batch.length < pageSize) {
                break;
            }
        }
        return all;
    }

    @Delete()
    public async truncate(@Param() params: any, @Query() query: any, @AuthUser user?: JWTUser): Promise<void> {
        if (!this.repoUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        await this.requirePermission(this.scopeUidOf(query), user, ACLAction.TRUNCATE);
        // `truncate()` is ALWAYS a hard, permanent delete (unlike singular `delete()`, which only purges
        // under `purge: true`) - see `checkLegalHold()`'s own doc comment. Every matched record must be
        // checked, the same protection a caller can't route around by simply preferring this bulk endpoint
        // over the equivalent one-at-a-time `delete(..., { purge: true })` calls.
        const { shareToken: _shareToken, ...filterQuery } = query ?? {};
        const matched: T[] = await this.findAllForTruncate({ ...filterQuery, ...params }, user);
        if (matched.length === 0) {
            return;
        }
        for (const existing of matched) {
            await this.checkLegalHold(existing);
        }
        // Deliberately re-scoped to the EXACT uids just checked, not the original query re-run live -
        // `RepoUtils.truncate()` re-executes its own search query at the moment it runs, independent of
        // `matched` above; passing the original filter through again would let a record that starts
        // matching it in the gap between the snapshot and this call (e.g. a message delivered into the
        // same folder by `ScanQueueJob` while this request is still in flight) be deleted having never
        // been through `checkLegalHold()` at all - the exact protection this override exists to add. A
        // record that only starts matching after this snapshot is simply left for a later truncate() call
        // to pick up (and check), rather than being deleted unchecked by this one.
        await this.repoUtils.truncate(
            { uid: `in(${matched.map((existing) => existing.uid).join(",")})` } as any,
            { user, ignoreACL: true },
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

        // Only pays for a folder lookup when it can actually matter: the folder is genuinely changing (so
        // a denormalized `mailboxUid` may need to move with it), or the client's own body directly names
        // `mailboxUid` (an ordinary no-op re-send of the existing value, or an attempt to set it to
        // something else entirely - `resolveMailboxUidFor()`'s doc comment explains why that must never be
        // trusted). An update that touches neither skips this entirely, same cost as before this fix.
        if (newScopeUid !== undefined || "mailboxUid" in (obj as any)) {
            await this.enforceMailboxUid(obj, newScopeUid !== undefined ? newScopeUid : this.scopeUidOf(existing));
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
