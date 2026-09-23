///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, UserUtils, type JWTUser } from "@rapidrest/core";
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
import { verifyEscrowAuditChain, type EscrowAuditVerificationResult } from "../util/EscrowAuditUtils.js";
import { exactInFilter, findHeldScopeIds, isQuerySafeUid } from "../util/EscrowUtils.js";
import { EscrowAuditLogEntry, Matter } from "../models/types.js";
const { Before, Delete, Get, Param, Post, Put, Query, Request, RequiresTrustedRole, Response, User: AuthUser } = RouteDecorators;

/** Page size for reading every matter under a holder's scopes - see `resolveVisibleMatterIds()`. */
const MATTER_PAGE_SIZE = 500;

/**
 * Extends the standard `CRUDRoute` CRUD scaffolding for `EscrowAuditLogEntry` with read-only,
 * holder-or-trusted-admin access - `find`/`count`/`findById` are overridden below with no
 * `@RequiresTrustedRole()` at all, since this audit *metadata* (who/what/when, never key material) grants
 * no decryption capability, unlike `BaseKeyVaultRoute`'s deliberate admin exclusion. A trusted admin gets
 * unfiltered visibility (independent oversight of holders, mirroring `BaseAuditLogRoute`'s own
 * admin-readable precedent); a holder sees only entries for matters under scopes they hold.
 *
 * `create`/`update`/`updateBulk`/`updateProperty`/`delete`/`truncate` are overridden to unconditionally reject *every* caller, trusted
 * included - identical reasoning to `BaseAuditLogRoute`'s own `rejectWrite()`: an audit trail editable by
 * the people it holds accountable isn't trustworthy. The only writer is `util/EscrowAuditUtils.ts`'s
 * `recordEscrowAuditEntry()`, called directly by `BaseEscrowAccessRequestRoute` with `{ ignoreACL: true }`,
 * bypassing this route entirely.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseEscrowAuditLogRoute<T extends EscrowAuditLogEntry> extends CRUDRoute<T> {
    /** Supplied by the Mongo/SQL concrete subclasses so `findHeldScopeIds()` can resolve an `EscrowScope`
     * without depending on either backend directly - see `util/EscrowUtils.ts`. */
    protected abstract escrowScopeClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so a holder's visibility can be scoped to matters
     * under scopes they hold, without depending on either backend directly. */
    protected abstract matterClass: any;

    /** Mirrors `BaseMailboxRoute`'s own field - needed because this class checks trust manually in
     * `find`/`count`/`findById` (which have no `@RequiresTrustedRole()` of their own) alongside the
     * decorator-only-gated `verify()`. */
    protected trustedRoles: string[] = ["admin"];

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

    /** Resolves the `matterId`s a non-trusted caller may see entries for - every `Matter` under a scope
     * they hold. `undefined` return means "no restriction" (the caller is trusted); an empty array means
     * "nothing visible at all". */
    private async resolveVisibleMatterIds(user: JWTUser | undefined): Promise<string[] | undefined> {
        if (UserUtils.hasRoles(user, this.trustedRoles)) {
            return undefined;
        }
        // `exactInFilter()`/`isQuerySafeUid()`: a uid holding `,` would widen the `in(...)` filters below.
        const heldScopes: string | undefined = exactInFilter(await findHeldScopeIds(this._objectFactory!, this.escrowScopeClass, user));
        if (!heldScopes) {
            return [];
        }
        const matterRepo: RepoUtils<Matter> = await this.getMatterRepo();
        // Every page - a single `find()` stops at the framework's default page size, which would silently hide
        // the entries of every matter past the first 100 from their own holders.
        const matterIds: string[] = [];
        for (let page = 0; ; page++) {
            const batch: Matter[] = await matterRepo.find(
                { escrowScopeId: heldScopes, sort: "uid", limit: MATTER_PAGE_SIZE, page } as any,
                { ignoreACL: true, limit: MATTER_PAGE_SIZE, page },
            );
            matterIds.push(...batch.map((m) => m.uid).filter(isQuerySafeUid));
            if (batch.length < MATTER_PAGE_SIZE) {
                return matterIds;
            }
        }
    }

    /** The list filter for `find()`/`count()`. For a holder, `matterId` is forced to the matters they may see, so
     * the client's query loses every `$`-prefixed key (`$or`...) and its own `matterId` first: the SQL backend
     * composes a `$or` branch's keys over the other filters, which would replace the forced `matterId`. */
    private buildFilter(query: any, params: any, visibleMatterIds: string[] | undefined): any {
        if (!visibleMatterIds) {
            return { ...query, ...params };
        }
        const filter: any = {};
        for (const [key, value] of Object.entries(query ?? {})) {
            // Segment-aware, not just top-level - matches the check `BaseScopedChildRoute`/`BaseFolderRoute`/
            // `BaseMailboxRoute`/`BaseAttachmentRoute` already use, so a nested operator key like
            // `escrowScopeId.$where` can't slip past this route's own filtering unstripped.
            if (!key.split(".").some((segment) => segment.startsWith("$")) && key !== "matterId") {
                filter[key] = value;
            }
        }
        return { ...filter, ...params, matterId: `in(${visibleMatterIds.join(",")})` };
    }

    /** Narrows a holder's visible matters to the client's own plain `?matterId=` filter, when one is given. */
    private async resolveFilterMatterIds(query: any, user: JWTUser | undefined): Promise<string[] | undefined> {
        const visibleMatterIds: string[] | undefined = await this.resolveVisibleMatterIds(user);
        if (visibleMatterIds && typeof query?.matterId === "string") {
            return visibleMatterIds.filter((uid) => uid === query.matterId);
        }
        return visibleMatterIds;
    }

    public async find(@Param() params: any, @Query() query: any, @AuthUser user?: JWTUser): Promise<T[]> {
        const visibleMatterIds: string[] | undefined = await this.resolveFilterMatterIds(query, user);
        if (visibleMatterIds && visibleMatterIds.length === 0) {
            return [];
        }
        const filter: any = this.buildFilter(query, params, visibleMatterIds);
        return await this.repoUtils!.find(
            filter,
            { limit: query?.limit, page: query?.page, version: query?.version, user, ignoreACL: true },
        );
    }

    public async count(
        @Param() params: any,
        @Query() query: any,
        @Response res: HttpResponse,
        @AuthUser user?: JWTUser,
    ): Promise<any> {
        const visibleMatterIds: string[] | undefined = await this.resolveFilterMatterIds(query, user);
        if (visibleMatterIds && visibleMatterIds.length === 0) {
            return res.status(200).setHeader("content-length", 0);
        }
        const filter: any = this.buildFilter(query, params, visibleMatterIds);
        const result: number = await this.repoUtils!.count(
            filter,
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
        const visibleMatterIds: string[] | undefined = await this.resolveVisibleMatterIds(user);
        if (visibleMatterIds && !visibleMatterIds.includes(result.matterId)) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        return result;
    }

    /**
     * Verifies the entire hash chain end to end - `@RequiresTrustedRole()` only, deliberately not
     * holder-accessible: the chain is global (not per-scope), so `brokenAtSequence` would leak the
     * existence/volume of *other* scopes' escrow activity to a holder who only has standing to know about
     * their own scope.
     */
    @RequiresTrustedRole()
    @Get("/verify")
    public async verify(): Promise<EscrowAuditVerificationResult> {
        return await verifyEscrowAuditChain(this._objectFactory!, this.modelClass);
    }

    /** Runs as `@Before` middleware on every write handler below, strictly before the handler body - see
     * this class's own doc comment for why every write path is blocked for every caller, trusted included. */
    protected rejectWrite(): never {
        throw new ApiError(
            ApiErrors.AUTH_PERMISSION_FAILURE,
            403,
            "EscrowAuditLogEntry records cannot be created, updated, or deleted through this API.",
        );
    }

    @Post()
    @Before("rejectWrite")
    public async create(obj: T | T[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T | T[]> {
        return this.rejectWrite();
    }

    @Put("/:id")
    @Before("rejectWrite")
    public async update(
        @Param("id") id: string,
        obj: UpdateObject<T>,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        return this.rejectWrite();
    }

    /** `CRUDRoute`'s own `PUT /` would otherwise reach `doBulkUpdate()` directly, where a trusted admin passes the
     * class ACL and could rewrite entries (hashes included) without ever going through `update()` above. */
    @Put()
    @Before("rejectWrite")
    public async updateBulk(obj: UpdateObject<T>[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T[]> {
        return this.rejectWrite();
    }

    /** Same as `updateBulk()`, for `CRUDRoute`'s `PUT /:id/:property`. */
    @Put(":id/:property")
    @Before("rejectWrite")
    public async updateProperty(
        @Param("id") id: string,
        @Param("property") propertyName: string,
        obj: any,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        return this.rejectWrite();
    }

    @Delete("/:id")
    @Before("rejectWrite")
    public async delete(
        @Param("id") id: string,
        @Query("version") version: string | undefined,
        @Query("purge") purge: string | undefined,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<void> {
        return this.rejectWrite();
    }

    @Delete()
    @Before("rejectWrite")
    public async truncate(@Param() params: any, @Query() query: any, @AuthUser user?: JWTUser): Promise<void> {
        return this.rejectWrite();
    }
}
