///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, UserUtils, type JWTUser } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, type ACLUtils } from "@rapidrest/service-core";

/**
 * THE authorization helper for anything scoped to a mailbox (the mailbox itself, its folders, messages, contacts,
 * events, tasks, notes, labels, rules, signatures, keys, sharing, search, imports/exports, the live push channels, ...).
 *
 * **Policy: no role - trusted/admin included - grants implicit access to another user's personal mail data.** A caller
 * may touch a mailbox-scoped record only when they own the mailbox or hold an explicit `AccessControlList` grant on it
 * (a delegate/shared record, with the right action). A trusted role, an elevated token and `ignoreACL` never widen
 * that. An administrator sees their own mailbox and the mailboxes shared with them - to see anyone else's they
 * impersonate that user (which yields that user's own, unprivileged token).
 *
 * **Why this exists.** `@rapidrest/service-core`'s `ACLUtils.hasPermission()` (and `RepoUtils`, `BaseACLRoute`,
 * `BasePushRoute`, which all call it) answers `true` for any caller holding a trusted role - "trusted users always
 * have permission". That is the right behaviour for administering the platform and the wrong one for a person's mail.
 * The framework cannot be changed from here, so mailbox-scoped code must never hand it the caller as-is: it asks
 * `hasMailAccess()` (or hands `RepoUtils`/`super` calls a `stripTrustedRoles()` copy of the user), which take the
 * trusted roles away first. What is left is exactly the owner/delegate resolution every ordinary user gets - a
 * mailbox's ACL carries the owner's `FULL` record (`BaseMailboxRoute` writes it on create and on every owner change) and
 * a delegate's records, and a folder's ACL inherits from its mailbox's (`parentUid`).
 *
 * Nothing here depends on impersonation: an impersonation token is simply the target user's own identity (uid = the
 * target, that user's own roles, not elevated), so it passes these checks exactly as the target does.
 *
 * `test/routes/mailAccessMatrixSuite.ts` exercises every mailbox-scoped endpoint class through owner, delegates,
 * strangers, a trusted+elevated admin and an impersonation-style token, and `test/routes/mailAccessGuard.test.ts`
 * fails when a route class or a direct `aclUtils.hasPermission()` call is not accounted for.
 */

/** The `?scope=` value the administration-only variants of the mailbox routes answer to. */
export const ADMIN_SCOPE = "admin";

/** Whether `role` is one of `trustedRoles` - as itself or org-prefixed (`<orgUid>.<role>`, the form
 * `UserUtils.hasRole()` also accepts, where the org uid is the uid of the ACL being checked). */
function isTrustedRole(role: string, trustedRoles: readonly string[]): boolean {
    return trustedRoles.some((trusted) => role === trusted || role.endsWith(`.${trusted}`));
}

/** Whether `user` carries a trusted role (the same test the framework applies). */
export function isTrustedUser(user: JWTUser | undefined, trustedRoles: readonly string[]): boolean {
    return !!user && UserUtils.hasRoles(user, trustedRoles as string[]);
}

/**
 * `user` without its trusted roles (and without its elevation), for handing to code that would otherwise treat the
 * caller as a superuser: `ACLUtils.hasPermission()`, `RepoUtils` with `{ user }` and no `ignoreACL`,
 * `CRUDRoute`'s inherited handlers. Everything else about the identity - uid, other roles, scopes - is unchanged, so
 * owner and delegate records still match. Returns `user` itself when it has nothing to strip.
 */
export function stripTrustedRoles(user: JWTUser | undefined, trustedRoles: readonly string[]): JWTUser | undefined {
    if (!user || !Array.isArray(user.roles) || !user.roles.some((role) => isTrustedRole(role, trustedRoles))) {
        return user;
    }
    return { ...user, roles: user.roles.filter((role) => !isTrustedRole(role, trustedRoles)), elevated: -1 };
}

/**
 * Whether `user` holds `action` on the mailbox-scoped `uid` - a mailbox uid, a folder uid, or any other uid whose
 * `AccessControlList` inherits from a mailbox's - by ownership or an explicit ACL record, never by a trusted role.
 * `false` for an unknown uid (deny by default). `acl` may also be an already loaded `AccessControlList`.
 */
export async function hasMailAccess(
    aclUtils: ACLUtils | undefined,
    trustedRoles: readonly string[],
    user: JWTUser | undefined,
    uid: Parameters<ACLUtils["hasPermission"]>[1],
    action: string,
): Promise<boolean> {
    return !!aclUtils && (await aclUtils.hasPermission(stripTrustedRoles(user, trustedRoles), uid, action));
}

/** `hasMailAccess()`, refusing (403) when it is `false`. */
export async function assertMailAccess(
    aclUtils: ACLUtils | undefined,
    trustedRoles: readonly string[],
    user: JWTUser | undefined,
    uid: Parameters<ACLUtils["hasPermission"]>[1],
    action: string,
): Promise<void> {
    if (!(await hasMailAccess(aclUtils, trustedRoles, user, uid, action))) {
        throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
    }
}

/** Whether `query`'s `scope` is the administration scope (`?scope=admin`). */
export function isAdminScope(query: any): boolean {
    return query?.scope === ADMIN_SCOPE;
}

/**
 * Requires the caller for an administration-scope (`?scope=admin`) request: a trusted role (403 `api-103` without) AND
 * an elevated token (403 `api-104` without). An administration scope shows administrative metadata and runs
 * management actions - it is not a way into anyone's mail, and every use of it is audited by the route that offers it.
 */
export function assertAdminScope(user: JWTUser | undefined, trustedRoles: readonly string[]): void {
    if (!user) {
        throw new ApiError(ApiErrors.AUTH_REQUIRED, 401, ApiErrorMessages.AUTH_REQUIRED);
    }
    if (!isTrustedUser(user, trustedRoles)) {
        throw new ApiError(ApiErrors.AUTH_REQUIRES_TRUSTED_ROLE, 403, ApiErrorMessages.AUTH_REQUIRES_TRUSTED_ROLE);
    }
    if (!(typeof user.elevated === "number" && user.elevated > 0)) {
        throw new ApiError(ApiErrors.AUTH_REQUIRES_ELEVATION, 403, ApiErrorMessages.AUTH_REQUIRES_ELEVATION);
    }
}
