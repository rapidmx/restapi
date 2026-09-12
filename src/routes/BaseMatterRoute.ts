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
    RouteDecorators,
    type UpdateObject,
} from "@rapidrest/service-core";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { findHeldScopeIds, requireEscrowHolder } from "../util/EscrowUtils.js";
import { AuditAction, Matter } from "../models/types.js";
const { Param, Post, Query, Request, Response, User: AuthUser } = RouteDecorators;

/** Validates the parts of a `Matter` a client can actually set, against the merged (existing + patch, for
 * `update()`) object - `undefined` fields are left alone (a patch not touching a given field shouldn't
 * fail validation for it). */
function validateMatter(o: Partial<Matter>): void {
    if (o.name !== undefined && !o.name) {
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
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseMatterRoute<T extends Matter> extends CRUDRoute<T> {
    /** Supplied by the Mongo/SQL concrete subclasses so `requireEscrowHolder()`/`findHeldScopeIds()` can
     * resolve an `EscrowScope` without depending on either backend directly - see `util/EscrowUtils.ts`. */
    protected abstract escrowScopeClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so `recordAuditLog()` can persist an `AuditLogEntry`
     * without depending on either backend directly - see `util/AuditLogUtils.ts`. */
    protected abstract auditLogClass: any;

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
}
