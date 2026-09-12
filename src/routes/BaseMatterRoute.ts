///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, type JWTUser } from "@rapidrest/core";
import {
    ApiErrorMessages,
    ApiErrors,
    CRUDRoute,
    HttpRequest,
    HttpResponse,
    RepoUtils,
    RouteDecorators,
    type UpdateObject,
} from "@rapidrest/service-core";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { findHeldScopeIds, requireEscrowHolder } from "../util/EscrowUtils.js";
import { AuditAction, Matter } from "../models/types.js";
const { Head, Param, Post, Query, Request, Response, User: AuthUser } = RouteDecorators;

/** Validates the parts of a `Matter` a client can actually set, against the merged (existing + patch, for
 * `update()`) object - `undefined` fields are left alone (a patch not touching a given field shouldn't
 * fail validation for it). */
function validateMatter(o: Partial<Matter>): void {
    // Shadowed in practice: the framework's own schema validation already rejects an empty `name` (a
    // required, non-`@Nullable` column) before this function ever runs, on both create() and update() -
    // confirmed by a test sending `name: ""` on each, both still 400 but via that upstream path, never
    // this one. Kept for defense in depth (e.g. a future relaxation of the column's own constraint)
    // rather than removed, so this branch stays permanently unreachable under the framework's current
    // validation ordering.
    if (o.name !== undefined && !o.name) {
        /* v8 ignore next */
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "name is required.");
    }
    if (o.custodianMailboxUids !== undefined) {
        const uids = o.custodianMailboxUids;
        if (!Array.isArray(uids) || uids.length === 0 || uids.some((uid) => typeof uid !== "string" || !uid)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "custodianMailboxUids must be a non-empty array of non-empty strings.");
        }
    }
    if (o.dateRangeStart !== undefined && o.dateRangeEnd !== undefined) {
        if (new Date(o.dateRangeStart).getTime() >= new Date(o.dateRangeEnd).getTime()) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "dateRangeStart must be before dateRangeEnd.");
        }
    }
}

/**
 * Extends the standard `CRUDRoute` CRUD scaffolding for `Matter` - deliberately **holder-gated, not
 * admin-gated**: unlike every other admin-managed entity in this codebase (`Domain`, `TransportRule`,
 * `EscrowScope` itself), this never uses `@RequiresTrustedRole()`. `specs/end-to-end_encryption.md`'s
 * "Separation of duties" draws the escrow boundary at the eDiscovery/compliance role, not server
 * administration - a trusted administrator who isn't a holder of a matter's referenced `EscrowScope` gets
 * the same `403` from `requireEscrowHolder()` as anyone else. Matters are a holder concern end to end:
 * only holders create, read, update, close, or delete them, and `find()`/`count()` only ever show a caller
 * the matters under scopes they actually hold.
 *
 * `updateBulk`/`updateProperty`/`truncate` are ALSO overridden below, even though `CRUDRoute` would
 * otherwise serve them unmodified - `@rapidrest/service-core`'s own generic `ACLUtils.hasPermission()`
 * unconditionally grants any `trustedRoles` holder (default `"admin"`) access before ever consulting a
 * per-record ACL, which is correct for every other admin-managed entity in this codebase but exactly
 * backwards for `Matter`. Left unoverridden, a plain admin with no `EscrowScope` holdership at all could
 * reach `PUT /matters`, `PUT /matters/:id/:property`, or `DELETE /matters` directly and bypass every guard
 * this class exists to enforce - including, for `truncate()`, the EscrowAccessRequest-reference guard
 * `delete()` below already has, since `RepoUtils.truncate()` has no way to run that per-record check
 * itself.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseMatterRoute<T extends Matter> extends CRUDRoute<T> {
    /** Supplied by the Mongo/SQL concrete subclasses so `requireEscrowHolder()`/`findHeldScopeIds()` can
     * resolve an `EscrowScope` without depending on either backend directly - see `util/EscrowUtils.ts`. */
    protected abstract escrowScopeClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so `recordAuditLog()` can persist an `AuditLogEntry`
     * without depending on either backend directly - see `util/AuditLogUtils.ts`. */
    protected abstract auditLogClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so `delete()` can check for referencing
     * `EscrowAccessRequest`s without depending on either backend directly. */
    protected abstract escrowAccessRequestClass: any;

    public async create(obj: T | T[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T | T[]> {
        const objs: T[] = Array.isArray(obj) ? obj : [obj];
        for (const o of objs) {
            if (!o.escrowScopeId) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "escrowScopeId is required.");
            }
            await requireEscrowHolder(this._objectFactory!, this.escrowScopeClass, o.escrowScopeId, user);
            validateMatter(o);
        }

        const created: T[] = Array.isArray(obj)
            ? await this.doBulkCreate(objs, { req, user, ignoreACL: true })
            : [await this.doCreateObject(objs[0], { req, user, ignoreACL: true })];

        for (const matter of created) {
            await recordAuditLog(
                this._objectFactory!,
                this.auditLogClass,
                { config: this.config, req, user, logger: this.logger },
                { action: AuditAction.MATTER_CREATE, targetType: "Matter", targetUid: matter.uid, details: { name: matter.name } },
            );
        }

        return Array.isArray(obj) ? created : created[0];
    }

    @Post("/:id/close")
    public async close(@Param("id") id: string, @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T> {
        const existing: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true });
        if (!existing) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        await requireEscrowHolder(this._objectFactory!, this.escrowScopeClass, existing.escrowScopeId, user);
        if (existing.closedAt) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "This matter is already closed.");
        }

        const updated: T = await this.repoUtils!.update(
            { uid: existing.uid, version: (existing as any).version, closedAt: new Date() } as any,
            existing,
            { user, ignoreACL: true },
        );

        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, req, user, logger: this.logger },
            { action: AuditAction.MATTER_CLOSE, targetType: "Matter", targetUid: updated.uid, details: { name: updated.name } },
        );

        return updated;
    }

    public async update(
        @Param("id") id: string,
        obj: UpdateObject<T>,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        const existing: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true });
        if (!existing) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        await requireEscrowHolder(this._objectFactory!, this.escrowScopeClass, existing.escrowScopeId, user);
        if (existing.closedAt) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A closed matter cannot be modified.");
        }
        if ((obj as any).escrowScopeId !== undefined && (obj as any).escrowScopeId !== existing.escrowScopeId) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A matter's escrow scope cannot be changed after creation.");
        }
        validateMatter({ ...existing, ...obj });

        const updated: T = await this.repoUtils!.update(obj, existing, { user, version: (obj as any).version, ignoreACL: true });

        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, req, user, logger: this.logger },
            { action: AuditAction.MATTER_UPDATE, targetType: "Matter", targetUid: updated.uid, details: { name: updated.name } },
        );

        return updated;
    }

    /** `CRUDRoute.updateBulk()`'s own generic implementation (`doBulkUpdate()`) loops calling `doUpdate()`
     * per object - this instead loops calling the already-fully-guarded `update()` above per object, so
     * every one of its checks (holder status, closed-matter, escrowScopeId immutability) applies to each
     * bulk entry exactly as it would to an equivalent individual `PUT /matters/:id` call. A single
     * failing entry aborts the whole batch (simpler and strictly safer than the generic endpoint's
     * partial-success `BulkError` aggregation - this endpoint is a rare, holder-invoked admin action, not
     * a high-volume batch import worth that extra complexity). */
    public async updateBulk(objs: T[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T[]> {
        const updated: T[] = [];
        for (const obj of objs) {
            updated.push(await this.update((obj as any).uid, obj as UpdateObject<T>, req, user));
        }
        return updated;
    }

    /** `CRUDRoute.updateProperty()`'s own generic implementation deliberately bypasses optimistic locking
     * (see `ModelRoute.doUpdateProperty()`'s own doc comment) by defaulting to the record's current
     * version - mirrored here via the same `version: existing.version` pattern `close()` above already
     * uses, rather than reusing `update()` (which requires a caller-supplied version). */
    public async updateProperty(
        @Param("id") id: string,
        @Param("property") propertyName: string,
        obj: any,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        const existing: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true });
        if (!existing) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        await requireEscrowHolder(this._objectFactory!, this.escrowScopeClass, existing.escrowScopeId, user);
        if (existing.closedAt) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A closed matter cannot be modified.");
        }
        if (propertyName === "escrowScopeId" && obj !== existing.escrowScopeId) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A matter's escrow scope cannot be changed after creation.");
        }
        validateMatter({ ...existing, [propertyName]: obj });

        const updated: T = await this.repoUtils!.update(
            { uid: existing.uid, version: (existing as any).version, [propertyName]: obj } as any,
            existing,
            { user, ignoreACL: true },
        );

        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, user, logger: this.logger },
            { action: AuditAction.MATTER_UPDATE, targetType: "Matter", targetUid: updated.uid, details: { name: updated.name } },
        );

        return updated;
    }

    /** `CRUDRoute.truncate()`'s own generic implementation (`RepoUtils.truncate()`) has no way to run
     * either of this class's own per-record guards (holder status, the EscrowAccessRequest-reference
     * check `delete()` above enforces) - narrows to the caller's own held scopes first (the same pattern
     * `find()`/`count()` below already use), then applies the referencing-request guard to every matched
     * matter before actually deleting any of them. The final delete is re-scoped to exactly the uids just
     * checked (not the original query re-run live) - `RepoUtils.truncate()` re-executes its own search
     * query at the moment it runs, independent of `matched` above; passing the original filter through
     * again would let a matter created in the gap between the snapshot and that call (matching the same
     * held-scope filter) be deleted having never been through the referencing-request check at all. A
     * matter that only starts matching after this snapshot is simply left for a later truncate() call to
     * pick up (and check) instead. */
    public async truncate(@Param() params: any, @Query() query: any, @AuthUser user?: JWTUser): Promise<void> {
        const heldScopeIds: string[] = await findHeldScopeIds(this._objectFactory!, this.escrowScopeClass, user);
        if (heldScopeIds.length === 0) {
            return;
        }
        const scopedQuery = { ...query, ...params, escrowScopeId: `in(${heldScopeIds.join(",")})` };
        const findOptions = { limit: query?.limit, page: query?.page, version: query?.version, user, ignoreACL: true };
        const matched: T[] = await this.repoUtils!.find(scopedQuery, findOptions);
        if (matched.length === 0) {
            return;
        }

        const accessRequestRepo: RepoUtils<any> = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.escrowAccessRequestClass.name,
            args: [this.escrowAccessRequestClass],
        });
        for (const existing of matched) {
            const referencing = await accessRequestRepo.find({ matterId: existing.uid, limit: 1 } as any, { ignoreACL: true, limit: 1 });
            if (referencing.length > 0) {
                throw new ApiError(
                    ApiErrors.IDENTIFIER_EXISTS,
                    409,
                    "This matter has EscrowAccessRequests referencing it and cannot be deleted.",
                );
            }
        }

        await this.repoUtils!.truncate({ uid: `in(${matched.map((existing) => existing.uid).join(",")})` } as any, {
            user,
            ignoreACL: true,
        });

        for (const existing of matched) {
            await recordAuditLog(
                this._objectFactory!,
                this.auditLogClass,
                { config: this.config, user, logger: this.logger },
                { action: AuditAction.MATTER_DELETE, targetType: "Matter", targetUid: existing.uid, details: { name: existing.name } },
            );
        }
    }

    public async delete(
        @Param("id") id: string,
        @Query("version") version: string | undefined,
        @Query("purge") purge: string | undefined,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<void> {
        const existing: T | undefined = await this.repoUtils!.findOne(id, { version, ignoreACL: true });
        if (!existing) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        await requireEscrowHolder(this._objectFactory!, this.escrowScopeClass, existing.escrowScopeId, user);

        const accessRequestRepo: RepoUtils<any> = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.escrowAccessRequestClass.name,
            args: [this.escrowAccessRequestClass],
        });
        const referencing = await accessRequestRepo.find({ matterId: existing.uid, limit: 1 } as any, { ignoreACL: true, limit: 1 });
        if (referencing.length > 0) {
            throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "This matter has EscrowAccessRequests referencing it and cannot be deleted.");
        }

        await this.repoUtils!.delete(existing.uid, { user, version, purge: purge === "true", ignoreACL: true });

        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, req, user, logger: this.logger },
            { action: AuditAction.MATTER_DELETE, targetType: "Matter", targetUid: existing.uid, details: { name: existing.name } },
        );
    }

    public async find(@Param() params: any, @Query() query: any, @AuthUser user?: JWTUser): Promise<T[]> {
        const heldScopeIds: string[] = await findHeldScopeIds(this._objectFactory!, this.escrowScopeClass, user);
        if (heldScopeIds.length === 0) {
            return [];
        }
        return await this.repoUtils!.find(
            { ...query, ...params, escrowScopeId: `in(${heldScopeIds.join(",")})` },
            { limit: query?.limit, page: query?.page, version: query?.version, user, ignoreACL: true },
        );
    }

    public async count(
        @Param() params: any,
        @Query() query: any,
        @Response res: HttpResponse,
        @AuthUser user?: JWTUser,
    ): Promise<any> {
        const heldScopeIds: string[] = await findHeldScopeIds(this._objectFactory!, this.escrowScopeClass, user);
        if (heldScopeIds.length === 0) {
            return res.status(200).setHeader("content-length", 0);
        }
        const result: number = await this.repoUtils!.count(
            { ...query, ...params, escrowScopeId: `in(${heldScopeIds.join(",")})` },
            { limit: query?.limit, page: query?.page, version: query?.version, user, ignoreACL: true },
        );
        return res.status(200).setHeader("content-length", result);
    }

    public async findById(@Param("id") id: string, @Query() query: any, @AuthUser user?: JWTUser): Promise<T | null> {
        const result: T | undefined = await this.repoUtils!.findOne(id, {
            version: query?.version,
            includeDeleted: query?.deleted === true || query?.deleted === "true",
            user,
            ignoreACL: true,
        });
        if (!result) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        await requireEscrowHolder(this._objectFactory!, this.escrowScopeClass, result.escrowScopeId, user);
        return result;
    }

    /** `CRUDRoute.exists()`'s own generic implementation (`RepoUtils.exists()`) checks the CLASS-level ACL
     * (`Matter`'s own policy denies `.*` entirely - holder-ness is checked in application code via
     * `EscrowScope.holderUserUids`, never through an ACL record) before ever reaching a per-record check -
     * for a trusted admin that class-level check is bypassed entirely (same generic trusted-role bypass
     * behind every other finding in this class), letting a non-holder admin probe arbitrary matter uids
     * for existence. Mirrors `findById()`'s own holder check immediately above, translated into
     * `BaseScopedChildRoute.exists()`'s found/not-found response shape (a 403 here would tell a non-holder
     * a matter exists at all, which - unlike `findById()` returning full content - existence alone still
     * isn't information this class should leak to anyone but an actual holder). */
    @Head("/:id")
    public async exists(@Param("id") id: string, @Query() query: any, @Response res: HttpResponse, @AuthUser user?: JWTUser): Promise<any> {
        const result: T | undefined = await this.repoUtils!.findOne(id, {
            version: query?.version,
            includeDeleted: query?.deleted === true || query?.deleted === "true",
            ignoreACL: true,
        });
        if (!result) {
            return res.status(404).setHeader("content-length", 0);
        }
        try {
            await requireEscrowHolder(this._objectFactory!, this.escrowScopeClass, result.escrowScopeId, user);
        } catch {
            return res.status(404).setHeader("content-length", 0);
        }
        return res.status(200).setHeader("content-length", 1);
    }
}
