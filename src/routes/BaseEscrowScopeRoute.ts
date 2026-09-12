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
import { AuditAction, EscrowScope, Matter } from "../models/types.js";
const { Param, Query, Request, RequiresTrustedRole, Response, User: AuthUser } = RouteDecorators;

/** Validates the parts of an `EscrowScope` a client can actually set, against the merged (existing +
 * patch, for `update()`) object - `undefined` fields are left alone (an `update()` patch not touching a
 * given field shouldn't fail validation for it). */
function validateEscrowScope(o: Partial<EscrowScope>): void {
    if (o.name !== undefined && !o.name) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "name is required.");
    }
    if (o.holderUserUids !== undefined) {
        const uids = o.holderUserUids;
        if (!Array.isArray(uids) || uids.length === 0 || uids.some((uid) => typeof uid !== "string" || !uid)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "holderUserUids must be a non-empty array of non-empty strings.");
        }
        if (new Set(uids).size !== uids.length) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "holderUserUids must not contain duplicates.");
        }
    }
    if (o.requiredHolders !== undefined) {
        const holderCount: number | undefined = o.holderUserUids?.length;
        if (
            !Number.isInteger(o.requiredHolders) ||
            o.requiredHolders < 1 ||
            (holderCount !== undefined && o.requiredHolders > holderCount)
        ) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "requiredHolders must be between 1 and holderUserUids.length.");
        }
    }
    if (o.publicKey !== undefined) {
        const key = o.publicKey;
        if (!key.publicKey || !key.type || !key.fingerprint) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "publicKey.publicKey, .type and .fingerprint are required.");
        }
        if (key.notBefore >= key.notAfter) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "publicKey.notBefore must be before publicKey.notAfter.");
        }
    }
}

/**
 * Extends the standard `CRUDRoute` CRUD scaffolding for `EscrowScope` with trusted-role-only access to
 * every action - same admin-only pattern `BaseTransportRuleRoute`/`BaseDomainRoute` already established
 * (deny-all class ACL + `@RequiresTrustedRole()` + handler bodies that bypass the framework's *default*
 * ACL handling by calling `this.repoUtils` directly with `ignoreACL: true`).
 *
 * Configuring *who counts as a holder*, the dual-control threshold, and the scope's own public key is an
 * administrative act - this route only ever manages that configuration. Holding the eDiscovery/compliance
 * role itself, and everything it grants (reading a mailbox's escrow-wrapped key material), is a
 * deliberately separate concern this route never touches - see `specs/end-to-end_encryption.md`'s
 * "Separation of duties": a trusted administrator configuring a scope's holder list does not thereby
 * become a holder, and gets no bypass anywhere holder-ness is actually checked.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseEscrowScopeRoute<T extends EscrowScope> extends CRUDRoute<T> {
    /** Supplied by the Mongo/SQL concrete subclasses so `recordAuditLog()` can persist an `AuditLogEntry`
     * without depending on either backend directly - see `util/AuditLogUtils.ts`. */
    protected abstract auditLogClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so `delete()` can check for a referencing `Matter`
     * without depending on either backend directly. */
    protected abstract matterClass: any;

    private matterRepo?: RepoUtils<Matter>;

    private async getMatterRepo(): Promise<RepoUtils<Matter>> {
        if (!this.matterRepo) {
            this.matterRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.matterClass.name,
                args: [this.matterClass],
            });
        }
        return this.matterRepo;
    }

    @RequiresTrustedRole()
    public async create(obj: T | T[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T | T[]> {
        const objs: T[] = Array.isArray(obj) ? obj : [obj];
        for (const o of objs) {
            validateEscrowScope(o);
        }

        const created: T[] = Array.isArray(obj)
            ? await this.doBulkCreate(objs, { req, user, ignoreACL: true })
            : [await this.doCreateObject(objs[0], { req, user, ignoreACL: true })];

        for (const scope of created) {
            await recordAuditLog(
                this._objectFactory!,
                this.auditLogClass,
                { config: this.config, req, user, logger: this.logger },
                { action: AuditAction.ESCROW_SCOPE_CREATE, targetType: "EscrowScope", targetUid: scope.uid, details: { name: scope.name } },
            );
        }

        return Array.isArray(obj) ? created : created[0];
    }

    @RequiresTrustedRole()
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
        validateEscrowScope({ ...existing, ...obj });
        const updated: T = await this.repoUtils!.update(obj, existing, { user, version: (obj as any).version, ignoreACL: true });

        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, req, user, logger: this.logger },
            { action: AuditAction.ESCROW_SCOPE_UPDATE, targetType: "EscrowScope", targetUid: updated.uid, details: { name: updated.name } },
        );

        return updated;
    }

    @RequiresTrustedRole()
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
        const matterRepo: RepoUtils<Matter> = await this.getMatterRepo();
        const referencingMatters: Matter[] = await matterRepo.find(
            { escrowScopeId: existing.uid, limit: 1 } as any,
            { ignoreACL: true, limit: 1 },
        );
        if (referencingMatters.length > 0) {
            throw new ApiError(
                ApiErrors.IDENTIFIER_EXISTS,
                409,
                "This escrow scope is referenced by an existing Matter and cannot be deleted.",
            );
        }
        await this.repoUtils!.delete(existing.uid, { user, version, purge: purge === "true", ignoreACL: true });

        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, req, user, logger: this.logger },
            { action: AuditAction.ESCROW_SCOPE_DELETE, targetType: "EscrowScope", targetUid: existing.uid, details: { name: existing.name } },
        );
    }

    @RequiresTrustedRole()
    public async find(@Param() params: any, @Query() query: any, @AuthUser user?: JWTUser): Promise<T[]> {
        return await this.repoUtils!.find(
            { ...query, ...params },
            { limit: query?.limit, page: query?.page, version: query?.version, user, ignoreACL: true },
        );
    }

    @RequiresTrustedRole()
    public async count(
        @Param() params: any,
        @Query() query: any,
        @Response res: HttpResponse,
        @AuthUser user?: JWTUser,
    ): Promise<any> {
        const result: number = await this.repoUtils!.count(
            { ...query, ...params },
            { limit: query?.limit, page: query?.page, version: query?.version, user, ignoreACL: true },
        );
        return res.status(200).setHeader("content-length", result);
    }

    @RequiresTrustedRole()
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
        return result;
    }
}
