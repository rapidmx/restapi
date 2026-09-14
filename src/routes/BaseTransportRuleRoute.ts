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
import { AuditAction, TransportRule } from "../models/types.js";
const { Param, Query, Request, RequiresTrustedRole, Response, User: AuthUser } = RouteDecorators;

/**
 * Extends the standard `CRUDRoute` CRUD scaffolding for `TransportRule` with trusted-role-only access to
 * every action - same admin-only pattern `BaseDistributionListRoute` already established (there is no
 * self-service creation, per-record delegated ownership, or real per-record ACL; the class ACL, like
 * `MailFilterRule`'s own, denies every action to everyone - see `TransportRuleMongo`/`SQL`'s `@Protect`
 * config). Simpler than `BaseDistributionListRoute`: a transport rule has no natural address, so there's no
 * uid-derivation or cross-entity collision check to perform on `create()`.
 *
 * Each method is decorated with `@RequiresTrustedRole()`, which installs a dispatch-time middleware
 * (`RouteUtils.checkTrusedRoles()`) that rejects a non-trusted caller with `403` before the handler body
 * ever runs. The handler bodies still bypass the framework's *default* ACL handling (calling
 * `this.repoUtils` directly with `ignoreACL: true`) rather than delegating to `super.*()`/`this.do*()`,
 * for the exact reason already documented on `BaseDistributionListRoute`: those helpers either
 * unconditionally deny via the (always-empty) class ACL, or never forward `ignoreACL` to the underlying
 * `RepoUtils` call at all.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseTransportRuleRoute<T extends TransportRule> extends CRUDRoute<T> {
    /** Supplied by the Mongo/SQL concrete subclasses so `recordAuditLog()` can persist an `AuditLogEntry`
     * without depending on either backend directly - see `util/AuditLogUtils.ts`. */
    protected abstract auditLogClass: any;

    @RequiresTrustedRole()
    public async create(obj: T | T[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T | T[]> {
        // Always a server-minted uid, like every other create route (see `BaseScopedChildRoute`'s doc comment).
        for (const single of Array.isArray(obj) ? obj : [obj]) {
            delete (single as any).uid;
        }
        const created: T[] = Array.isArray(obj)
            ? await this.doBulkCreate(obj, { req, user, ignoreACL: true })
            : [await this.doCreateObject(obj, { req, user, ignoreACL: true })];

        for (const rule of created) {
            await recordAuditLog(
                this._objectFactory!,
                this.auditLogClass,
                { config: this.config, req, user, logger: this.logger },
                { action: AuditAction.TRANSPORT_RULE_CREATE, targetType: "TransportRule", targetUid: rule.uid, details: { name: rule.name } },
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
        const updated: T = await this.repoUtils!.update(obj, existing, { user, version: (obj as any).version, ignoreACL: true });

        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, req, user, logger: this.logger },
            { action: AuditAction.TRANSPORT_RULE_UPDATE, targetType: "TransportRule", targetUid: updated.uid, details: { name: updated.name } },
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
        await this.repoUtils!.delete(existing.uid, { user, version, purge: purge === "true", ignoreACL: true });

        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, req, user, logger: this.logger },
            { action: AuditAction.TRANSPORT_RULE_DELETE, targetType: "TransportRule", targetUid: existing.uid, details: { name: existing.name } },
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
