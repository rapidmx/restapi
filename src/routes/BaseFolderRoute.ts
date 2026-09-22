///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, UserUtils, type JWTUser } from "@rapidrest/core";
import {
    ACLAction,
    ApiErrorMessages,
    ApiErrors,
    CRUDRoute,
    HttpRequest,
    HttpResponse,
    ModelUtils,
    RepoUtils,
    RouteDecorators,
    type UpdateObject,
} from "@rapidrest/service-core";
import type { CalendarShareLink, Folder } from "../models/types.js";
import { countMessagesByFolder, healStoredFolderCounts } from "../util/FolderCountUtils.js";
import { ensureWellKnownFolders } from "../util/FolderUtils.js";
import { hasMailAccess, stripTrustedRoles } from "../util/MailAccessUtils.js";
import { assertNoPathKeys, assertPlainPropertyName, stripClientCreateFields, stripClientId } from "../util/RequestBodyUtils.js";
const { Get, Head, Param, Post, Query, Request, Response, User: AuthUser } = RouteDecorators;

/** See the identical constants (and why they're duplicated rather than shared) on `BaseScopedChildRoute.ts`. */
const SHARE_TOKEN_UID_PREFIX = "share:";
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** `Folder` fields only server-side code maintains (the counters - derived from the messages, see
 * `util/FolderCountUtils.ts` - and the EAS sync key), plus `mailboxUid`, which is the folder's ACL parent and so
 * can't be moved to another mailbox by a client. */
const SERVER_MANAGED_FOLDER_FIELDS = ["unreadCount", "totalCount", "syncKeyVersion", "mailboxUid"] as const;

/** See `stripUnsafeQueryKeys()` on `BaseScopedChildRoute.ts`. */
function stripUnsafeQueryKeys(query: any): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(query ?? {})) {
        if (key === "shareToken" || key === "scope" || key.split(".").some((segment) => segment.startsWith("$"))) {
            continue;
        }
        result[key] = value;
    }
    return result;
}

/**
 * Extends the standard `CRUDRoute` CRUD scaffolding for `Folder` with a hybrid permission model — `Folder` is
 * one of the two entities in this library with a real per-record `AccessControlList` (the other is `Mailbox`;
 * see the architecture note on `Message.mailboxUid` in `models/types.ts`), so most of `CRUDRoute`'s default
 * behavior already works correctly and is left untouched here:
 *
 * - `findById`/`update`/`delete`/`truncate` rely on `Folder`'s own record-level ACL, which by default inherits
 * (via `AccessControlList.parentUid`) from its owning `Mailbox`'s ACL — so anyone the mailbox is shared with
 * automatically gets the same access to its folders, while a single folder (e.g. one Calendar) can still be
 * shared more narrowly by adding records directly to *that folder's own* ACL instead. `RepoUtils.findOne()`/
 * `update()`/`delete()` check the record's own resolved ACL chain directly (no class-level fast-fail), so
 * this works correctly once the class-level grant is denied; `truncate()` skips its class-level check
 * entirely whenever `recordACL` is `true` (verified by reading its source) and relies on per-record
 * filtering instead, which is equally safe here for the same reason.
 * - `find`/`count`/`exists` are overridden here, for the same reason every other collection-or-fast-fail-gated
 * operation in this library is: `RepoUtils.find()`/`count()`/`exists()` all check the class-level ACL as an
 * unconditional first gate — before any per-record narrowing, and even that later narrowing falls back to
 * the class grant for a record with no caller-specific entry — so a per-record ACL alone can't safely narrow
 * them once class-level access is granted to anyone. `find`/`count` take an explicit `mailboxUid` query
 * parameter and check permission against it directly; `exists` fetches the specific folder first (bypassing
 * ACL) and then checks permission against *that folder's own* uid (i.e. its real resolved ACL chain), same
 * as `findById` does implicitly.
 * - `create` is also overridden, for a different reason: it seeds the new folder's ACL with `parentUid` set to
 * the owning mailbox's ACL uid, which is what wires up the inheritance described above — this can't be done
 * generically by `RepoUtils.create()`'s own default (it would parent to the `Folder` class ACL instead, which
 * is deny-all and grants nothing) — and, since a folder doesn't exist yet at create time, permission is
 * checked against the target `mailboxUid` from the request body instead. It also publishes a live-update
 * notification (see `push/MailPushRoute.ts`) to the owning mailbox's channel, so a webmail client subscribed
 * to a mailbox sees new folders appear without polling.
 *
 * `exists` also resolves an unauthenticated caller's `?shareToken=` query param via `resolveEffectiveUser()` below,
 * when `shareLinkClass` is set (see `BaseScopedChildRoute`'s doc comment for the full mechanism). `find`/`count`
 * check the owning mailbox, which a folder-scoped link never grants, so they don't consult it.
 *
 * **No role widens access.** An administrator sees the folders of their own mailbox and of mailboxes shared with them,
 * nothing else: every check goes through `hasMailAccess()` and every inherited `CRUDRoute` handler is handed
 * `mailUser()` - the caller with their trusted roles taken away - because `RepoUtils` would otherwise apply the
 * framework's "trusted users always have permission" shortcut (see `util/MailAccessUtils.ts`).
 *
 * `create` always has the server mint `uid` and zero the counters; a non-trusted caller's update can't set the
 * `SERVER_MANAGED_FOLDER_FIELDS`.
 *
 * **`unreadCount`/`totalCount` are derived, never trusted from storage.** Every folder these routes return (`find`,
 * `findById`, and the responses of `update`/`updateBulk`/`updateProperty`) carries the counts of the folder's messages
 * as they are right now - the messages not soft-deleted, of which those whose `flags.read` isn't `true` are unread,
 * i.e. exactly what the message list shows - computed with ONE grouped query for the whole request
 * (`countMessagesByFolder()`, `util/FolderCountUtils.ts`), never one per folder. A stored value that disagrees is
 * overwritten with the derived one on the way out (best-effort), so a reader that goes to the `Folder` row directly
 * (`@rapidmx/mapi-plugin`) converges too. Needs `messageClass`; a subclass that doesn't set it answers with the stored
 * counts. The live `{ action: "update", data: { uid, mailboxUid, unreadCount, totalCount } }` event published when a
 * message write changes a folder's counts is described in `util/FolderCountUtils.ts`.
 *
 * **Every mailbox has every well-known folder.** `find` (which always names a `mailboxUid`) and `findById` first make
 * sure the mailbox the caller is allowed to list has all of them (`ensureWellKnownFolders()`, `util/FolderUtils.ts`):
 * one existence query per request, nothing written when the set is complete, best-effort (a failure is logged and the
 * read goes on). This is how a mailbox created before its folders were all provisioned at creation (or one that never
 * got some) heals, with no migration. The mailbox's access is checked first (`hasMailAccess()`), so a caller can never
 * make folders appear in a mailbox they can't list.
 *
 * **Live events** (channels: the folder's uid and its mailbox's uid; `type` is the concrete class name, `FolderMongo` or
 * `FolderSQL`): `create` carries the folder (`{ uid, mailboxUid, type, name, unreadCount, totalCount, ... }`) - published
 * for every folder created, client-made or server-made (`findOrCreateWellKnownFolder()`); `update` carries either the
 * counts only (`{ uid, mailboxUid, unreadCount, totalCount }`, `util/FolderCountUtils.ts`) or, when a client changed the
 * folder itself (a rename, a move), the whole folder; `delete` carries `{ uid, mailboxUid, version }`. Bulk `truncate` is
 * not published (it is not available to a mailbox user at all).
 *
 * KNOWN LIMITATIONS:
 * - `findById` (also left on `CRUDRoute`'s default) does NOT resolve `?shareToken=` — a share link's token
 * grants read access to the folder's *children* (e.g. its `CalendarEvent`s, via `BaseScopedChildRoute`), not
 * to fetching the `Folder` record itself by id. A client wanting the calendar's display name alongside its
 * events would need that carried elsewhere (e.g. denormalized onto `CalendarShareLink`), not fetched via this
 * route with a token.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseFolderRoute<T extends Folder> extends CRUDRoute<T> {
    /** The concrete `CalendarShareLink` model class, so `exists()` can resolve `?shareToken=`. Unset: tokens are ignored. */
    protected shareLinkClass?: any;

    /** The concrete `Message` class (supplied by the Mongo/SQL subclasses), whose rows the folder counts are derived from.
     * Unset: the stored counts are returned as they are. */
    protected messageClass?: any;

    private shareLinkRepo?: RepoUtils<CalendarShareLink>;

    private messageRepo?: RepoUtils<any>;

    /** Whether `user` holds `action` on `uid` (a mailbox or folder uid) by ownership or an ACL record - never by a
     * trusted role. */
    protected hasMailAccess(user: JWTUser | undefined, uid: string, action: string): Promise<boolean> {
        return hasMailAccess(this.aclUtils, this.trustedRoles, user, uid, action);
    }

    /** `user` without its trusted roles, for the inherited handlers (`RepoUtils` treats a trusted caller as a superuser). */
    protected mailUser(user: JWTUser | undefined): JWTUser | undefined {
        return stripTrustedRoles(user, this.trustedRoles);
    }

    /**
     * Gives `mailboxUid` every well-known folder it lacks (`ensureWellKnownFolders()`) - only when `user` may list that
     * mailbox (`checkAccess`, for a caller that hasn't been checked against it yet) - best-effort: a failure is logged and
     * the read it belongs to goes on without it.
     */
    private async healWellKnownFolders(mailboxUid: string, user: JWTUser | undefined, checkAccess: boolean): Promise<void> {
        try {
            if (!checkAccess || (await this.hasMailAccess(user, mailboxUid, ACLAction.LIST))) {
                await ensureWellKnownFolders(this.repoUtils!, this.modelClass, mailboxUid);
            }
        } catch (err: any) {
            this.logger?.warn(`${this.modelClass.name}: could not provision the well-known folders of mailbox '${mailboxUid}': ${err?.message}`);
        }
    }

    /** Publishes `data` as `action` on `folder`'s mailbox's channel (the folder's own channel is `RepoUtils`'s to publish
     * on, for the writes it performs). Fire-and-forget: `NotificationUtils` never lets a broadcast failure surface. */
    private publishToMailbox(folder: { mailboxUid?: string }, action: string, data: unknown): void {
        if (folder.mailboxUid) {
            this.notificationUtils?.sendMessage(folder.mailboxUid, this.modelClass.name, action, data);
        }
    }

    /**
     * Replaces the counts of every folder in `folders` with the ones derived from its messages (see this class's doc
     * comment) - one grouped query for all of them - and refreshes the stored cache of any that disagreed.
     */
    private async applyDerivedCounts(folders: T[]): Promise<void> {
        if (!this.messageClass || folders.length === 0) {
            return;
        }
        if (!this.messageRepo) {
            this.messageRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.messageClass.name,
                args: [this.messageClass],
            });
        }
        const counts = await countMessagesByFolder(this.messageRepo, folders.map((folder) => folder.uid));
        await healStoredFolderCounts(this.repoUtils!, folders, counts);
        for (const folder of folders) {
            const derived = counts.get(folder.uid)!;
            folder.unreadCount = derived.unreadCount;
            folder.totalCount = derived.totalCount;
        }
    }

    /** See `BaseScopedChildRoute.resolveEffectiveUser()` - identical, for a link whose `folderUid` is `folderUid`. */
    private async resolveEffectiveUser(user: JWTUser | undefined, query: any, folderUid: string): Promise<JWTUser | undefined> {
        if (user) {
            return user;
        }
        const token: unknown = query?.shareToken;
        if (!this.shareLinkClass || typeof token !== "string" || !SHARE_TOKEN_PATTERN.test(token)) {
            return undefined;
        }
        if (!this.shareLinkRepo) {
            this.shareLinkRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.shareLinkClass.name,
                args: [this.shareLinkClass],
            });
        }
        const links: CalendarShareLink[] = await this.shareLinkRepo.find({ token: ModelUtils.literal(token), limit: 1 } as any, {
            ignoreACL: true,
            limit: 1,
        });
        const link: CalendarShareLink | undefined = links[0];
        if (!link || link.token !== token || link.folderUid !== folderUid) {
            return undefined;
        }
        if (link.expiresAt && !(new Date(link.expiresAt).getTime() > Date.now())) {
            return undefined;
        }
        return { uid: `${SHARE_TOKEN_UID_PREFIX}${token}`, roles: [], scopes: [] };
    }

    /** Whether `user` may see soft-deleted folders under `aclUid`: DELETE and UPDATE there (see
     * `BaseScopedChildRoute.canViewDeleted()`). */
    private async canViewDeleted(user: JWTUser | undefined, aclUid: string): Promise<boolean> {
        return (
            (await this.hasMailAccess(user, aclUid, ACLAction.DELETE)) &&
            (await this.hasMailAccess(user, aclUid, ACLAction.UPDATE))
        );
    }

    /** The list filter for `find()`/`count()`: the client query can't widen the checked mailbox (see
     * `stripUnsafeQueryKeys()`), and a `deleted` filter is dropped unless `user` may view deleted folders. */
    private async listFilter(params: any, query: any, mailboxUid: string, user: JWTUser | undefined): Promise<any> {
        const filter: any = { ...stripUnsafeQueryKeys(query), ...params, mailboxUid: ModelUtils.literal(mailboxUid) };
        if ("deleted" in filter && !(await this.canViewDeleted(user, mailboxUid))) {
            delete filter.deleted;
        }
        return filter;
    }

    /** Drops `SERVER_MANAGED_FOLDER_FIELDS` from a non-trusted caller's update patch. */
    private stripServerManagedFields(obj: Record<string, any>, user: JWTUser | undefined): void {
        if (user && UserUtils.hasRoles(user, this.trustedRoles)) {
            return;
        }
        for (const field of SERVER_MANAGED_FOLDER_FIELDS) {
            delete obj[field];
        }
    }

    /** Runs for `update()` (via its `@Validate`) and each element of `updateBulk()` - the patch is persisted by reference. */
    protected async validateUpdate(id: string, obj: UpdateObject<T>, user?: JWTUser): Promise<void> {
        // Dotted/`$` keys are Mongo update paths past this check - see `util/RequestBodyUtils.ts`.
        assertNoPathKeys(obj);
        stripClientId(obj);
        this.stripServerManagedFields(obj as Record<string, any>, user);
        return super.validateUpdate(id, obj, user);
    }

    /** `CRUDRoute.updateProperty()` validates a throwaway wrapper and persists the raw value, so the field check is
     * repeated here against the property itself. */
    public async updateProperty(id: string, propertyName: string, obj: any, user?: JWTUser): Promise<T> {
        assertPlainPropertyName(propertyName);
        const patch: Record<string, any> = { [propertyName]: obj };
        this.stripServerManagedFields(patch, user);
        if (!(propertyName in patch)) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, `'${propertyName}' is managed by the server.`);
        }
        const folder: T = await super.updateProperty(id, propertyName, obj, this.mailUser(user));
        await this.applyDerivedCounts([folder]);
        this.publishToMailbox(folder, "update", folder);
        return folder;
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
        const mailboxUid: string | undefined = query?.mailboxUid;
        if (!mailboxUid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }
        if (typeof mailboxUid !== "string" || !(await this.hasMailAccess(user, mailboxUid, ACLAction.COUNT))) {
            return res.status(200).setHeader("content-length", 0);
        }
        const result: number = await this.repoUtils.count(
            await this.listFilter(params, query, mailboxUid, user),
            { limit: query?.limit, page: query?.page, version: query?.version, user, ignoreACL: true },
        );
        return res.status(200).setHeader("content-length", result);
    }

    @Post()
    public async create(
        obj: Partial<T> | Partial<T>[],
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<T | T[]> {
        if (!this.repoUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const objs: Partial<T>[] = Array.isArray(obj) ? obj : [obj];
        const results: T[] = [];
        for (const raw of objs) {
            const mailboxUid: unknown = raw.mailboxUid;
            // A non-string (`mailboxUid[]=a`) names no single mailbox - refused before anything looks it up.
            if (typeof mailboxUid !== "string" || !mailboxUid || !(await this.hasMailAccess(user, mailboxUid, ACLAction.CREATE))) {
                throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
            }
            // The uid is always server-minted: `RepoUtils.create()` reuses an existing `AccessControlList` whose uid
            // equals the new record's and adds the creator to it with full rights, so a client-chosen uid naming
            // another mailbox (uid = its address), a class ACL (`Mailbox`, `Domain`, ...) or an orphaned folder ACL
            // would hand the caller that ACL. The counters start at zero whatever the body says.
            // `_id` would replace another document on Mongo; `version`/dates and path keys are never the client's.
            const { uid: _uid, ...fields } = stripClientCreateFields({ ...(raw as any) });
            const instance: T = this.repoUtils.instantiateObject({ ...fields, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 });
            const created: T = await this.repoUtils.create(instance, {
                user,
                ignoreACL: true,
                acl: { uid: instance.uid, parentUid: mailboxUid, records: [] },
            });
            this.notificationUtils?.sendMessage(mailboxUid, this.modelClass.name, "create", created);
            results.push(created);
        }
        return Array.isArray(obj) ? results : results[0];
    }

    @Get()
    public async find(@Param() params: any, @Query() query: any, @AuthUser user?: JWTUser): Promise<T[]> {
        if (!this.repoUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const mailboxUid: string | undefined = query?.mailboxUid;
        if (!mailboxUid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }
        if (typeof mailboxUid !== "string" || !(await this.hasMailAccess(user, mailboxUid, ACLAction.LIST))) {
            return [];
        }
        // Already checked against `mailboxUid` just above. Before the read, so what it returns includes anything created.
        await this.healWellKnownFolders(mailboxUid, user, false);
        // The client query can't widen the checked mailbox - see `stripUnsafeQueryKeys()`.
        const folders: T[] = await this.repoUtils.find(
            await this.listFilter(params, query, mailboxUid, user),
            { limit: query?.limit, page: query?.page, version: query?.version, user, ignoreACL: true },
        );
        await this.applyDerivedCounts(folders);
        return folders;
    }

    /** `CRUDRoute.findById()` (the folder's own ACL decides), answering with the derived counts. */
    @Get("/:id")
    public async findById(@Param("id") id: string, @Query() query: any, @AuthUser user?: JWTUser): Promise<T | null> {
        // A folder the caller can't read answers exactly like one that doesn't exist (404), not the framework's own 403.
        if (!(await this.hasMailAccess(user, id, ACLAction.READ))) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        const folder: T | null = await super.findById(id, query, this.mailUser(user));
        if (folder) {
            await this.applyDerivedCounts([folder]);
            await this.healWellKnownFolders(folder.mailboxUid, user, true);
        }
        return folder;
    }

    /** `CRUDRoute.update()`, answering with the derived counts. */
    public async update(id: string, obj: UpdateObject<T>, req: HttpRequest, user?: JWTUser): Promise<T> {
        const folder: T = await super.update(id, obj, req, this.mailUser(user));
        await this.applyDerivedCounts([folder]);
        this.publishToMailbox(folder, "update", folder);
        return folder;
    }

    /** `CRUDRoute.delete()` as `mailUser()`: a folder is deleted by its mailbox's owner or a delegate with DELETE, never by a role. */
    public async delete(id: string, version: string | undefined, purge: string | undefined, req: HttpRequest, user?: JWTUser): Promise<void> {
        // The folder is gone by the time `RepoUtils` publishes its own `delete` (on the folder's channel, `{ uid, version }`), so
        // the mailbox it belonged to is read first for the event on the mailbox's channel.
        const existing: T | undefined = await this.repoUtils?.findOne(id, { ignoreACL: true, includeDeleted: true, skipCache: true });
        await super.delete(id, version, purge, req, this.mailUser(user));
        if (existing) {
            this.publishToMailbox(existing, "delete", { uid: existing.uid, mailboxUid: existing.mailboxUid, version });
        }
    }

    /** `CRUDRoute.truncate()` as `mailUser()`. */
    public async truncate(params: any, query: any, user?: JWTUser): Promise<void> {
        return super.truncate(params, query, this.mailUser(user));
    }

    /** `CRUDRoute.updateBulk()`, answering with the derived counts of every folder. */
    public async updateBulk(obj: UpdateObject<T>[], req: HttpRequest, user?: JWTUser): Promise<T[]> {
        const folders: T[] = await super.updateBulk(obj, req, this.mailUser(user));
        await this.applyDerivedCounts(folders);
        for (const folder of folders) {
            this.publishToMailbox(folder, "update", folder);
        }
        return folders;
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
        const effectiveUser: JWTUser | undefined = existing ? await this.resolveEffectiveUser(user, query, existing.uid) : undefined;
        const permitted: boolean = existing
            ? (await this.hasMailAccess(effectiveUser, existing.uid, ACLAction.EXISTS)) &&
              ((existing as any).deleted !== true || (await this.canViewDeleted(effectiveUser, existing.uid)))
            : false;
        return permitted
            ? res.status(200).setHeader("content-length", 1)
            : res.status(404).setHeader("content-length", 0);
    }
}
