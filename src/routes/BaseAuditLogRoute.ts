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
import { AuditLogEntry } from "../models/types.js";
const { Delete, Param, Post, Put, Query, Request, RequiresTrustedRole, Response, User: AuthUser } = RouteDecorators;

/** Always throws 403 - see `BaseAuditLogRoute`'s own doc comment for why every write path is blocked for
 * every caller, trusted included. */
function rejectWrite(): never {
    throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, "AuditLogEntry records cannot be created, updated, or deleted through this API.");
}

/**
 * Extends the standard `CRUDRoute` CRUD scaffolding for `AuditLogEntry` with trusted-role-only *read*
 * access - `find`/`count`/`findById` are overridden below, each `@RequiresTrustedRole()`-gated, mirroring
 * `BaseTransportRuleRoute`'s exact admin-only pattern.
 *
 * `create`/`update`/`delete`/`truncate` are overridden to unconditionally reject *every* caller, trusted
 * included - unlike `BaseDistributionListRoute`/`BaseTransportRuleRoute`'s deny-all class ACL (which
 * blocks non-trusted callers but does NOT block a trusted one: `ACLUtils.hasPermission()` grants a
 * trusted caller access before ever consulting the record's own ACL grants - "Trusted users always have
 * permission", confirmed by reading its source), there is no way to block *every* caller, admins
 * included, via the ACL system alone. An audit trail an admin could edit through the same API it's meant
 * to hold them accountable through wouldn't be trustworthy. The only writer is `util/AuditLogUtils.ts`'s
 * `recordAuditLog()`, called directly from the handful of routes this covers (see `AuditAction`'s own
 * doc comment, `models/types.ts`) with `{ ignoreACL: true }`, bypassing this route entirely.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseAuditLogRoute<T extends AuditLogEntry> extends CRUDRoute<T> {
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

    @Post()
    public async create(obj: T | T[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T | T[]> {
        return rejectWrite();
    }

    @Put("/:id")
    public async update(
        @Param("id") id: string,
        obj: UpdateObject<T>,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        return rejectWrite();
    }

    @Delete("/:id")
    public async delete(
        @Param("id") id: string,
        @Query("version") version: string | undefined,
        @Query("purge") purge: string | undefined,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<void> {
        return rejectWrite();
    }

    @Delete()
    public async truncate(@Param() params: any, @Query() query: any, @AuthUser user?: JWTUser): Promise<void> {
        return rejectWrite();
    }
}
