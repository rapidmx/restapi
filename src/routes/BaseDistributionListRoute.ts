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
import { normalizeAddress } from "../util/AddressUtils.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { getVerifiedDomainNames } from "../util/DomainUtils.js";
import { AuditAction, DistributionList, Mailbox } from "../models/types.js";
const { Param, Query, Request, RequiresTrustedRole, Response, User: AuthUser } = RouteDecorators;

/**
 * Extends the standard `CRUDRoute` CRUD scaffolding for `DistributionList` with trusted-role-only access to
 * every action - there is no self-service creation, per-list delegated ownership, or real per-record ACL (the
 * class ACL, like `ContactList`'s, denies every action to everyone; see `DistributionListMongo`/`SQL`'s own
 * `@Protect` config). Each method below is decorated with `@RequiresTrustedRole()`, which installs a
 * dispatch-time middleware (`RouteUtils.checkTrusedRoles()`) that rejects a non-trusted caller with `403`
 * before the handler body ever runs - so by the time any method body executes, the caller is already known
 * to be trusted, and no manual role check is needed there.
 *
 * Every method below still bypasses the framework's *default* ACL handling (calling `this.repoUtils` directly
 * with `ignoreACL: true`) rather than delegating to `super.*()`/`this.do*()`: those helpers either
 * unconditionally deny via the class ACL (`doCreate()` checks its `CREATE` grant directly, which is always
 * empty here) or never forward `ignoreACL` to the underlying `RepoUtils` call at all (`doFind()`/`doCount()`/
 * `doFindById()`/`doUpdate()`/`doDelete()` each hardcode their own fixed option set) - confirmed by reading
 * `ModelRoute.js`. This mirrors `BaseMailboxRoute.create()`'s own reason for bypassing the class ACL, just
 * applied to every action instead of only `create()`, since a `Mailbox` has real per-record ACLs (owner/
 * delegate) to fall back on and a `DistributionList` does not.
 *
 * `mailboxClass` is supplied by the Mongo/SQL concrete subclasses so `create()` can check a candidate address
 * against `Mailbox` too (see `normalizeAddress`/the `uid` architecture note on `DistributionList`).
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseDistributionListRoute<T extends DistributionList> extends CRUDRoute<T> {
    protected abstract mailboxClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so `create()` can look up this server's verified
     * domains without depending on either backend directly - see `util/DomainUtils.ts`. */
    protected abstract domainClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so `recordAuditLog()` can persist an `AuditLogEntry`
     * without depending on either backend directly - see `util/AuditLogUtils.ts`. */
    protected abstract auditLogClass: any;

    private mailboxRepo?: RepoUtils<Mailbox>;

    private async getMailboxRepo(): Promise<RepoUtils<Mailbox>> {
        if (!this.mailboxRepo) {
            this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.mailboxClass.name,
                args: [this.mailboxClass],
            });
        }
        return this.mailboxRepo;
    }

    /**
     * Validates a candidate list's `primarySmtpAddress` (its domain must be one of this server's verified
     * `Domain`s, once at least one exists - same rule `BaseMailboxRoute.create()` applies), derives its
     * `uid` from that address, and rejects a collision against either an existing `DistributionList`
     * (including a soft-deleted one, which still occupies its uid) or an existing `Mailbox`. Mutates
     * `o.uid` in place.
     */
    private async assignUidAndCheckCollision(o: Partial<T>, domains: string[]): Promise<void> {
        if (!o.primarySmtpAddress) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }
        const domain: string | undefined = o.primarySmtpAddress.split("@")[1]?.toLowerCase();
        if (domains.length > 0 && (!domain || !domains.includes(domain))) {
            throw new ApiError(
                ApiErrors.INVALID_REQUEST,
                400,
                `Distribution list addresses must be on one of this server's configured domains: ${domains.join(", ")}.`,
            );
        }

        const uid: string = normalizeAddress(o.primarySmtpAddress);
        (o as any).uid = uid;

        const mailboxRepo: RepoUtils<Mailbox> = await this.getMailboxRepo();
        const [existingList, existingMailbox] = await Promise.all([
            this.repoUtils!.findOne(uid, { ignoreACL: true, includeDeleted: true }),
            mailboxRepo.findOne(uid, { ignoreACL: true, includeDeleted: true }),
        ]);
        if (existingList || existingMailbox) {
            throw new ApiError(
                ApiErrors.IDENTIFIER_EXISTS,
                409,
                "This address is already in use by another mailbox or distribution list.",
            );
        }
    }

    @RequiresTrustedRole()
    public async create(obj: T | T[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T | T[]> {
        const objs: T[] = Array.isArray(obj) ? obj : [obj];
        const domains: string[] = await getVerifiedDomainNames(this._objectFactory!, this.domainClass);

        const seenUids: Set<string> = new Set();
        for (const o of objs) {
            await this.assignUidAndCheckCollision(o, domains);
            if (seenUids.has((o as any).uid)) {
                throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "Duplicate address within the same request.");
            }
            seenUids.add((o as any).uid);
        }

        const created: T[] = Array.isArray(obj)
            ? await this.doBulkCreate(objs, { req, user, ignoreACL: true })
            : [await this.doCreateObject(objs[0], { req, user, ignoreACL: true })];

        for (const list of created) {
            await recordAuditLog(
                this._objectFactory!,
                this.auditLogClass,
                { config: this.config, req, user, logger: this.logger },
                {
                    action: AuditAction.DISTRIBUTION_LIST_CREATE,
                    targetType: "DistributionList",
                    targetUid: list.uid,
                    details: { primarySmtpAddress: list.primarySmtpAddress, name: list.name },
                },
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
            {
                action: AuditAction.DISTRIBUTION_LIST_UPDATE,
                targetType: "DistributionList",
                targetUid: updated.uid,
                details: { primarySmtpAddress: updated.primarySmtpAddress, name: updated.name },
            },
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
            {
                action: AuditAction.DISTRIBUTION_LIST_DELETE,
                targetType: "DistributionList",
                targetUid: existing.uid,
                details: { primarySmtpAddress: existing.primarySmtpAddress, name: existing.name },
            },
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
