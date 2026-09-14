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
import { evaluateEscrowApprovals, resolveEscrowApprovalTtlHours } from "../util/EscrowUtils.js";
import { AuditAction, EscrowAccessRequest, EscrowScope, Matter } from "../models/types.js";
const { Param, Query, Request, RequiresTrustedRole, Response, User: AuthUser } = RouteDecorators;

/** Page size for scanning a scope's matters and their access requests - see `hasActiveApprovals()`. */
const SCAN_PAGE_SIZE = 500;

/** The security-relevant fields of a scope, recorded before/after every change in the audit log. */
function auditSnapshot(scope: EscrowScope): Record<string, any> {
    return {
        name: scope.name,
        holderUserUids: [...(scope.holderUserUids ?? [])],
        requiredHolders: scope.requiredHolders,
        publicKeyFingerprint: scope.publicKey?.fingerprint,
        notifySubjectOnAccess: scope.notifySubjectOnAccess,
    };
}

/** `true` when `a` and `b` hold the same set of values, ignoring order. `a` is always an already-validated array:
 * the only caller runs `validateEscrowScope()` on the merged patch first, which rejects any non-array
 * `holderUserUids`. */
function sameMembers(a: string[], b: string[] | undefined): boolean {
    const left: string[] = [...a].sort();
    const right: string[] = [...(b ?? [])].sort();
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Validates the parts of an `EscrowScope` a client can actually set, against the merged (existing +
 * patch, for `update()`) object - `undefined` fields are left alone (an `update()` patch not touching a
 * given field shouldn't fail validation for it). */
function validateEscrowScope(o: Partial<EscrowScope>): void {
    // Shadowed in practice: the framework's own schema validation already rejects an empty `name` (a
    // required, non-`@Nullable` column) before this function ever runs - see BaseMatterRoute's
    // identical `validateMatter()` check and its own doc comment for the full reasoning, confirmed the
    // same way here (a create() sending `name: ""` is still 400, but via that upstream path).
    if (o.name !== undefined && !o.name) {
        /* v8 ignore next */
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
 * ## Dual-control rules
 *
 * An administrator could otherwise defeat M-of-N dual control single-handedly by making themselves a holder and
 * lowering `requiredHolders` to 1. So, server-side:
 *
 * 1. The editing user can never be in the `holderUserUids` a create or update sends (`403`) - someone else must
 * make them a holder.
 * 2. A user who IS a holder of a scope can't change that scope's `holderUserUids`, `requiredHolders` or
 * `publicKey` (`403`).
 * 3. While any `EscrowAccessRequest` under the scope is approved and not yet expired (see
 * `evaluateEscrowApprovals()`), lowering `requiredHolders` or changing `holderUserUids`/`publicKey` is refused
 * with a `409` - wait for the approval to expire, or deny/let it lapse first.
 * 4. Every create/update/delete is audit-logged with the scope's security-relevant fields before and after.
 *
 * `updateBulk`/`updateProperty` go through `update()`, and `truncate` is refused, so none of these can be skipped
 * through `CRUDRoute`'s generic endpoints.
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

    /** Supplied by the Mongo/SQL concrete subclasses so `update()` can find approved access requests under the
     * scope (dual-control rule 3 above). */
    protected abstract escrowAccessRequestClass: any;

    private matterRepo?: RepoUtils<Matter>;

    private accessRequestRepo?: RepoUtils<EscrowAccessRequest>;

    private async getMatterRepo(): Promise<RepoUtils<Matter>> {
        if (!this.matterRepo) {
            this.matterRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.matterClass.name,
                args: [this.matterClass],
            });
        }
        return this.matterRepo;
    }

    private async getAccessRequestRepo(): Promise<RepoUtils<EscrowAccessRequest>> {
        if (!this.accessRequestRepo) {
            this.accessRequestRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.escrowAccessRequestClass.name,
                args: [this.escrowAccessRequestClass],
            });
        }
        return this.accessRequestRepo;
    }

    /** Rule 1: the editing user can't be (or add themselves to) the holders. */
    private requireNotSelfHolder(holderUserUids: unknown, user: JWTUser | undefined): void {
        if (Array.isArray(holderUserUids) && user && holderUserUids.includes(user.uid)) {
            throw new ApiError(
                ApiErrors.AUTH_PERMISSION_FAILURE,
                403,
                "You cannot make yourself a holder of an escrow scope - another administrator must do that.",
            );
        }
    }

    /** `true` if any approved or fulfilled access request for a matter under `scope` is still within its
     * approval TTL - see dual-control rule 3 in this class's doc comment. */
    private async hasActiveApprovals(scope: T): Promise<boolean> {
        const matterRepo: RepoUtils<Matter> = await this.getMatterRepo();
        const requestRepo: RepoUtils<EscrowAccessRequest> = await this.getAccessRequestRepo();
        const ttlHours: number = resolveEscrowApprovalTtlHours(this.config);
        for (let page = 0; ; page++) {
            const matters: Matter[] = await matterRepo.find(
                { escrowScopeId: scope.uid, sort: "uid", limit: SCAN_PAGE_SIZE, page } as any,
                { ignoreACL: true, limit: SCAN_PAGE_SIZE, page },
            );
            if (matters.length > 0) {
                const matterIds: string = matters.map((m) => m.uid).join(",");
                for (let requestPage = 0; ; requestPage++) {
                    const requests: EscrowAccessRequest[] = await requestRepo.find(
                        {
                            matterId: `in(${matterIds})`,
                            status: "in(approved,fulfilled)",
                            sort: "uid",
                            limit: SCAN_PAGE_SIZE,
                            page: requestPage,
                        } as any,
                        { ignoreACL: true, limit: SCAN_PAGE_SIZE, page: requestPage },
                    );
                    if (
                        requests.some((request) => {
                            const state = evaluateEscrowApprovals(request, scope, ttlHours);
                            return state.thresholdMet && !state.expired;
                        })
                    ) {
                        return true;
                    }
                    if (requests.length < SCAN_PAGE_SIZE) {
                        break;
                    }
                }
            }
            if (matters.length < SCAN_PAGE_SIZE) {
                return false;
            }
        }
    }

    @RequiresTrustedRole()
    public async create(obj: T | T[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T | T[]> {
        const objs: T[] = Array.isArray(obj) ? obj : [obj];
        for (const o of objs) {
            validateEscrowScope(o);
            this.requireNotSelfHolder(o.holderUserUids, user);
        }

        const created: T[] = Array.isArray(obj)
            ? await this.doBulkCreate(objs, { req, user, ignoreACL: true })
            : [await this.doCreateObject(objs[0], { req, user, ignoreACL: true })];

        for (const scope of created) {
            await recordAuditLog(
                this._objectFactory!,
                this.auditLogClass,
                { config: this.config, req, user, logger: this.logger },
                {
                    action: AuditAction.ESCROW_SCOPE_CREATE,
                    targetType: "EscrowScope",
                    targetUid: scope.uid,
                    details: { name: scope.name, after: auditSnapshot(scope) },
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
        const existing: T | undefined = await this.repoUtils!.findOne(id, { skipCache: true, ignoreACL: true });
        if (!existing) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        const patch: any = obj ?? {};
        validateEscrowScope({ ...existing, ...patch });

        const holdersChanged: boolean = patch.holderUserUids !== undefined && !sameMembers(patch.holderUserUids, existing.holderUserUids);
        const thresholdLowered: boolean = patch.requiredHolders !== undefined && patch.requiredHolders < existing.requiredHolders;
        const thresholdChanged: boolean = patch.requiredHolders !== undefined && patch.requiredHolders !== existing.requiredHolders;
        const publicKeyChanged: boolean =
            patch.publicKey !== undefined && JSON.stringify(patch.publicKey) !== JSON.stringify(existing.publicKey);

        // Only a real change is checked, so re-sending an unchanged holder list (e.g. a full-object PUT) that someone
        // else already put the caller on isn't mistaken for adding themselves - rule 2 still stops that caller
        // from changing the list.
        if (holdersChanged) {
            this.requireNotSelfHolder(patch.holderUserUids, user);
        }
        if (user && existing.holderUserUids.includes(user.uid) && (holdersChanged || thresholdChanged || publicKeyChanged)) {
            throw new ApiError(
                ApiErrors.AUTH_PERMISSION_FAILURE,
                403,
                "A holder of an escrow scope cannot change its holders, required holders or public key.",
            );
        }
        if ((holdersChanged || thresholdLowered || publicKeyChanged) && (await this.hasActiveApprovals(existing))) {
            throw new ApiError(
                ApiErrors.IDENTIFIER_EXISTS,
                409,
                "This escrow scope has approved access requests that have not expired yet - its holders, public key and " +
                    "required holders can't be loosened or replaced until they expire.",
            );
        }

        const updated: T = await this.repoUtils!.update(obj, existing, { user, version: patch.version, ignoreACL: true });

        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, req, user, logger: this.logger },
            {
                action: AuditAction.ESCROW_SCOPE_UPDATE,
                targetType: "EscrowScope",
                targetUid: updated.uid,
                details: { name: updated.name, before: auditSnapshot(existing), after: auditSnapshot(updated) },
            },
        );

        return updated;
    }

    /** `CRUDRoute`'s own `PUT /` would write every entry through `doBulkUpdate()`, skipping validation, the
     * dual-control rules and the audit log - each entry goes through `update()` instead. One failing entry aborts
     * the rest (same trade-off as `BaseMatterRoute.updateBulk()`). */
    @RequiresTrustedRole()
    public async updateBulk(objs: UpdateObject<T>[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T[]> {
        if (!Array.isArray(objs)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }
        const updated: T[] = [];
        for (const obj of objs) {
            updated.push(await this.update((obj as any)?.uid, obj, req, user));
        }
        return updated;
    }

    /** Same as `updateBulk()`, for `CRUDRoute`'s `PUT /:id/:property`. */
    @RequiresTrustedRole()
    public async updateProperty(
        @Param("id") id: string,
        @Param("property") propertyName: string,
        obj: any,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        if (propertyName === "uid") {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }
        const existing: T | undefined = await this.repoUtils!.findOne(id, { skipCache: true, ignoreACL: true });
        if (!existing) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        return await this.update(id, { uid: existing.uid, version: existing.version, [propertyName]: obj } as any, undefined as any, user);
    }

    /** `CRUDRoute`'s own `DELETE /` would delete scopes without `delete()`'s referencing-matter check or an audit
     * entry - refused; delete scopes one at a time. */
    @RequiresTrustedRole()
    public async truncate(@Param() params: any, @Query() query: any, @AuthUser user?: JWTUser): Promise<void> {
        throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, "Escrow scopes must be deleted one at a time.");
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
            {
                action: AuditAction.ESCROW_SCOPE_DELETE,
                targetType: "EscrowScope",
                targetUid: existing.uid,
                details: { name: existing.name, before: auditSnapshot(existing) },
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
