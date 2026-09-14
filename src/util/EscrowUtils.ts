///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, type JWTUser, type ObjectFactory } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, RepoUtils } from "@rapidrest/service-core";
import { EscrowAccessRequest, EscrowScope } from "../models/types.js";

/** Caches one `RepoUtils` per concrete `EscrowScope` class (Mongo vs SQL) - shared across every calling
 * route rather than each maintaining its own lazy-repo field/getter, mirroring `AuditLogUtils.ts`'s
 * identical `getAuditLogRepo()` pattern. */
const escrowScopeRepoCache = new WeakMap<any, Promise<RepoUtils<EscrowScope>>>();

function getEscrowScopeRepo(objectFactory: ObjectFactory, escrowScopeClass: any): Promise<RepoUtils<EscrowScope>> {
    let cached = escrowScopeRepoCache.get(escrowScopeClass);
    if (!cached) {
        cached = Promise.resolve(objectFactory.newInstance(RepoUtils, { name: escrowScopeClass.name, args: [escrowScopeClass] }));
        escrowScopeRepoCache.set(escrowScopeClass, cached);
    }
    return cached;
}

/**
 * Fetches `scopeId`, throwing `404` if no such `EscrowScope` exists or `403` if `user` isn't one of its
 * `holderUserUids` - the one place "is this user a holder of scope X" is checked, shared by
 * `BaseMatterRoute` and `BaseEscrowAccessRequestRoute` so neither duplicates it. Returns the scope itself
 * so a caller that also needs one of its other fields (e.g. `requiredHolders`) avoids a second fetch.
 *
 * Deliberately never consults the ACL/trusted-role system - see `EscrowScope`'s own doc comment: holder-
 * ness is a distinct, separately-granted compliance role, not server administration, so a trusted admin
 * with no holder grant on this specific scope gets the same `403` as anyone else.
 */
export async function requireEscrowHolder(
    objectFactory: ObjectFactory,
    escrowScopeClass: any,
    scopeId: string,
    user: JWTUser | undefined,
): Promise<EscrowScope> {
    const repo: RepoUtils<EscrowScope> = await getEscrowScopeRepo(objectFactory, escrowScopeClass);
    const scope: EscrowScope | undefined = await repo.findOne(scopeId, { ignoreACL: true });
    if (!scope) {
        throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
    }
    if (!user || !scope.holderUserUids.includes(user.uid)) {
        throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
    }
    return scope;
}

/**
 * Every `EscrowScope.uid` where `user` is a holder - for scoping a `find()`/`count()` to only what the
 * caller may see, the same shape `BaseMailboxRoute.findAccessibleMailboxUids()` already establishes for a
 * different entity. Always an array (never `undefined`), empty for an unauthenticated caller or one
 * holding no scope at all.
 *
 * Fetches every `EscrowScope` and filters client-side rather than querying by `holderUserUids` directly -
 * fine at this scale, since the number of escrow scopes in a real deployment (a handful of compliance
 * roles) is nothing like the mailbox-count scale `findAccessibleMailboxUids()` has to handle via a real
 * indexed query.
 */
export async function findHeldScopeIds(
    objectFactory: ObjectFactory,
    escrowScopeClass: any,
    user: JWTUser | undefined,
): Promise<string[]> {
    if (!user) {
        return [];
    }
    const repo: RepoUtils<EscrowScope> = await getEscrowScopeRepo(objectFactory, escrowScopeClass);
    const scopes: EscrowScope[] = await repo.find({}, { ignoreACL: true });
    return scopes.filter((s) => s.holderUserUids.includes(user.uid)).map((s) => s.uid);
}

/** How long an `EscrowAccessRequest` stays usable after reaching its approval threshold when
 * `mail:escrow:approval_ttl_hours` isn't configured. */
export const DEFAULT_ESCROW_APPROVAL_TTL_HOURS = 72;

/** Reads `mail:escrow:approval_ttl_hours` from a route's whole-config object, falling back to
 * `DEFAULT_ESCROW_APPROVAL_TTL_HOURS` for an unset, non-numeric or non-positive value. */
export function resolveEscrowApprovalTtlHours(config: any): number {
    const raw: unknown = typeof config?.get === "function" ? config.get("mail:escrow:approval_ttl_hours") : undefined;
    const hours: number = typeof raw === "string" ? Number(raw) : (raw as number);
    return typeof hours === "number" && Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_ESCROW_APPROVAL_TTL_HOURS;
}

export interface EscrowApprovalState {
    /** Approvals that still count: one per holder, only from users who are holders of the scope right now. */
    validApprovalCount: number;
    /** `true` when `validApprovalCount` reaches the request's `requiredHoldersAtCreation`. */
    thresholdMet: boolean;
    /** When the approval that met the threshold was given - `undefined` while `thresholdMet` is `false`. */
    thresholdMetAt?: Date;
    /** `thresholdMetAt` plus the approval TTL. */
    expiresAt?: Date;
    /** `true` once `expiresAt` has passed. */
    expired: boolean;
}

/**
 * Evaluates `request`'s approvals against `scope` as it is NOW, not as it was when they were given: an approval
 * from a user who has since been removed from `scope.holderUserUids` no longer counts, and a met threshold only
 * authorizes access for `ttlHours` from the moment it was met. `requiredHoldersAtCreation` stays the bar (see
 * `EscrowAccessRequest`'s doc comment), so lowering a scope's `requiredHolders` never loosens a request.
 */
export function evaluateEscrowApprovals(
    request: EscrowAccessRequest,
    scope: EscrowScope,
    ttlHours: number,
    now: Date = new Date(),
): EscrowApprovalState {
    const holders: Set<string> = new Set(scope.holderUserUids ?? []);
    const seen: Set<string> = new Set();
    const valid: Date[] = [];
    for (const approval of request.approvals ?? []) {
        if (holders.has(approval.holderUserUid) && !seen.has(approval.holderUserUid)) {
            seen.add(approval.holderUserUid);
            valid.push(new Date(approval.approvedAt));
        }
    }
    valid.sort((a, b) => a.getTime() - b.getTime());
    const required: number = Math.max(1, request.requiredHoldersAtCreation);
    if (valid.length < required) {
        return { validApprovalCount: valid.length, thresholdMet: false, expired: false };
    }
    const thresholdMetAt: Date = valid[required - 1];
    const expiresAt: Date = new Date(thresholdMetAt.getTime() + ttlHours * 60 * 60 * 1000);
    return { validApprovalCount: valid.length, thresholdMet: true, thresholdMetAt, expiresAt, expired: now.getTime() > expiresAt.getTime() };
}
