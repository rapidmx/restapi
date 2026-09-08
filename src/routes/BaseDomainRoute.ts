///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import {
    ApiErrorMessages,
    ApiErrors,
    CRUDRoute,
    HttpRequest,
    HttpResponse,
    RouteDecorators,
    type UpdateObject,
} from "@rapidrest/service-core";
import type { DnsResolver } from "../dns/DnsResolver.js";
import { normalizeAddress } from "../util/AddressUtils.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { checkDomainVerification } from "../util/DomainVerificationUtils.js";
import { AuditAction, Domain } from "../models/types.js";
const { Param, Post, Query, Request, RequiresTrustedRole, Response, User: AuthUser } = RouteDecorators;
const { Inject } = ObjectDecorators;

/**
 * Extends the standard `CRUDRoute` CRUD scaffolding for `Domain` with trusted-role-only access to every
 * action - same admin-only pattern `BaseDistributionListRoute`/`BaseTransportRuleRoute` already
 * established (deny-all class ACL + `@RequiresTrustedRole()` + handler bodies that bypass the framework's
 * *default* ACL handling by calling `this.repoUtils` directly with `ignoreACL: true`, for the exact
 * reason documented on `BaseDistributionListRoute`).
 *
 * `create()`/`update()` own the entire lifecycle of `verified`/`verificationToken`/`verifiedAt` - none of
 * those three fields is ever taken from the caller's request body, only ever set by this class itself or
 * by `verify()` below, so a `PUT` can never be used to bypass DNS ownership proof.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseDomainRoute<T extends Domain> extends CRUDRoute<T> {
    /** Supplied by the Mongo/SQL concrete subclasses so `recordAuditLog()` can persist an `AuditLogEntry`
     * without depending on either backend directly - see `util/AuditLogUtils.ts`. */
    protected abstract auditLogClass: any;

    @Inject("DnsResolver")
    private dnsResolver?: DnsResolver;

    private newVerificationToken(): string {
        return crypto.randomBytes(32).toString("base64url");
    }

    /** Normalizes `o.name`, derives `uid` from it, and rejects a 409 on collision against an existing
     * `Domain`. Mutates `o` in place - assigns `uid`, and always starts a freshly created domain
     * unverified with a new token (DNS ownership has never been checked for it yet). */
    private async assignUidAndCheckCollision(o: Partial<T>): Promise<void> {
        if (!o.name) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }
        const uid: string = normalizeAddress(o.name);
        (o as any).uid = uid;
        (o as any).verified = false;
        (o as any).verificationToken = this.newVerificationToken();
        (o as any).verifiedAt = undefined;

        const existing: T | undefined = await this.repoUtils!.findOne(uid, { ignoreACL: true });
        if (existing) {
            throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "This domain has already been added.");
        }
    }

    @RequiresTrustedRole()
    public async create(obj: T | T[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T | T[]> {
        const objs: T[] = Array.isArray(obj) ? obj : [obj];

        const seenUids: Set<string> = new Set();
        for (const o of objs) {
            await this.assignUidAndCheckCollision(o);
            if (seenUids.has((o as any).uid)) {
                throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "Duplicate domain within the same request.");
            }
            seenUids.add((o as any).uid);
        }

        const created: T[] = Array.isArray(obj)
            ? await this.doBulkCreate(objs, { req, user, ignoreACL: true })
            : [await this.doCreateObject(objs[0], { req, user, ignoreACL: true })];

        for (const domain of created) {
            await recordAuditLog(
                this._objectFactory!,
                this.auditLogClass,
                { config: this.config, req, user, logger: this.logger },
                { action: AuditAction.DOMAIN_CREATE, targetType: "Domain", targetUid: domain.uid, details: { name: domain.name } },
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

        // `verified`/`verificationToken`/`verifiedAt`/`lastCheckedAt` are never client-settable - strip
        // whatever the caller sent so only `enabled` (and the required `uid`/`version`) can actually change.
        const patch: any = { ...obj };
        delete patch.verified;
        delete patch.verificationToken;
        delete patch.verifiedAt;
        delete patch.lastCheckedAt;

        // `RepoUtils.update()` requires `obj.uid === existing.uid` (it's an identity match, not a rename) -
        // `name` drives `uid` (see `assignUidAndCheckCollision()`), so changing it here isn't supported;
        // delete and re-create instead, the same as every other uid-derived-from-a-field entity in this
        // library (e.g. `DistributionList.primarySmtpAddress`).
        if (patch.name !== undefined && normalizeAddress(patch.name) !== existing.uid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A domain's name cannot be changed - delete and re-create it instead.");
        }

        const updated: T = await this.repoUtils!.update(patch, existing, { user, version: (obj as any).version, ignoreACL: true });

        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, req, user, logger: this.logger },
            { action: AuditAction.DOMAIN_UPDATE, targetType: "Domain", targetUid: updated.uid, details: { name: updated.name } },
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
            { action: AuditAction.DOMAIN_DELETE, targetType: "Domain", targetUid: existing.uid, details: { name: existing.name } },
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

    /**
     * Triggers an immediate DNS ownership check rather than waiting for `DomainVerificationJob`'s next
     * scheduled pass - looks up `domain.name`'s TXT records for the expected `verificationToken` value
     * (`checkDomainVerification()`, shared with that job) and, on a match, flips `verified: true`. A
     * no-op on an already-verified domain (idempotent); on a still-unverified result, only `lastCheckedAt`
     * is updated - "checked, not found yet" isn't an error, so this always returns `200` with the current
     * (possibly still unverified) domain either way.
     */
    @RequiresTrustedRole()
    @Post("/:id/verify")
    public async verify(@Param("id") id: string, @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T> {
        const domain: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true });
        if (!domain) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        if (domain.verified) {
            return domain;
        }

        const nowVerified: boolean = await checkDomainVerification(this.dnsResolver!, domain);
        const patch: any = { uid: domain.uid, version: domain.version, lastCheckedAt: new Date() };
        if (nowVerified) {
            patch.verified = true;
            patch.verifiedAt = new Date();
        }
        const updated: T = await this.repoUtils!.update(patch, domain, { user, version: domain.version, ignoreACL: true });

        if (nowVerified) {
            await recordAuditLog(
                this._objectFactory!,
                this.auditLogClass,
                { config: this.config, req, user, logger: this.logger },
                { action: AuditAction.DOMAIN_VERIFIED, targetType: "Domain", targetUid: updated.uid, details: { name: updated.name } },
            );
        }

        return updated;
    }
}
